# PitchList — Claude Code Context

**Read this before touching the code.** It's the fast on-ramp to the parts of the codebase that are non-obvious. Claude Code loads this automatically.

> **Future Claude: keep this file updated.** After any change that alters the architecture, adds a non-obvious gotcha, changes how something is built/run, or fixes a subtle bug that a future reader would waste time rediscovering — update the relevant section here. Do not log every trivial change; treat this as a living map of the *non-obvious*, not a changelog.

---

## What it is

Browser-based worship setlist player. Load audio files → per-song pitch shift (semitones) and tempo change (%) in real time via a phase-vocoder AudioWorklet → auto-advance through the setlist. PWA — installable, offline-capable, background audio, key detection, MP3 export.

## Stack

Vite 8 + React 19 + TypeScript. Almost the entire app lives in one file: `src/App.tsx` (~1600 lines, deliberately monolithic). Deployed to Vercel.

## Run

```
npm install
npm run dev        # local dev server (http://localhost:5173)
npm run build      # tsc -b && vite build → dist/
npm run preview    # serve dist/ (needed to test service worker / PWA install)
```

You cannot open `index.html` from the filesystem — it's a Vite app; without the dev server the browser can't resolve TypeScript, bare imports, or absolute paths, and service workers don't run under `file://`.

## File map

- `src/App.tsx` — the entire UI + all playback/persistence logic. One giant component.
- `src/main.tsx` — React bootstrap. Rarely touched.
- `public/pv-processor.js` — AudioWorklet: phase-vocoder time-stretch + resample pitch shift. Communicates with the main thread only via its MessagePort (see gotcha below).
- `public/key-worker.js` — Web Worker: HPCP + Krumhansl-Schmuckler + Temperley key detection.
- `public/sw.js` — service worker: network-first with cache fallback + Web Share Target (Android) for receiving audio files from other apps.
- `public/manifest.json` — PWA manifest.
- `vercel.json` — deploy config.

## Non-obvious gotchas

These are the things that will burn you if you don't know them.

### 1. Worklet pitch/tempo go through the port, NOT AudioParams
`pv-processor.js` has NO `parameterDescriptors`. Pitch and tempo are internal state (`_pitch`, `_tempo`) set via port messages: `load`, `seek`, `setParams`. The old code used AudioParams and lost a race — the load message and the AudioParam update travel on separate channels, so `process()` could start with `pitch=0` and snap to the target value a few blocks later. Most audible when auto-advancing between songs with different pitch values. **If you add another param, keep it on the same port.**

### 2. Single-song-end zombie worklet
When a song ends, `pv-processor.js` returns `false` from `process()`, which terminates the node. If it was the last song, `advance()` MUST call `stopSource()` + null `workletNodeRef` / `loadedSongIdRef`, otherwise the next Play takes the `canSeek` fast-path and sends a `seek` message to a dead node → silence until the user reloads the PWA. Handled in the end-of-setlist branch of `advance()` inside `playFrom`.

### 3. iOS background audio bridge
iOS suspends Web Audio in the background. Two things keep it alive:
- **Silent WAV keepalive** looped through an `<audio>` element (`_keepAlive` at module scope). `unlockAudio()` (called on every user gesture) creates it and re-plays it after visibility changes.
- **MediaStreamDestinationNode → HTMLAudioElement** — the worklet output is routed through a MediaStream into a real `<audio>` element (`audioOutRef`) so iOS treats the app as a media player. Direct `ctx.destination` is only a fallback if that bridge fails.
- Also sets `navigator.audioSession.category = 'playback'` on Safari 17+.

Touch this stuff carefully — background audio on iOS is fragile.

### 4. Prev-button restart-if-past-5s
Spotify/Apple-Music behavior: `handlePrev` (and the Media Session `previoustrack` handler) restart the current song if `currentElapsed() > 5`; otherwise step back one song. Prev is intentionally enabled at index 0 so it can restart.

### 5. Key detection tuning (E/B confusion)
`scoreChroma` (duplicated in `src/App.tsx` and `public/key-worker.js` — keep them in sync) has three tuned knobs specifically to fight the classic V→I misdetection (song in E getting detected as B, because every root's 3rd harmonic is a perfect fifth up and V chords get played a lot):

1. **Chroma smoothing = `0.08/0.84/0.08`** (was `0.2/0.6/0.2`). Tight smoothing preserves the A-vs-A# distinction, which is the ONLY note separating E major from B major.
2. **Bass bins get 3× weight** in the HPCP accumulation. The bass instrument plays chord roots, so amplifying it makes the tonic dominate its dominant/subdominant.
3. **Fifth-error correction, tolerance 0.08**: if a same-mode candidate a perfect fifth BELOW the winner scored within 0.08 correlation, prefer the lower one. If you loosen this too far you'll start miscalling genuinely-B songs as E.

If a specific song is misdetected, first check what the detector actually returns (tap the key badge to re-run); if it's off by a fifth up, the correction tolerance is probably the right dial to touch, not the smoothing/bass weights.

### 6. IndexedDB schema
`worship-setlist` DB, `songs` store, keyPath `id`, version 4. Legacy `buffers` store gets deleted on upgrade. Audio is persisted as raw `arrayBuffer` (re-decoded on load, not as an `AudioBuffer` object). If you change the schema, bump `DB_VER` and add migration.

### 7. Worklet load message transfers ArrayBuffers
`node.port.postMessage({t:'load', ch, ...}, ch.map(f => f.buffer))` — the second arg transfers ownership of the channel Float32Array buffers to the worklet. After this call, `ch` is unusable on the main thread. Don't touch it.

### 8. Web Share Target flow (Android)
`sw.js` intercepts POST to `/share-target`, stores blobs in a `pitchlist-share` Cache with headers carrying original filename, posts `SHARE_RECEIVED` to open clients, then redirects to `/?shared=1`. The app checks for the `shared=1` query param on mount AND listens for the message.

### 9. Themes + song order in localStorage
`ws-theme` and `ws-order` keys. Don't persist anything else in localStorage — songs go in IndexedDB.

## Coding conventions

- One-file monolith is intentional. Don't split `App.tsx` into modules without a strong reason.
- Terse variable names (`ctx`, `ab`, `bs`, `pf`, `tf`, `hs`) are consistent throughout, especially in audio code — match the surrounding style.
- Comments explain WHY (usually citing the bug or constraint), not WHAT.
- Refs (`songsRef`, `activeIdxRef`, etc.) mirror state so long-lived event handlers (media session, worklet callbacks) get fresh values without dep arrays. Keep this pattern if you add new long-lived handlers.

## Deployment notes

- Vercel from `main`. `vercel.json` handles SPA rewrites.
- Service worker cache is versioned (`pitchlist-v1`). Bump the version string in `sw.js` only if you need to force-invalidate cached assets. The current fetch handler is network-first, so most updates propagate without a bump.

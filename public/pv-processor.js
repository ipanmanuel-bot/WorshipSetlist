/* ─── Real-time Phase-Vocoder AudioWorklet ────────────────────────────────────
   Same algorithm as the offline pvStretchAsync, now streaming 128 samples/call.
   Pitch and tempo are AudioParams → changes apply within the next audio chunk.
   ─────────────────────────────────────────────────────────────────────────── */

'use strict';

const N = 1024, HA = 256, HALF = N >> 1;
const TP = 2 * Math.PI;

/* Hann window (pre-computed once at module load) */
const W = new Float32Array(N);
for (let i = 0; i < N; i++) W[i] = 0.5 * (1 - Math.cos(TP * i / (N - 1)));

/* In-place Cooley-Tukey radix-2 FFT */
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let b = n >> 1;
    for (; j & b; b >>= 1) j ^= b;
    j ^= b;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 1 : -1) * TP / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let ur = 1, ui = 0;
      for (let j = 0; j < len >> 1; j++) {
        const k = i + j + (len >> 1);
        const ar = re[i+j], ai = im[i+j];
        const br = re[k]*ur - im[k]*ui;
        const bi = re[k]*ui + im[k]*ur;
        re[i+j] = ar+br; im[i+j] = ai+bi;
        re[k] = ar-br;   im[k] = ai-bi;
        const t = ur*wr - ui*wi;
        ui = ur*wi + ui*wr; ur = t;
      }
    }
  }
  if (inv) { const s = 1 / n; for (let i = 0; i < n; i++) { re[i] *= s; im[i] *= s; } }
}

/*
 * Ring buffer layout (power-of-2 for fast modulo via bitwise AND)
 * 2^19 = 524 288 samples ≈ 11.9 s @ 44.1 kHz — ample for any stretch factor.
 */
const RBITS = 19;
const RSIZE = 1 << RBITS;
const RMASK = RSIZE - 1;

class PVProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      /* pitchSemitones: −12..+12 semitones, automatable */
      { name: 'pitch', defaultValue: 0, minValue: -24, maxValue: 24,
        automationRate: 'k-rate' },
      /* tempo: fraction (0.5 = 50%, 1.5 = 150%), automatable */
      { name: 'tempo', defaultValue: 1, minValue: 0.25, maxValue: 4,
        automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    /* Audio data — transferred from main thread on 'load' */
    this._ch  = null;   // Float32Array[] one per channel
    this._nc  = 0;      // number of channels
    this._il  = 0;      // input length (samples)
    this._ip  = 0;      // input read position (int)

    /* Phase-vocoder state per channel */
    this._lp  = null;   // last phase  [nc × N]
    this._sp  = null;   // synth phase [nc × N]

    /* Output ring buffer per channel + shared normalisation window */
    this._rb  = null;   // Float32Array[] [nc × RSIZE]
    this._rw  = null;   // Float32Array   [RSIZE]  (Hann² accumulator)
    this._ow  = 0;      // linear write counter (output frames produced)
    this._or  = 0;      // linear read  counter (output frames consumed)

    /* Reusable FFT scratch buffers (avoids per-frame allocations) */
    this._re  = new Float32Array(N);
    this._im  = new Float32Array(N);
    this._ore = new Float32Array(N);
    this._oim = new Float32Array(N);

    this._on     = false;  // processor is active
    this._ended  = false;  // 'ended' event already sent

    this.port.onmessage = ({ data: d }) => {
      if (d.t === 'load') {
        this._nc = d.ch.length;
        this._il = d.ch[0].length;
        this._ch = d.ch;
        this._ip = d.s | 0;          // start sample (optional seek)
        this._ow = 0;
        this._or = 0;
        this._rb  = Array.from({ length: this._nc }, () => new Float32Array(RSIZE));
        this._rw  = new Float32Array(RSIZE);
        this._lp  = Array.from({ length: this._nc }, () => new Float32Array(N));
        this._sp  = Array.from({ length: this._nc }, () => new Float32Array(N));
        this._on  = true;
        this._ended = false;

      } else if (d.t === 'seek') {
        if (!this._ch) return;
        this._ip = d.s | 0;
        this._ow = 0; this._or = 0;
        this._rb.forEach(r => r.fill(0));
        this._rw.fill(0);
        this._lp.forEach(a => a.fill(0));
        this._sp.forEach(a => a.fill(0));
        this._on = true;
        this._ended = false;

      } else if (d.t === 'stop') {
        this._on = false;
      }
    };
  }

  /* Number of output samples that are fully committed (safe to read) */
  _safe() {
    /* After overlap-add, samples older than (ow - HALF) are no longer
       touched by future frames, so they're safe to drain. */
    return Math.max(0, this._ow - HALF - this._or);
  }

  /* Process one phase-vocoder frame and append to the ring buffer.
   *
   * Pitch shift is achieved by reading the input at HA×pf samples per frame
   * (fractional, with linear interpolation) rather than the fixed HA.  This
   * resamples the input — consuming it faster raises frequencies.  The phase
   * accumulation formulas use the actual analysis hop (HA×pf) so they stay
   * correct.  The synthesis hop hs = HA×pf/tempo controls output duration,
   * giving the desired tempo independently of pitch.
   */
  _frame(hs, haAct) {
    /* Guard: stop if ring is almost full (prevents write from lapping read) */
    if (this._ow - this._or + N >= RSIZE) return;

    for (let c = 0; c < this._nc; c++) {
      const inp = this._ch[c];
      const re = this._re, im = this._im;
      const ore = this._ore, oim = this._oim;
      const lp = this._lp[c], sp = this._sp[c];
      const rb = this._rb[c];

      /* Window + fill FFT input (linear interpolation for fractional ip) */
      re.fill(0); im.fill(0);
      for (let i = 0; i < N; i++) {
        const sf  = this._ip - HALF + i;
        const s0  = sf | 0;
        const frc = sf - s0;
        const v0  = (s0 >= 0 && s0 < this._il) ? inp[s0] : 0;
        const v1  = (s0 + 1 < this._il)         ? inp[s0 + 1] : 0;
        re[i] = (v0 + frc * (v1 - v0)) * W[i];
      }

      fft(re, im, false);

      /* Phase accumulation — use actual analysis hop haAct for both
         the expected-phase-increment term and the unwrapping divisor */
      ore.fill(0); oim.fill(0);
      for (let k = 0; k <= HALF; k++) {
        const mag = Math.sqrt(re[k]*re[k] + im[k]*im[k]);
        const ph  = Math.atan2(im[k], re[k]);
        let   dp  = ph - lp[k] - TP * k * haAct / N;
        dp -= TP * Math.round(dp / TP);
        sp[k] += hs * (TP * k / N + dp / haAct);
        lp[k]  = ph;
        ore[k] = mag * Math.cos(sp[k]);
        oim[k] = mag * Math.sin(sp[k]);
        if (k > 0 && k < HALF) { ore[N-k] = ore[k]; oim[N-k] = -oim[k]; }
      }

      fft(ore, oim, true);

      /* Overlap-add into ring */
      for (let i = 0; i < N; i++) {
        rb[(this._ow - HALF + i + RSIZE * 2) & RMASK] += ore[i] * W[i];
      }
    }

    /* Normalisation window (identical for every channel) */
    const rw = this._rw;
    for (let i = 0; i < N; i++) {
      rw[(this._ow - HALF + i + RSIZE * 2) & RMASK] += W[i] * W[i];
    }

    this._ip += haAct;   // fractional advance — raises pitch when haAct > HA
    this._ow += hs;
  }

  process(_inputs, outputs, parameters) {
    if (!this._on) return true;

    const out = outputs[0];
    const bs  = out[0]?.length ?? 128;

    const pitch = parameters.pitch[0] ?? 0;
    const tempo = parameters.tempo[0] ?? 1;
    const pf    = Math.pow(2, pitch / 12);

    /* haAct: actual analysis hop — consuming input faster raises pitch.
       hs:    synthesis hop — controls output length, setting tempo.
       Net:   output_duration = input_duration / tempo  (independent of pf) */
    const haAct = HA * pf;
    const hs    = Math.max(1, Math.round(haAct / tempo));

    /* Fill ring ahead by TARGET samples (≈ 8 audio blocks) */
    const TARGET = bs * 8;
    while (this._safe() < TARGET && this._ip < this._il + HALF) {
      this._frame(hs, haAct);
    }

    /* Drain ring into output */
    const avail = this._safe();
    const read  = Math.min(avail, bs);

    for (let c = 0; c < out.length; c++) {
      const rb = this._rb[Math.min(c, this._nc - 1)];
      const o  = out[c];
      for (let i = 0; i < read; i++) {
        const pos = (this._or + i) & RMASK;
        const w   = this._rw[pos];
        o[i] = w > 1e-8 ? rb[pos] / w : 0;
        rb[pos] = 0;
      }
      for (let i = read; i < bs; i++) o[i] = 0;
    }

    /* Clear normalisation window once (after all channels read) */
    const rw = this._rw;
    for (let i = 0; i < read; i++) rw[(this._or + i) & RMASK] = 0;
    this._or += read;

    /* Signal end-of-audio */
    if (this._ip >= this._il + HALF && avail === 0) {
      if (!this._ended) {
        this._ended = true;
        this.port.postMessage({ t: 'ended' });
      }
      return false;
    }

    return true;
  }
}

registerProcessor('pv-proc', PVProcessor);

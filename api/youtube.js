import { Innertube, UniversalCache } from 'youtubei.js';
import { BG } from 'bgutils-js';
import { JSDOM } from 'jsdom';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  const videoId = req.query.v;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).send('Invalid video ID');
  }

  try {
    /* ── 1. Bare session just to get visitor_data ── */
    const yt0 = await Innertube.create({ retrieve_player: false });
    const visitorData = yt0.session.context.client.visitorData;
    if (!visitorData) throw new Error('Could not obtain visitor data');

    /* ── 2. jsdom as the BotGuard runtime environment ──
       runScripts:'dangerously' lets injected <script> tags actually execute,
       which is how we run Google's BotGuard interpreter in the right context. */
    const dom = new JSDOM('<!DOCTYPE html>', {
      url: 'https://www.youtube.com/',
      runScripts: 'dangerously',
    });

    const requestKey = 'O43z0dpjhgX20SCx4KAo';
    const bgConfig = {
      fetch:      (input, init) => fetch(input, init),
      globalObj:  dom.window,   // ← must match where the script sets the VM
      identifier: visitorData,
      requestKey,
    };

    /* ── 3. Fetch BotGuard challenge ── */
    const challenge = await BG.Challenge.create(bgConfig);
    if (!challenge) throw new Error('BotGuard challenge creation failed');

    /* ── 4. Run interpreter inside jsdom so globalObj[globalName] is set ── */
    const interpreterJs =
      challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
    if (!interpreterJs) throw new Error('No interpreter script in challenge');

    const scriptEl = dom.window.document.createElement('script');
    scriptEl.textContent = interpreterJs;
    dom.window.document.head.appendChild(scriptEl);

    /* ── 5. Generate po_token ── */
    const { poToken } = await BG.PoToken.generate({
      program:    challenge.program,
      globalName: challenge.globalName,
      bgConfig,
    });
    if (!poToken) throw new Error('po_token generation returned empty');

    /* ── 6. Authenticated Innertube session ── */
    const yt = await Innertube.create({
      visitor_data: visitorData,
      po_token:     poToken,
      cache:        new UniversalCache(false),
    });

    /* ── 7. Get title and audio stream ── */
    const info  = await yt.getBasicInfo(videoId);
    const title = info.basic_info?.title || 'YouTube Song';

    const stream = await yt.download(videoId, {
      type:    'audio',
      quality: 'best',
      format:  'any',
    });

    const chunks = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    const buffer = Buffer.concat(chunks);

    res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('X-Video-Title', encodeURIComponent(title));
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(buffer);

  } catch (err) {
    console.error('[/api/youtube]', err?.message, err?.stack?.split('\n')[1]);
    return res.status(502).send(err?.message || 'Could not retrieve audio');
  }
}

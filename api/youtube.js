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
    /* ── Step 1: bare Innertube session to get visitor_data ── */
    const yt0 = await Innertube.create({ retrieve_player: false });
    const visitorData = yt0.session.context.client.visitorData;
    if (!visitorData) throw new Error('No visitor data');

    /* ── Step 2: jsdom environment for BotGuard VM ── */
    const dom = new JSDOM('', { url: 'https://www.youtube.com/' });
    globalThis.window   = dom.window;
    globalThis.document = dom.window.document;

    /* ── Step 3: generate po_token ── */
    const requestKey = 'O43z0dpjhgX20SCx4KAo';
    const bgConfig = {
      fetch:      (input, init) => fetch(input, init),
      globalObj:  globalThis,
      identifier: visitorData,
      requestKey,
    };

    const challenge = await BG.Challenge.create(bgConfig);
    if (!challenge) throw new Error('BotGuard challenge failed');

    const interpreterJs =
      challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
    if (interpreterJs) new Function(interpreterJs)(); // run the BG VM

    const { poToken } = await BG.PoToken.generate({
      program:    challenge.program,
      globalName: challenge.globalName,
      bgConfig,
    });

    /* ── Step 4: authenticated Innertube ── */
    const yt = await Innertube.create({
      visitor_data:             visitorData,
      po_token:                 poToken,
      cache:                    new UniversalCache(false),
      generate_session_locally: true,
    });

    /* ── Step 5: get title ── */
    const info  = await yt.getBasicInfo(videoId);
    const title = info.basic_info?.title || 'YouTube Song';

    /* ── Step 6: stream audio ── */
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
    console.error('[/api/youtube]', err);
    return res.status(502).send(err.message || 'Could not retrieve audio');
  }
}

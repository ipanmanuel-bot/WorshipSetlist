import { Innertube, UniversalCache } from 'youtubei.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

async function streamToBuffer(stream) {
  const chunks = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  const videoId = req.query.v;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).send('Invalid video ID');
  }

  const tokensJson = process.env.YOUTUBE_TOKENS;
  const cookieStr  = process.env.YOUTUBE_COOKIES;

  if (!tokensJson && !cookieStr) {
    return res.status(503).send(
      'YouTube auth not configured. Run: node scripts/youtube-auth.mjs'
    );
  }

  try {
    let yt;

    if (tokensJson) {
      /* ── OAuth (preferred) ── */
      const tokens = JSON.parse(tokensJson);
      yt = await Innertube.create({ cache: new UniversalCache(false) });
      await yt.session.signIn(tokens); // auto-refreshes access_token if expired
    } else {
      /* ── Cookie fallback ── */
      yt = await Innertube.create({
        cookie: cookieStr,
        cache:  new UniversalCache(false),
      });
    }

    const info   = await yt.getBasicInfo(videoId);
    const title  = info.basic_info?.title || 'YouTube Song';
    const stream = await yt.download(videoId, {
      type:    'audio',
      quality: 'best',
      format:  'any',
    });

    const buffer = await streamToBuffer(stream);

    res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('X-Video-Title', encodeURIComponent(title));
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(buffer);

  } catch (err) {
    console.error('[/api/youtube]', err?.message);
    return res.status(502).send(err?.message || 'Could not retrieve audio');
  }
}

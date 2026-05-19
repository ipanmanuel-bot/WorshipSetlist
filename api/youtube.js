import { Innertube, UniversalCache } from 'youtubei.js';
import { BG } from 'bgutils-js';
import { JSDOM } from 'jsdom';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

async function streamBuffer(stream) {
  const chunks = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/* ── Cookie-based auth (most reliable) ── */
async function withCookie(videoId) {
  const yt = await Innertube.create({
    cookie: process.env.YOUTUBE_COOKIES,
    cache:  new UniversalCache(false),
  });
  const info   = await yt.getBasicInfo(videoId);
  const title  = info.basic_info?.title || 'YouTube Song';
  const stream = await yt.download(videoId, { type: 'audio', quality: 'best', format: 'any' });
  return { title, buffer: await streamBuffer(stream) };
}

/* ── po_token auth (fallback) ── */
async function withPoToken(videoId) {
  const yt0         = await Innertube.create({ retrieve_player: false });
  const visitorData = yt0.session.context.client.visitorData;
  if (!visitorData) throw new Error('Could not obtain visitor data');

  const dom = new JSDOM('<!DOCTYPE html>', {
    url:        'https://www.youtube.com/',
    runScripts: 'dangerously',
  });

  const bgConfig = {
    fetch:      (input, init) => fetch(input, init),
    globalObj:  dom.window,
    identifier: visitorData,
    requestKey: 'O43z0dpjhgX20SCx4KAo',
  };

  const challenge = await BG.Challenge.create(bgConfig);
  if (!challenge) throw new Error('BotGuard challenge failed');

  const interpreterJs =
    challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!interpreterJs) throw new Error('No BotGuard interpreter script');

  const script = dom.window.document.createElement('script');
  script.textContent = interpreterJs;
  dom.window.document.head.appendChild(script);

  const { poToken } = await BG.PoToken.generate({
    program:    challenge.program,
    globalName: challenge.globalName,
    bgConfig,
  });
  if (!poToken) throw new Error('po_token generation returned empty');

  const yt = await Innertube.create({
    visitor_data: visitorData,
    po_token:     poToken,
    cache:        new UniversalCache(false),
  });

  const info   = await yt.getBasicInfo(videoId);
  const title  = info.basic_info?.title || 'YouTube Song';
  const stream = await yt.download(videoId, { type: 'audio', quality: 'best', format: 'any' });
  return { title, buffer: await streamBuffer(stream) };
}

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  const videoId = req.query.v;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).send('Invalid video ID');
  }

  try {
    const { title, buffer } = process.env.YOUTUBE_COOKIES
      ? await withCookie(videoId)
      : await withPoToken(videoId);

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

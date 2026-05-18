/**
 * Vercel Edge Function — YouTube audio proxy
 * Calls Piped (open-source YouTube frontend) server-side,
 * then streams the audio back to the browser.
 */
export const config = { runtime: 'edge' };

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.yt',
  'https://piped-api.garudalinux.org',
  'https://api.piped.privacydev.net',
  'https://piped.smnz.de/api',
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  const { searchParams } = new URL(request.url);
  const videoId = searchParams.get('v');

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return new Response('Invalid video ID', { status: 400, headers: CORS });
  }

  for (const instance of PIPED_INSTANCES) {
    try {
      /* 1. Get stream info from Piped */
      const infoRes = await fetch(`${instance}/streams/${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!infoRes.ok) continue;

      const info = await infoRes.json();
      if (!info.audioStreams?.length) continue;

      /* 2. Pick highest bitrate audio stream */
      const stream = [...info.audioStreams].sort((a, b) => b.bitrate - a.bitrate)[0];
      if (!stream?.url) continue;

      /* 3. Fetch the audio (server-side — no CORS restriction) */
      const audioRes = await fetch(stream.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://www.youtube.com/',
        },
      });
      if (!audioRes.ok) continue;

      const title = info.title || 'YouTube Song';

      /* 4. Stream audio back to the browser */
      return new Response(audioRes.body, {
        headers: {
          ...CORS,
          'Content-Type': stream.mimeType || 'audio/webm',
          'X-Video-Title': encodeURIComponent(title),
          'Cache-Control': 'public, max-age=3600',
        },
      });
    } catch { continue; }
  }

  return new Response('Could not retrieve audio — all sources failed', {
    status: 502,
    headers: CORS,
  });
}

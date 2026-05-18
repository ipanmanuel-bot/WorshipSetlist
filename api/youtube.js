import { Innertube, UniversalCache } from 'youtubei.js';

// Try multiple YouTube clients — some work better on datacenter IPs
const CLIENTS = ['TVHTML5', 'IOS', 'WEB'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const videoId = req.query.v;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).send('Invalid video ID');
  }

  for (const client of CLIENTS) {
    try {
      const yt = await Innertube.create({
        cache: new UniversalCache(false),
        generate_session_locally: true,
      });

      const info = await yt.getInfo(videoId, client);
      const title = info.basic_info?.title || 'YouTube Song';

      const stream = await yt.download(videoId, {
        type: 'audio',
        quality: 'best',
        client,
      });

      // Collect stream into buffer
      const chunks = [];
      const reader = stream.getReader();
      while (true) {
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

    } catch (e) {
      console.warn(`[youtube] client ${client} failed:`, e.message);
      continue;
    }
  }

  return res.status(502).send('Could not retrieve audio — try again later');
}

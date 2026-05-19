/**
 * Run this ONCE locally to get your YouTube OAuth tokens:
 *   node scripts/youtube-auth.mjs
 *
 * Then copy the YOUTUBE_TOKENS value it prints into Vercel:
 *   Project → Settings → Environment Variables → YOUTUBE_TOKENS
 */

import { Innertube, UniversalCache } from 'youtubei.js';

const yt = await Innertube.create({ cache: new UniversalCache(false) });

yt.session.on('auth-pending', (data) => {
  console.log('\n━━━ YouTube Authentication ━━━');
  console.log(`1. Open this URL: ${data.verification_url}`);
  console.log(`2. Enter this code: ${data.user_code}`);
  console.log('\nWaiting… (do step 1 and 2 in your browser)\n');
});

yt.session.on('auth', ({ credentials }) => {
  const json = JSON.stringify(credentials);
  console.log('\n✓ Authenticated!\n');
  console.log('Go to: Vercel → your project → Settings → Environment Variables');
  console.log('Add a new variable:');
  console.log('  Name:  YOUTUBE_TOKENS');
  console.log('  Value: (copy the line below, starting with {)\n');
  console.log(json);
  console.log('\nThen redeploy. Done!\n');
  process.exit(0);
});

yt.session.on('auth-error', (err) => {
  console.error('Auth failed:', err.message);
  process.exit(1);
});

await yt.session.signIn();

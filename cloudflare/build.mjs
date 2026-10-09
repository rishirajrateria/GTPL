// Cloudflare Pages build step: copies the public page into ./public with Cloudflare's header and
// routing files. Only these files are served by the website; data/, server/, deploy/ and the rest are
// not. (That says nothing about the GitHub repository itself: keep it private.)
//   Pages settings: Root directory "cloudflare", Build command "node build.mjs", Output directory "public"
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const out = join(here, 'public');
const FILES = ['index.html', 'favicon.svg', 'og-image.jpg', 'robots.txt', 'sitemap.xml'];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of FILES) copyFileSync(join(repo, f), join(out, f));
// A real "not found" page: without one, Pages answers every unknown address with the home page.
copyFileSync(join(here, '404.html'), join(out, '404.html'));

// Only these paths run Functions; everything else is a free static request.
writeFileSync(join(out, '_routes.json'), JSON.stringify({
  version: 1, include: ['/api/*', '/admin', '/admin/*'], exclude: [],
}, null, 2) + '\n');

writeFileSync(join(out, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: SAMEORIGIN
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Strict-Transport-Security: max-age=31536000

/favicon.svg
  Cache-Control: public, max-age=604800

/og-image.jpg
  Cache-Control: public, max-age=604800
`);

console.log(`public/: ${FILES.join(', ')}, 404.html, _routes.json, _headers`);

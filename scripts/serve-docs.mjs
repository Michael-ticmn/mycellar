// Local dev server for docs/ — static files plus an esbuild rebuild-on-save.
//
//   npm run dev              → http://127.0.0.1:8731
//   npm run dev -- --host    → also reachable from a phone on the same wifi
//   npm run dev -- --port 9000
//
// Two things worth knowing before you use it.
//
// 1. THIS TALKS TO THE LIVE DATABASE. docs/config.public.js points at the real
//    Supabase project, so signing in here is your actual account and pouring a
//    bottle here pours it for real. To point somewhere else, copy
//    docs/config.local.example.js to docs/config.local.js (gitignored) — it
//    loads after the public config and overrides it.
//
// 2. Some features need a secure context, which http://127.0.0.1 counts as but
//    http://<lan-ip> does not. Over --host from a phone you will NOT get the
//    camera (scan) or the service worker (offline shell, update banner). Focus
//    styles, dialogs, labels, touch targets and the claim-watch message all
//    work fine. See the note printed at startup.
//
// The rebuild uses the same options as `npm run build:docs`, minification
// included. That's deliberate: a dev build lands on the same committed artifact
// (docs/js/dist/app.bundle.js), and leaving an unminified bundle there would
// quietly change what ships. The sourcemap is emitted either way, so debugging
// still maps back to real source.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const ROOT = join(REPO, 'docs');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? true);
};
const PORT = Number(flag('port', 8731));
const EXPOSE = argv.includes('--host');
const HOST = EXPOSE ? '0.0.0.0' : '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// esbuild watch. Same flags as the build:docs script — keep them in step.
const ctx = await esbuild.context({
  entryPoints: [join(ROOT, 'js/app.js')],
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  outfile: join(ROOT, 'js/dist/app.bundle.js'),
  legalComments: 'none',
  logLevel: 'silent',
  plugins: [{
    name: 'report',
    setup(build) {
      build.onEnd((result) => {
        const when = new Date().toTimeString().slice(0, 8);
        if (result.errors.length) {
          console.error(`\n[${when}] build FAILED`);
          for (const e of result.errors) {
            const loc = e.location ? ` ${e.location.file}:${e.location.line}` : '';
            console.error(`  ${e.text}${loc}`);
          }
          // Don't exit — leave the server up so you can fix and save again.
        } else {
          console.log(`[${when}] bundle rebuilt`);
        }
      });
    },
  }],
});
await ctx.watch();

createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let rel = urlPath === '/' || urlPath.endsWith('/') ? `${urlPath}index.html` : urlPath;

  // Contain the path inside docs/ — this binds to 0.0.0.0 with --host, and a
  // dev server that serves ../../watcher/.env to the local network is not a
  // trade worth making for convenience.
  const full = normalize(join(ROOT, rel));
  if (!full.startsWith(ROOT + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const buf = await readFile(full);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream',
      // Never cache in dev. Without this the service worker and the browser
      // cache conspire to serve you the bundle you had two edits ago, and you
      // debug a file that isn't running.
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`not found: ${rel}`);
  }
}).listen(PORT, HOST, () => {
  const line = (s) => console.log(`  ${s}`);
  console.log('\ncellar27 dev server\n');
  line(`local     http://127.0.0.1:${PORT}`);
  if (EXPOSE) {
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) line(`network   http://${a.address}:${PORT}`);
      }
    }
  } else {
    line(`network   (off — pass --host to reach it from a phone)`);
  }
  console.log('');
  line('This uses the LIVE Supabase project. Real account, real bottles.');
  if (EXPOSE) {
    line('Over the network URL there is no secure context, so the camera and');
    line('the service worker will not work. Everything else does.');
  }
  console.log('\nwatching for changes — Ctrl+C to stop\n');
});

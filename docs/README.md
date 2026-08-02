# cellar27 — frontend

Static HTML/CSS/JS, served straight from `docs/` by GitHub Pages via the
`/docs` source folder option.

**There is a build step**, despite the above. `js/app.js` and its imports are
bundled and minified into `js/dist/app.bundle.js`, which is what `index.html`
actually loads and what Pages serves — editing `js/*.js` alone changes nothing
in production. Rebuild and bump the version after any change under `js/`:

```
npm install          # one-time, from the repo root
npm run build:docs
```

Then bump `version.js`, or PWA users never receive the update — the service
worker keys its cache on that value.

## Local dev

1. **Supabase project** already exists; schema is in `../supabase/migrations/`
   (applied by hand — see the repo-root README).
2. **Configure**: `config.public.js` is committed and ships the live project's URL + anon key. To point at a different project locally, copy `config.local.example.js` → `config.local.js` (gitignored, loads after `config.public.js` so it wins for any keys it defines).
3. **Serve the directory** (`file://` won't work because of ES modules):
   ```
   py -m http.server 8000
   # or: npx http-server -p 8000
   ```
4. Open <http://localhost:8000>, sign in. Email confirmation is off; new sign-ups are off (disabled in Supabase Auth settings).

## Layout

```
docs/
├── index.html              app shell, CSP, login gate, view container
├── version.js              single source of truth for the app + SW version
├── manifest.webmanifest    PWA manifest
├── sw.js                   service worker (HTML network-first, assets cache-first)
├── icon.svg                primary PWA icon
├── icon-maskable.svg       Android maskable variant
├── config.public.js        committed: Supabase URL + anon key
├── config.local.js         (git-ignored) optional override
├── config.local.example.js template
├── css/styles.css          palette + layout
├── vendor/qrcode.min.js    vendored, used by the Share view
├── js/
│   ├── supabase-client.js  client singleton
│   ├── auth.js             email/password sign-in (no sign-up: invite only)
│   ├── bottles.js          CRUD, batch fetch, atomic pour RPC
│   ├── pairing-bus.js      shared request/response transport
│   ├── pairings.js         pairing / flight / drink-now requests
│   ├── planned-flights.js  saved flights + AI enrichment
│   ├── scan.js             camera capture, upload, scan requests
│   ├── share.js            owner-side share links + guest activity
│   ├── guest.js            anonymous guest-side RPCs
│   ├── varietal-windows.js drink-window lookup
│   ├── app.js              hash router, view mounting, all rendering
│   └── dist/app.bundle.js  BUILT — this is what index.html loads
└── views/                  per-route HTML fragments
```

## GH Pages deploy

Repo Settings → Pages → Source: deploy from branch `main`, folder `/docs` → Save.
First deploy takes 1–2 minutes. URL: `https://michael-ticmn.github.io/mycellar/`.

`config.public.js` provides Supabase URL + anon key on the deployed site.
`config.local.js` is gitignored and won't exist on Pages — its 404 is harmless.
It's injected by a script tag created in `app.js` rather than written into
`index.html`, specifically so the page carries no inline handlers and the CSP
can keep `script-src` free of `'unsafe-inline'`.

## Content-Security-Policy

`index.html` carries a CSP in a `<meta>` tag — GitHub Pages can't set response
headers, which also means `frame-ancestors` is unavailable. It's a backstop for
the many `innerHTML` sites that render sommelier narrative and scan output;
escaping is the actual control.

Two things to know before changing it:

- `style-src` needs `'unsafe-inline'` because the views use `style=""`
  attributes throughout. Removing those first is what would let it be dropped.
- Adding any new external origin (a CDN, an image host, an API) means adding it
  to the matching directive, or the browser silently blocks it. Test with
  DevTools open — CSP failures appear only in the console.

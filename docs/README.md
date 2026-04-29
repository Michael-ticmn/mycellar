# cellar27 — frontend

Static HTML/CSS/JS. No build step. Lives in `docs/` so GitHub Pages can serve it directly with the `/docs` source folder option.

## Local dev

1. **Supabase project** already exists; schema applied via `../supabase/migrations/0001_init.sql` and `../supabase/migrations/0002_lockdown.sql`.
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
├── index.html              app shell, login gate, view container
├── manifest.webmanifest    PWA manifest
├── sw.js                   service worker (cache-first app shell)
├── icon.svg                primary PWA icon
├── icon-maskable.svg       Android maskable variant
├── config.public.js        committed: Supabase URL + anon key
├── config.local.js         (git-ignored) optional override
├── config.local.example.js template
├── css/styles.css          palette + layout
├── js/
│   ├── supabase-client.js  client singleton
│   ├── auth.js             email/password sign-in
│   ├── bottles.js          CRUD + tap-to-pour
│   ├── pairings.js         bridge requests + Realtime subscription
│   ├── scan.js             (stub — Phase 3)
│   ├── varietal-windows.js drink-window lookup
│   └── app.js              hash router, view mounting, SW registration
└── views/                  per-route HTML fragments
```

## GH Pages deploy

Repo Settings → Pages → Source: deploy from branch `main`, folder `/docs` → Save.
First deploy takes 1–2 minutes. URL: `https://michael-ticmn.github.io/mycellar/`.

`config.public.js` provides Supabase URL + anon key on the deployed site.
`config.local.js` is gitignored and won't exist on Pages — its 404 is harmless
(the script tag has `onerror="this.remove()"`).

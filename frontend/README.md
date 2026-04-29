# cellar27 — frontend

Static HTML/CSS/JS. No build step. Hosted on GitHub Pages once shipped (deferred until palette is confirmed — see STRATEGY.md constraint).

## Local dev

1. **Create a Supabase project**, apply the migration in `../supabase/migrations/0001_init.sql` via the SQL editor.
2. **Configure**: `config.public.js` is committed and ships the live project's URL + anon key. To override for a different project locally, copy `config.local.example.js` → `config.local.js` and edit. `config.local.js` is git-ignored and loads after `config.public.js`, so it wins where both define keys.
3. **Serve the directory** (any static server works — `file://` won't because of ES modules):
   ```
   py -m http.server 8000
   # or: npx http-server -p 8000
   ```
4. Open <http://localhost:8000>, sign up with email/password (disable "Confirm email" in Supabase auth settings for dev).

## Layout

```
frontend/
├── index.html              app shell, login gate, view container
├── config.local.js         (git-ignored) Supabase URL + anon key
├── config.local.example.js template — copy & fill in
├── css/styles.css          palette + layout
├── js/
│   ├── supabase-client.js  client singleton, reads window.CELLAR_CONFIG
│   ├── auth.js             email/password sign-in, session
│   ├── bottles.js          CRUD on bottles table + tap-to-pour
│   ├── pairings.js         (stub — Phase 2)
│   ├── scan.js             (stub — Phase 3)
│   ├── varietal-windows.js drink-window lookup
│   └── app.js              hash router, view mounting
└── views/                  per-route HTML fragments
```

## GH Pages deploy

Repo Settings → Pages → Source: deploy from branch `main`, folder `/frontend` → Save.
GitHub will publish at `https://<user>.github.io/<repo>/`. First deploy takes a couple of minutes.

`config.public.js` provides the Supabase URL + anon key on the deployed site.
`config.local.js` is gitignored and won't exist on Pages — its 404 is harmless
(the script tag has `onerror="this.remove()"`).

# cellar27 — frontend

Static HTML/CSS/JS. No build step. Hosted on GitHub Pages once shipped (deferred until palette is confirmed — see STRATEGY.md constraint).

## Local dev

1. **Create a Supabase project** (`cellar27`), apply the migration in `../supabase/migrations/0001_init.sql` via the SQL editor.
2. **Configure local credentials**:
   ```
   cp config.local.example.js config.local.js
   ```
   Open `config.local.js` and paste your project's `SUPABASE_URL` and anon key.
   `config.local.js` is git-ignored.
3. **Serve the directory** (any static server works — file:// won't because of ES modules):
   ```
   python -m http.server 8000
   # or: npx http-server -p 8000
   ```
4. Open <http://localhost:8000>, sign up with email/password (Supabase will send a confirmation email unless you've disabled email confirmation in the project's auth settings — for solo dev, disable it).

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

## GH Pages deploy (once palette confirmed)

Repo settings → Pages → deploy from branch `main`, folder `/frontend`.
Note that `config.local.js` is git-ignored, so the deployed page will need
`config.local.js` injected at build time, or `index.html` patched to
read config from a different source. Decide before flipping the toggle.

# mycellar (cellar27)

Personal wine cellar app: catalog, pairings, tasting flights, drink-by tracking. Same architectural pattern as play27/grow27 — static frontend on GitHub Pages, Supabase for auth/data/storage, AI reasoning offloaded to Claude Code on the home-lab VM via a Supabase-Realtime-driven file-drop bridge.

This repo is a monorepo:

| Path | What | Status |
|------|------|--------|
| [`docs/`](docs/) | Static HTML/CSS/JS app, served by GitHub Pages | live |
| [`watcher/`](watcher/) | Node service that bridges Supabase ↔ Claude Code | live |
| [`supabase/migrations/`](supabase/migrations/) | SQL migrations for the Supabase project | 0001–0015 applied · **0016–0018 pending** |
| [`supabase/functions/`](supabase/functions/) | Supabase Edge Functions (Deno) | `guest-label` deployed |

Migrations are applied by hand through the Supabase SQL editor — there is no
migration runner wired up, so **committing one does not apply it**. Three are
committed but not yet run:
[`0016_share_access_hardening.sql`](supabase/migrations/0016_share_access_hardening.sql),
[`0017_search_path_sweep.sql`](supabase/migrations/0017_search_path_sweep.sql),
and [`0018_atomic_pour_and_rls_perf.sql`](supabase/migrations/0018_atomic_pour_and_rls_perf.sql).
They touch unrelated objects, so order within the set doesn't matter.

Note two files share the number `0015` (`0015_guest_message_delete.sql` and
`0015_planned_flight_intent.sql`). They touch unrelated objects so order didn't
matter, and both are already applied — renumbering them now would only break the
match between the folder and what actually ran, which is the sole record of it
(there's no ledger table). They stay as they are. Pick `0019` next.

## Architecture

- [ARCHITECTURE.md](ARCHITECTURE.md) — one-page picture of how a request travels from phone → Supabase → laptop → Claude → back
- [docs-pdf/architecture.pdf](docs-pdf/architecture.pdf) — colored, printable single-page PDF (cellar27 palette + SVG diagram). Source: [docs-pdf/architecture.html](docs-pdf/architecture.html); regenerate with [`docs-pdf/build.sh`](docs-pdf/build.sh).

## Building the frontend bundle

`docs/js/app.js` and its imports are bundled and minified into [`docs/js/dist/app.bundle.js`](docs/js/dist/app.bundle.js) for production. Rebuild after editing any `docs/js/*.js` file:

```
npm install            # one-time, installs esbuild
npm run build:docs     # bundles + minifies into docs/js/dist/
```

Bump [`docs/version.js`](docs/version.js) so the service worker invalidates the old cache. The committed bundle is what GitHub Pages serves — there is no CI build step.

## Deploying Edge Functions

[`supabase/functions/`](supabase/functions/) is not covered by the frontend build or by GitHub Pages — functions deploy separately, and committing one does **not** ship it. Either use the Supabase dashboard (Edge Functions → Deploy a new function → via Editor, paste the file) or the CLI:

```
npx supabase@latest login
npx supabase@latest functions deploy <name> --project-ref <your-project-ref>
```

No install is needed — `npx` fetches the CLI on demand, and Docker is only required for local `supabase start`, not for deploying. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically as reserved secrets, so functions using only those need nothing configured under Edge Function Secrets.

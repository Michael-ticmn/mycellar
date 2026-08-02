# mycellar (cellar27)

Personal wine cellar app: catalog, pairings, tasting flights, drink-by tracking. Same architectural pattern as play27/grow27 — static frontend on GitHub Pages, Supabase for auth/data/storage, AI reasoning offloaded to Claude Code on the home-lab VM via a Supabase-Realtime-driven file-drop bridge.

This repo is a monorepo:

| Path | What | Status |
|------|------|--------|
| [`docs/`](docs/) | Static HTML/CSS/JS app, served by GitHub Pages | live |
| [`watcher/`](watcher/) | Node service that bridges Supabase ↔ Claude Code | live |
| [`supabase/migrations/`](supabase/migrations/) | SQL migrations for the Supabase project | 0001–0015 applied · **0016–0019 pending** |
| [`supabase/functions/`](supabase/functions/) | Supabase Edge Functions (Deno) | `guest-label` deployed |

Migrations are applied by hand through the Supabase SQL editor — there is no
migration runner wired up, so **committing one does not apply it**. Four are
committed but not yet run:
[`0016_share_access_hardening.sql`](supabase/migrations/0016_share_access_hardening.sql),
[`0017_search_path_sweep.sql`](supabase/migrations/0017_search_path_sweep.sql),
[`0018_atomic_pour_and_rls_perf.sql`](supabase/migrations/0018_atomic_pour_and_rls_perf.sql)
and [`0019_guest_label_rate_limit.sql`](supabase/migrations/0019_guest_label_rate_limit.sql).
They touch unrelated objects, so order within the set doesn't matter.

Check what's applied at any time with:

```
node scripts/verify-migrations.mjs
```

Note two files share the number `0015` (`0015_guest_message_delete.sql` and
`0015_planned_flight_intent.sql`). They touch unrelated objects so order didn't
matter, and both are already applied — renumbering them now would only break the
match between the folder and what actually ran, which is the sole record of it
(there's no ledger table). They stay as they are. Pick `0020` next.

## Backups and rollback

**Snapshot the data** before any schema change:

```
node scripts/backup-data.mjs
```

Writes every table as JSON plus the label photos to
`~/cellar27-backups/<timestamp>/` — deliberately outside the repo, since it
holds prices, notes and guest names and this repo is public. Reads
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from `watcher/.env`. Add
`--no-photos` to skip Storage and finish in a couple of seconds.

It's a logical export, not a Postgres backup: your rows, not the schema,
policies, functions or `auth.users`. It's what you want when a change ate data;
it isn't a substitute for Supabase's own backups if the project itself is lost.

**Rolling back has three independent parts.** Do only the ones you need:

| Part | How | Notes |
|---|---|---|
| Frontend | `git checkout main` and push | GitHub Pages serves `main`. Users pick it up on the next service-worker cycle. |
| Watcher | `git checkout main`, then restart it | It runs whatever is on disk, so the checked-out branch decides the behaviour on restart. |
| Database | Run [`supabase/rollback/0016_0019_rollback.sql`](supabase/rollback/0016_0019_rollback.sql) | Git can't undo an applied migration — this is the only way back. |

The rollback SQL restores the database to commit `33e9d96` (v0.13.9). It touches
only functions and policies: **no table is dropped and no row is modified**, so
it's safe to run without restoring data. It also isn't in `supabase/migrations/`
on purpose, so it can never be mistaken for the next migration to apply.

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

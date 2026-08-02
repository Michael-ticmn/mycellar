# mycellar (cellar27)

Personal wine cellar app: catalog, pairings, tasting flights, drink-by tracking. Same architectural pattern as play27/grow27 — static frontend on GitHub Pages, Supabase for auth/data/storage, AI reasoning offloaded to Claude Code on the home-lab VM via a Supabase-Realtime-driven file-drop bridge.

This repo is a monorepo:

| Path | What | Status |
|------|------|--------|
| [`docs/`](docs/) | Static HTML/CSS/JS app, served by GitHub Pages | live |
| [`watcher/`](watcher/) | Node service that bridges Supabase ↔ Claude Code | live |
| [`supabase/migrations/`](supabase/migrations/) | SQL migrations for the Supabase project | 0001–0019 applied |
| [`supabase/functions/`](supabase/functions/) | Supabase Edge Functions (Deno) | `guest-label` deployed |

Migrations are applied by hand through the Supabase SQL editor — there is no
migration runner wired up, so **committing one does not apply it**. There is
also no ledger table, so the only way to know what's live is to ask the
database. Check any time with:

```
node scripts/verify-migrations.mjs
```

That covers what PostgREST exposes — whether a function exists and how it
behaves. It structurally **cannot** see `search_path` settings, CHECK
constraints, RLS `WITH CHECK` clauses, or whether a function is SECURITY DEFINER
or INVOKER, because those live in the system catalogs rather than the REST API.
For those, paste [`supabase/verify/schema-check.sql`](supabase/verify/schema-check.sql)
into the SQL editor; it returns one PASS/FAIL row per item with failures first.

Worth using both. The gap between them is not academic: whether `0006` and
`0007` had ever been applied sat unanswered for three months precisely because
the Node verifier couldn't tell and re-running the files blind wouldn't have
answered it either. One run of the SQL check settled it (both applied).

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

## Running it locally

```
npm run dev                  # http://127.0.0.1:8731, rebuilds the bundle on save
npm run dev -- --host        # also reachable from a phone on the same wifi
npm run dev -- --port 9000
```

Two things to know:

**It uses the live database.** [`docs/config.public.js`](docs/config.public.js) points at the real Supabase project, so signing in locally is your actual account and pouring a bottle here pours it for real. To aim somewhere else, copy [`docs/config.local.example.js`](docs/config.local.example.js) to `docs/config.local.js` (gitignored) — it loads after the public config and overrides it.

**`--host` loses the secure context.** `http://127.0.0.1` counts as one; `http://<lan-ip>` does not. From a phone over `--host` you will not get the camera (so no scanning) or the service worker (so no offline shell and no update banner). Everything else — layout, dialogs, focus styles, touch targets, the sommelier round-trip — works normally. Testing those two features on a phone means deploying, since GitHub Pages serves over HTTPS.

Dev builds are minified exactly like production, deliberately: the rebuild writes to the same committed artifact, and leaving an unminified bundle there would change what ships. Sourcemaps are emitted either way.

**Stop the dev server before switching branches.** It watches `docs/js/` and writes to `docs/js/dist/app.bundle.js`, which is committed. A `git checkout` changes the source under it, the watcher rebuilds, and the resulting local modification blocks the checkout or the next merge — this happened on the very first use, aborting a merge with *"Please commit your changes or stash them"* over `app.bundle.js.map`. `Ctrl+C` first, or `git checkout -- docs/js/dist/` after.

## Deploying Edge Functions

[`supabase/functions/`](supabase/functions/) is not covered by the frontend build or by GitHub Pages — functions deploy separately, and committing one does **not** ship it. Either use the Supabase dashboard (Edge Functions → Deploy a new function → via Editor, paste the file) or the CLI:

```
npx supabase@latest login
npx supabase@latest functions deploy <name> --project-ref <your-project-ref>
```

No install is needed — `npx` fetches the CLI on demand, and Docker is only required for local `supabase start`, not for deploying. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically as reserved secrets, so functions using only those need nothing configured under Edge Function Secrets.

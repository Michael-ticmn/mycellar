# mycellar (cellar27)

Personal wine cellar app: catalog, pairings, tasting flights, drink-by tracking. Same architectural pattern as play27/grow27 — static frontend on GitHub Pages, Supabase for auth/data/storage, AI reasoning offloaded to Claude Code on the home-lab VM via a Supabase-Realtime-driven file-drop bridge.

This repo is a monorepo:

| Path | What | Status |
|------|------|--------|
| [`frontend/`](frontend/) | Static HTML/CSS/JS app, future GH Pages source | Phase 1 scaffold |
| [`watcher/`](watcher/) | Node service on the win11 VM that bridges Supabase ↔ Claude Code | Phase 2 (not started) |
| [`supabase/migrations/`](supabase/migrations/) | SQL migrations for the Supabase project | 0001_init ready |

## Planning docs

- [STRATEGY.md](STRATEGY.md) — direction, decisions, constraints
- [BUILD_SPEC.md](BUILD_SPEC.md) — technical plan; what to build, in what order
- [BUILD_LOG.md](BUILD_LOG.md) — append-only log of work sessions and decisions
- [CURRENT_STATE.md](CURRENT_STATE.md) — snapshot of where things stand
- [HANDOFF_QUEUE.md](HANDOFF_QUEUE.md) — pending tasks between Chat / Code / owner

## Where to start

If you're picking this up: read STRATEGY.md, then BUILD_SPEC.md, then check CURRENT_STATE.md for what's queued next. The handoff pattern is: Chat decides → Code executes → BUILD_LOG entry → CURRENT_STATE flips.

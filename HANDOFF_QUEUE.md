# cellar27 — HANDOFF_QUEUE.md

## Pending

- [ ] [FROM: Code → owner] **Switch GH Pages source** in repo Settings → Pages → Folder: `/docs` (was `/`). Frontend now lives under `docs/` instead of `frontend/` so GH Pages can serve it directly without a redirect.
- [ ] [FROM: Code → owner] **Phone install + smoke test**: load `https://michael-ticmn.github.io/mycellar/`, "Add to Home Screen", launch as PWA, submit a pair request — confirm round-trip works from phone.
- [ ] [FROM: Chat → Code, post-phone-smoke-test] Begin **Phase 3 — scan flow** (camera capture, Storage upload, scan_request round-trip, post-scan review form).
- [ ] [FROM: Chat → Code, in Phase 3] Test `getUserMedia` UX on iOS Safari (rear-camera selection + permission flow).

## Completed

- [x] [Chat → Code, 2026-04-28] Read BUILD_SPEC.md and execute Phase 1 (Supabase schema + Storage bucket + GH Pages frontend skeleton)
- [x] [Chat → Code, 2026-04-28] Propose a color palette for cellar27 — confirmed by Chat
- [x] [Chat → Code, 2026-04-28] Source/build the varietal-to-drink-window lookup table — flagged entries confirmed by Chat
- [x] [Chat → Code, 2026-04-28] Decide image size/format on upload (1600px long edge, JPEG q=0.85) — confirmed by Chat
- [x] [Chat → Code, 2026-04-28] After Phase 1 ships, append BUILD_LOG entry and flip CURRENT_STATE to "Chat"
- [x] [Chat → Code, 2026-04-28] Push Phase 1 commits to `origin/main`
- [x] [owner, 2026-04-28] Create Supabase project, apply `0001_init.sql`, paste keys into `docs/config.local.js`
- [x] [Code, 2026-04-28] Phase 2 — bridge watcher service (`watcher/`) and frontend pairing/flight/drink-now wiring
- [x] [owner, 2026-04-28] Enable Realtime publication on the 4 bridge tables (via `alter publication supabase_realtime add table ...`)
- [x] [owner, 2026-04-28] Deploy watcher locally on this Win11 box; paste service_role into `watcher/.env`
- [x] [Code, 2026-04-28] Autonomous bridge agent — watcher spawns `claude --print` per request
- [x] [owner + Code, 2026-04-28] Lockdown: Supabase sign-ups disabled, watcher allowlist + rate limit, DB CHECK constraints + per-user pending cap trigger
- [x] [Code, 2026-04-28] Commit `config.public.js` for GH Pages deploy
- [x] [Code, 2026-04-28] PWA wrapper: manifest, service worker, icons
- [x] [Code, 2026-04-28] Rename `frontend/` → `docs/` so GH Pages can serve directly

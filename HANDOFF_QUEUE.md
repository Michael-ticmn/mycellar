# cellar27 — HANDOFF_QUEUE.md

## Pending

- [ ] [FROM: Code → owner] **Enable Realtime** in Supabase dashboard → Database → Replication → `supabase_realtime` publication for `pairing_requests`, `pairing_responses`, `scan_requests`, `scan_responses`. Without this the watcher never receives events.
- [ ] [FROM: Code → owner] **Deploy the watcher** to the win11 VM. See [watcher/README.md](watcher/README.md). Need `SUPABASE_SERVICE_ROLE_KEY` from Settings → API.
- [ ] [FROM: Code → owner] **Launch Claude Code on the VM** in `<BRIDGE_DIR>` with the bridge prompt documented in [watcher/README.md](watcher/README.md).
- [ ] [FROM: Code → owner] **End-to-end smoke test**: submit a pairing request from the frontend, confirm a recommendation comes back.
- [ ] [FROM: Chat → Code, post-smoke-test] Begin **Phase 3 — scan flow** (camera capture, Storage upload, scan_request round-trip, post-scan review form).
- [ ] [FROM: Chat → Code, in Phase 3] Test `getUserMedia` UX on iOS Safari (rear-camera selection + permission flow).

## Completed

- [x] [Chat → Code, 2026-04-28] Read BUILD_SPEC.md and execute Phase 1 (Supabase schema + Storage bucket + GitHub Pages frontend skeleton)
- [x] [Chat → Code, 2026-04-28] Propose a color palette for cellar27 — confirmed by Chat
- [x] [Chat → Code, 2026-04-28] Source/build the varietal-to-drink-window lookup table — flagged entries confirmed by Chat
- [x] [Chat → Code, 2026-04-28] Decide image size/format on upload (1600px long edge, JPEG q=0.85) — confirmed by Chat
- [x] [Chat → Code, 2026-04-28] After Phase 1 ships, append BUILD_LOG entry and flip CURRENT_STATE to "Chat"
- [x] [Chat → Code, 2026-04-28] Push Phase 1 commits to `origin/main`
- [x] [owner, 2026-04-28] Create Supabase project, apply `0001_init.sql`, paste keys into `frontend/config.local.js`
- [x] [Code, 2026-04-28] Phase 2 — bridge watcher service (`watcher/`) and frontend pairing/flight/drink-now wiring

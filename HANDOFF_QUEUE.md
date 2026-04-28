# cellar27 — HANDOFF_QUEUE.md

## Pending

- [ ] [FROM: Code → Chat] **Confirm color palette** in [BUILD_LOG.md](BUILD_LOG.md) entry 2026-04-28. Specific question: is `#8b1a1a` burgundy bright enough for primary buttons against `#1a0f0f` background, or should accent shift?
- [ ] [FROM: Code → Chat] **Confirm image upload params** (1600px long edge, JPEG q=0.85) before Phase 3 implementation.
- [ ] [FROM: Code → Chat] **Validate varietal `TODO confirm` entries** in [frontend/js/varietal-windows.js](frontend/js/varietal-windows.js) (full list in BUILD_LOG entry).
- [ ] [FROM: Code → Michael] **Create the Supabase project** (`cellar27`), apply `supabase/migrations/0001_init.sql` in the SQL editor, then `cp frontend/config.local.example.js frontend/config.local.js` and paste in `SUPABASE_URL` + anon key. After that, frontend runs locally via `python -m http.server 8000` in `frontend/`.
- [ ] [FROM: Chat → Code, after sign-off] Push Phase 1 commits to `origin/main`.
- [ ] [FROM: Chat → Code, post-Supabase setup] Begin **Phase 2 — the watcher** ([BUILD_SPEC.md §2](BUILD_SPEC.md)).
- [ ] [FROM: Chat → Code, in Phase 3] Test `getUserMedia` UX on iOS Safari (rear-camera selection + permission flow) before claiming the scan view is done.

## Completed

- [x] [Chat → Code, 2026-04-28] Read BUILD_SPEC.md and execute Phase 1 (Supabase schema + Storage bucket + GitHub Pages frontend skeleton)
- [x] [Chat → Code, 2026-04-28] Propose a color palette for cellar27 — posted in BUILD_LOG, awaiting confirm
- [x] [Chat → Code, 2026-04-28] Source/build the varietal-to-drink-window lookup table; flagged uncertain entries
- [x] [Chat → Code, 2026-04-28] Decide image size/format on upload (recommendation posted in BUILD_LOG)
- [x] [Chat → Code, 2026-04-28] After Phase 1 ships, append BUILD_LOG entry and flip CURRENT_STATE to "Chat"

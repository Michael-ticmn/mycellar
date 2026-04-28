# cellar27 — CURRENT_STATE.md

## As of 2026-04-28 (post Phase 1 scaffold)

**What exists and works:**
- Repo monorepo layout: `frontend/`, `watcher/`, `supabase/migrations/`, planning docs at root.
- Supabase migration `0001_init.sql` ready to apply (5 tables, RLS, Storage bucket + policies, updated_at trigger).
- Frontend skeleton: index.html shell, hash router, email/password auth gate, cellar grid, manual add-bottle form with live drink-window suggestion, drink-now bucketed view, tap-to-pour with undo toast. No build step. Loads Supabase JS v2 from CDN.
- Varietal-window lookup with 35+ entries plus style-based fallback.
- Burgundy/oxblood palette applied per BUILD_SPEC §1.3 (with two extra shades — see BUILD_LOG entry).

**What's in progress:** Awaiting Chat review of the BUILD_LOG proposals (palette, image params, varietal `TODO confirm` entries) before commits get pushed.

**What's broken / incomplete:**
- Frontend can't run live until Michael creates the Supabase project and fills `frontend/config.local.js`.
- Pairing/flight/scan flows are stub views only — those land in Phase 2 / Phase 3.
- Camera (`getUserMedia`) UX deferred to Phase 3.
- Nothing pushed to GH Pages yet (explicitly forbidden until palette is confirmed).

**Immediate next action:** Chat reviews [BUILD_LOG.md](BUILD_LOG.md) entry dated 2026-04-28 — confirm palette, image params, varietal flags. Then either request changes or green-light the push to `origin/main`.

**Which surface should act next:** Chat

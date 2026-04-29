# cellar27 — CURRENT_STATE.md

## As of 2026-04-28 (post deploy + lockdown + PWA + docs/ rename)

**What exists and works:**
- **Frontend live on GitHub Pages** at `https://michael-ticmn.github.io/mycellar/`. Source is `docs/` (renamed from `frontend/` so GH Pages can serve directly). Anon-key + URL committed in `docs/config.public.js`; `docs/config.local.js` is git-ignored for local override.
- **PWA**: manifest + service worker + SVG icons. Installable from iOS/Android home screen, app shell cached for instant load.
- **Watcher** running locally on the Win11 dev box (`npm start`). Subscribed to Realtime, autonomously spawns `claude --print` per request, ingests responses, archives.
- **Supabase**: schema + RLS + Storage + Realtime publication + lockdown (CHECK constraints, per-user pending cap, sign-ups disabled).
- **Watcher policy gates**: `ALLOWED_USER_IDS` env restricts compute to allowlisted users; sliding-window 20-req/hr/user rate limit.
- End-to-end pair round-trip verified ~22–26s with all gates active.

**What's in progress:** owner needs to switch GH Pages source folder from `/` to `/docs` in repo Settings → Pages now that the rename is pushed. Then phone smoke test.

**What's broken / incomplete:**
- Scan flow (camera capture + Storage upload) — Phase 3.
- Tasting log, mobile-specific layout pass, sharing flights — Phase 4 polish.
- Watcher runs on the dev box, not an always-on host. Sleep = no AI processing during the sleep window. Acceptable for now.

**Immediate next action:** owner — Settings → Pages → Folder: `/docs` → Save. Wait 1–2 min for rebuild. Then `https://michael-ticmn.github.io/mycellar/` should load the app directly. Phone install + smoke test follows.

**Which surface should act next:** owner (Pages folder change + phone smoke test), then Code (Phase 3 scan flow) once round-trip works on phone.

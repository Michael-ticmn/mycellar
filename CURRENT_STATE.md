# cellar27 — CURRENT_STATE.md

## As of 2026-04-28 (post Phase 2 build)

**What exists and works:**
- Phase 1: schema applied to live Supabase project, frontend skeleton verified end-to-end (sign-in, add bottle, drink-window auto-fill).
- Phase 2: bridge watcher service written ([`watcher/`](watcher/)) — Node 20 + chokidar + Supabase service role. Subscribes to pairing/scan requests, renders markdown into `<bridge>/requests/`, watches `<bridge>/responses/`, ingests results, archives. Catch-up sweep + 10-minute timeout sweep.
- Phase 2: frontend pairing/flight/drink-now flows wired against Supabase Realtime ([`frontend/js/pairings.js`](frontend/js/pairings.js)). Cellar snapshot stripped of `acquired_price` per STRATEGY. Recommendations rendered as bottle cards + narrative.

**What's in progress:** Phase 2 has not yet been run end-to-end live. Watcher is built but not deployed to the VM; Claude Code on the VM hasn't been started with the bridge prompt; Realtime publication may not yet be enabled in Supabase.

**What's broken / incomplete:**
- Scan flow (camera capture + Storage upload) — Phase 3.
- Tasting log, mobile-specific pass, sharing flights — Phase 4 polish.

**Immediate next action:** Michael — deploy the watcher (see [`watcher/README.md`](watcher/README.md)):
1. In Supabase dashboard → Database → Replication → enable `pairing_requests`, `pairing_responses`, `scan_requests`, `scan_responses` for the `supabase_realtime` publication.
2. On the win11 VM: clone the repo, `cd watcher && npm install`, copy `.env.example` to `.env`, paste in `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, `npm start` (or PM2).
3. On the same VM: launch Claude Code in `<BRIDGE_DIR>` with the prompt documented in `watcher/README.md`.
4. From the frontend, submit a pairing request and confirm it round-trips.

**Which surface should act next:** Michael (deploy + smoke test), then Code (Phase 3 scan flow) once round-trip works.

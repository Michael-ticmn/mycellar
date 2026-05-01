# cellar27 — CURRENT_STATE.md

## As of 2026-04-30 (v0.9.0 — top-10 hardening / modernization batch)

**What exists and works:**

- **Frontend live on GitHub Pages** at `https://michael-ticmn.github.io/mycellar/`. Source is `docs/`.
- **PWA**: manifest + service worker + SVG icons + `updateViaCache: 'none'` on register, `cache: 'reload'` on install fetches, and a user-tappable "Update ready" banner so new builds land cleanly.
- **Manage tab** (merged Add + Scan) with a 2-column grid: Add a bottle [Scan label / Enter manually] · Pour a bottle [Scan to identify / Pick from cellar].
- **Multi-bottle scan-add** with an in-memory queue + tray; up to 5 in flight, each independently reviewable as its AI response lands.
- **Bottle detail** with front/back label thumbnails (lightbox on tap), AI enrichment ("More info") and a Read-aloud button on every narrative.
- **Cellar list view** as default (compact rows with style-colored left edge), with a List/Card toggle persisted in localStorage.
- **Read-aloud** on every narrative (Pair / Flight / Drink-now / scan results / bottle detail) via the browser's SpeechSynthesis API. Voice + speed picker behind a ▾ caret, persisted across sessions.
- **Watcher** runs as a detached background `node.exe` on the owner's Win11 machine (no PM2 / service / scheduled task). Restart procedure documented in `watcher/README.md`.
- **Security gates** (see [`docs/SECURITY.md`](docs/SECURITY.md) for the full table):
  - DB-enforced allowlist (`cellar27_allowed_users`) on INSERT.
  - DB-enforced rate limit (100/hr per user).
  - 5 in-flight cap per user (DB trigger).
  - Global daily Claude-call ceiling (250/day, atomic counter in `cellar27_watcher_metrics`).
  - Stale-claim sweep with 2-retry cap.
  - Email notification on limit hit (Gmail SMTP via App Password; cooldown-throttled).
- End-to-end pair, flight, drink-now, scan-add, scan-pour, manual-add — all working from phone PWA.

**Recently shipped (v0.9.0, this session):**
- Frontend bundled + minified via esbuild (`npm run build:docs` → [`docs/js/dist/app.bundle.js`](docs/js/dist/app.bundle.js), ~46 KB minified).
- AbortController on view fetch — no more late-arriving HTML overwriting the current view.
- Inline `onerror` removed from `index.html`; `config.local.js` is now loaded dynamically from JS (CSP-ready).
- Watcher now passes a filtered env to the spawned `claude` (no more service-role key / SMTP password leakage).
- Watcher rate-limit map has LRU eviction (10k cap) — closes the slow memory leak.
- Watcher fails fast on realtime/chokidar/unhandled errors and shuts down gracefully on SIGINT/SIGTERM.
- Scan-request image downloads now run in parallel.
- New SQL migration [`0006_search_path_hardening.sql`](supabase/migrations/0006_search_path_hardening.sql) hardens `search_path` on the three security-definer functions.
- esbuild dev dep pinned to `^0.25` so `npm audit` stays clean.

**Owner action queued (see [`HANDOFF_QUEUE.md`](HANDOFF_QUEUE.md)):**
- Apply migration 0006 in the Supabase SQL Editor.
- Restart the watcher to pick up the v0.9.0 hardening.

**What's broken / incomplete:**
- Watcher runs on the owner's primary device, not an always-on host. Sleep = no AI processing during the sleep window. Acceptable for personal use.

**Immediate next action:** owner runs migration 0006 + restarts the watcher.

**Which surface should act next:** owner.

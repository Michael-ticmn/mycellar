# cellar27 — CURRENT_STATE.md

## As of 2026-05-01 (watcher: realtime reconnect + DEP0190 fix)

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
- **Guest sharing** (`#/share`): owner generates a short-lived, mobile-friendly link with a QR. Guests browse the cellar and run pair / flight / ask-sommelier without an account; price / notes / storage / label fields are stripped server-side. Per-link AI budget (independent of the owner's 100/hr quota), owner-picks-TTL at creation, one active link at a time, generating a new link revokes the prior. SECURITY DEFINER RPCs over an `anon` client; RLS on `bottles` and `pairing_requests` untouched.

**Recently shipped (2026-05-01 — watcher self-death email):**
- The three remaining fail-fast paths (`unhandledRejection`, `uncaughtException`, fatal chokidar) now email via the existing SMTP `notify()` before exiting, so the next watcher death is observable in the inbox at the moment it happens (5s SMTP timeout so a hung mail server can't block exit; 30-min per-reason cooldown to prevent flooding).

**Recently shipped (2026-05-01 — watcher reconnect + DEP0190):**
- Watcher: in-process exponential-backoff reconnect on Supabase realtime drop (replaces v0.9.0's fail-fast which assumed a supervisor — there isn't one). Sweeps that channel's table on re-`SUBSCRIBED` to catch INSERTs missed during the dead window. `uncaughtException`/`unhandledRejection` keep fail-fast (bug signatures, not network signatures).
- Watcher: explicit PATH-based binary resolution in [`watcher/src/agent.js`](watcher/src/agent.js) so we can drop `shell:true` on the `spawn()` call. Clears the Node DEP0190 deprecation warning.
- Owner restarted the watcher; today's stuck morning pairing request was picked up by the startup pending-sweep automatically.

**Recently shipped (v0.9.6 — guest-sharing hardening):**
- New SQL migration [`0011_share_search_path_hardening.sql`](supabase/migrations/0011_share_search_path_hardening.sql): the five share-link `security definer` RPCs now run with `search_path = pg_catalog, public` and schema-qualified table refs (matches what 0006 did for the older RPCs). Adds a per-link 1-req-per-2-second QPS guard inside `cellar27_share_create_pairing_request` so a guest with quota=50 can't drain it in <1s.
- [`docs/index.html`](docs/index.html): `<meta name="referrer" content="strict-origin-when-cross-origin">` so guest tokens in `#/guest/<token>` don't leak via Referer to external sites the guest visits. Pinned the Supabase JS CDN script to `@2.105.1/dist/umd/supabase.js` (the verbatim npm artifact, not the dynamically-minified `.min.js`) with SRI + `crossorigin="anonymous"`.
- [`docs/js/guest.js`](docs/js/guest.js): exponential backoff on the polling loop (500ms → 1s → 2s → cap at 5s) — drops worst-case poll volume ~2× without changing first-result latency. New `rate_too_fast` error message.

**Recently shipped (v0.9.5):**
- New tables / RPCs: `share_links`, `cellar27_share_resolve`, `cellar27_share_list_bottles`, `cellar27_share_create_pairing_request`, `cellar27_share_get_response`, `cellar27_share_create`. `pairing_requests` gains a nullable `share_link_id` so guest-originated requests are auditable and can't be polled by other tokens.
- New owner UI at [`docs/views/share.html`](docs/views/share.html) — TTL picker (2 / 6 / 24 / 72 h), AI quota input, generate / revoke. Vendored QR library at [`docs/vendor/qrcode.min.js`](docs/vendor/qrcode.min.js).
- New anon UI at [`docs/views/guest.html`](docs/views/guest.html) — tabbed Cellar / Pair / Flight / Sommelier; bottle rows + pick cards open a sanitized-fields modal (anon clients can't hit RLS-scoped `/bottle/:id`). Banner reads "Shared cellar · N requests left".
- Owner-side recommendation renderer reordered: narrative leads, picks follow. All bottle cards are clickable now (owner → detail page, guest → modal).

**Recently shipped (v0.9.1):**
- `autoEnrich()` no longer fails silently — failed enrichments surface as a `Retry sommelier notes` button on the bottle detail page (with the error in the title), plus a toast.
- Audited every `innerHTML =` site in [`docs/js/app.js`](docs/js/app.js); fixed two unescaped `e.message` paths and made the bottle-detail `<img src=>` consistent with `<img data-zoom=>` (both use `escapeAttr` now).
- New SQL migration [`0007_claimed_by_invariant.sql`](supabase/migrations/0007_claimed_by_invariant.sql) formalizes the `status='picked_up' ⇒ claimed_by IS NOT NULL` invariant on both request tables.

**Recently shipped (v0.9.0):**
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
- Apply migrations 0006 + 0007 in the Supabase SQL Editor (0008 / 0009 / 0010 / 0011 are already applied).
- Optional: drop two phone screenshots into `docs/screenshots/` and wire into the manifest for a richer install prompt.

**What's broken / incomplete:**
- Watcher runs on the owner's primary device, not an always-on host. Sleep = no AI processing during the sleep window. Acceptable for personal use.

**Immediate next action:** owner runs migrations 0006 + 0007 (the watcher's already restarted with today's reconnect fix; restart again after applying 0006 + 0007 to pick up env filtering / LRU / parallel image downloads from the v0.9.0 batch).

**Which surface should act next:** owner.

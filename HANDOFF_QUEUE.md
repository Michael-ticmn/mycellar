# cellar27 — HANDOFF_QUEUE.md

## Pending

- [ ] [owner] Apply migration [`supabase/migrations/0006_search_path_hardening.sql`](supabase/migrations/0006_search_path_hardening.sql) in the Supabase SQL Editor (idempotent; re-runs the three security-definer functions with locked-down `search_path` and schema-qualified table refs).
- [ ] [owner] Apply migration [`supabase/migrations/0007_claimed_by_invariant.sql`](supabase/migrations/0007_claimed_by_invariant.sql) in the Supabase SQL Editor (adds `claimed_by NOT NULL when status='picked_up'` CHECK constraints to both request tables, NOT VALID so it doesn't reject legacy rows; optional VALIDATE step in the file's footer comment).
- [ ] [owner] Restart the watcher to pick up the v0.9.0 hardening (env filtering for spawned Claude, LRU rate-limit map, fail-fast realtime/chokidar handlers, parallel image downloads, graceful SIGINT/SIGTERM).
- [ ] [owner] Drop two PNG screenshots into `docs/screenshots/` (suggested: `cellar-list-540x1170.png` and `bottle-detail-540x1170.png`, taken from the phone PWA at v0.9.1) and add a `screenshots` array to [`docs/manifest.webmanifest`](docs/manifest.webmanifest) so Chromium's richer install UI shows them. Couldn't auto-generate — needs real raster captures.

## Completed

- [x] [owner, 2026-04-30] Applied the three guest-share migrations ([`0008_share_links.sql`](supabase/migrations/0008_share_links.sql), [`0009_share_links_ai.sql`](supabase/migrations/0009_share_links_ai.sql), [`0010_share_create.sql`](supabase/migrations/0010_share_create.sql)) in the Supabase SQL Editor.
- [x] [Code, 2026-04-30] **v0.9.5 — guest sharing**: owner can generate a short-lived, mobile-friendly link (TTL 2 / 6 / 24 / 72 h, AI quota 1–50, default 20). Guest scans a QR (vendored `docs/vendor/qrcode.min.js`) and lands on `#/guest/<token>` — anonymous, token-gated, RLS untouched. Guests browse a sanitized cellar (no prices / notes / storage / labels) and run pair / flight / ask-sommelier against the owner's inventory; per-link `ai_used / ai_quota` counter is decremented atomically inside `cellar27_share_create_pairing_request`, owner's normal 100/hr rate-limit and allowlist are bypassed for guest inserts (per-link budget instead; watcher's 250/day global ceiling still applies). Generating a new link revokes the prior one. New files: `docs/views/share.html`, `docs/views/guest.html`, `docs/js/share.js`, `docs/js/guest.js`. New routes: `#/share` (owner), `#/guest/<token>` (anon).
- [x] [Code, 2026-04-30] **v0.9.1 — autoEnrich UX + innerHTML XSS audit**:
  - `autoEnrich()` no longer swallows errors silently. Failures are tracked per bottle in a new `enrichFailures` Map; the detail page shows a "Retry sommelier notes" button (with the error message in the title) instead of the spinner-forever bug. Toast on failure if the user is on the affected bottle.
  - Audited every `.innerHTML =` site in [`docs/js/app.js`](docs/js/app.js) (no other JS file uses innerHTML). Three real findings fixed: two unescaped `e.message` interpolations on lines 220 and 825 (`mountCellar` / `mountDrinkNow` error paths), and `src=` attributes for the bottle-detail label thumbnails now go through `escapeAttr` (defensive — Supabase signed URLs are practically safe but consistency matters). Added an XSS rule comment above `escapeHtml` documenting the policy.
  - SQL migration [`0007_claimed_by_invariant.sql`](supabase/migrations/0007_claimed_by_invariant.sql) formalizes the watcher's already-honored invariant: `status='picked_up' ⇒ claimed_by IS NOT NULL` on both request tables.
- [x] [Code, 2026-04-30] **v0.9.0 — top-10 hardening / modernization batch**:
  - Watcher: env allowlist when spawning `claude` (no more SUPABASE_SERVICE_ROLE_KEY / SMTP_PASS leakage); LRU eviction on the rate-limit map (10k cap, prevents long-term memory leak); fail-fast on realtime CHANNEL_ERROR/TIMED_OUT/CLOSED, chokidar errors, and unhandledRejection (supervisor restarts a clean process); graceful SIGINT/SIGTERM that unsubscribes channels and closes the file watcher; parallel image downloads in scan requests (Promise.all → halves 2-image latency).
  - SQL: migration 0006 hardens `search_path` to `pg_catalog, public` and schema-qualifies every table ref in the three security-definer functions.
  - Frontend: esbuild bundle (`docs/js/dist/app.bundle.js`, ~46 KB minified vs ~83 KB raw); AbortController on view fetch (no more late-arriving HTML overwriting the current view); dynamic `config.local.js` loader (drops the inline `onerror` from index.html, CSP-ready).
- [x] [Code, 2026-04-30] **`scripts/security-smoke-test.mjs`**: exercises allowlist predicate, DB rate limit RPC, in-flight cap trigger (5→6), and daily-ceiling RPC — all without spawning Claude. Self-cleans seed rows. Closes P1-3 from the original security plan.
- [x] [Code, 2026-04-30] **Tier 1 + Tier 2 limit tuning**: DB rate limit 20→100/hr, watcher rate limit 20→100/hr (env-tunable), daily ceiling 100→250, email notify on limit hits via SMTP with per-key cooldown. ([507a778](https://github.com/Michael-ticmn/mycellar/commit/507a778))
- [x] [Code, 2026-04-30] **docs/SECURITY.md**: single source of truth for all gates + tune/bypass cookbook. Unstaled ARCHITECTURE.md "Security shape". ([bf9cc4d](https://github.com/Michael-ticmn/mycellar/commit/bf9cc4d))
- [x] [Code, 2026-04-30] **Read-aloud + voice picker**: SpeechSynthesis on every narrative; ▾ caret opens shared popover (voice radio list, English filter, 0.7–1.3× rate slider, Test). Persisted in localStorage. (v0.8.2 + v0.8.3)
- [x] [Code, 2026-04-30] **Pour-loader animation**: tilted bottle dripping into a wine glass that fills/drains (SMIL SVG). Used wherever we wait on Claude. (v0.8.1)
- [x] [Code, 2026-04-30] **Cellar compact list view + List/Card toggle**: ~6–8 bottles per phone screen vs 2; persisted in localStorage. (v0.8.0)
- [x] [Code, 2026-04-30] **Icon-only nav**: bottle (Manage), glass+plate (Pair), 3 glasses (Flight), tipped glass (Drink now). Bumped icon size and touch target. (v0.7.5–0.7.7)
- [x] [Code, 2026-04-30] **Capture button**: round and centered on the camera pane. (v0.7.6)
- [x] [Code, 2026-04-30] **SW update flow rebuilt**: `updateViaCache:'none'` on register, `cache:'reload'` on install fetches, in-app "Update ready" banner with manual reload. (v0.7.1, v0.7.3, v0.6.6)
- [x] [Code, 2026-04-30] **Merge Add + Scan tabs into Manage** with 2-column grid; remove Sign-out button; reorder drink-now to put sommelier on top. (v0.7.0, v0.6.4–0.6.5)
- [x] [Code, 2026-04-30] **Wine-glass icon for Drink now** (replaces text label). (v0.6.3)
- [x] [Code, 2026-04-30] **Multi-bottle scan-add** with background queue + review tray (in-memory); concurrent scans, review on demand. (v0.6.0–0.6.2)
- [x] [Code, 2026-04-30] **Security P0/P1**: allowlist + rate limit moved into RLS; claimed_by/retry_count + stale-claim sweep with retry cap; global daily Claude-call ceiling. ([ca1dfcf](https://github.com/Michael-ticmn/mycellar/commit/ca1dfcf))
- [x] [Code, 2026-04-29] **MIT License** added.
- [x] [Code, 2026-04-29] **ARCHITECTURE.md** + printable colored PDF (one-page request lifecycle).
- [x] [Code, 2026-04-29] **Quick wins**: edit bottle, cellar search/filter/sort/chips, photo lightbox, auto-enrich on save. (v0.5.3)
- [x] [Code, 2026-04-29] **Scan-add detects duplicate**, offers merge (qty+1) vs separate. (v0.5.2)
- [x] [Code, 2026-04-29] **SW network-first for HTML/views** so content tweaks land without waiting for SW activation cycle. (v0.5.1)
- [x] [Code, 2026-04-29] **Sommelier rename** (was "AI"), wine-color tinted bottle cards by style, flight extras suggestions. (v0.5.0)
- [x] [Code, 2026-04-29] **Phase 3 — scan flow**: front + optional back labels, Storage upload, scan_request round-trip, post-scan review form with AI enrichment. (v0.4.0–0.4.2)
- [x] [Code, 2026-04-29] **Mobile responsive layout**: tighter topbar, two-up cards, safe-area insets.
- [x] [Code, 2026-04-29] **Version tracking + auto-update on SW change** (later refined to manual banner).
- [x] [owner, 2026-04-28] Phone install + smoke test of pair round-trip via PWA.
- [x] [owner, 2026-04-28] Switched GH Pages source folder from `/` to `/docs`.

(Earlier completed items from Phase 1 and 2 trimmed for length — see git log for the full record.)

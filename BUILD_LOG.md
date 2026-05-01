# cellar27 — BUILD_LOG.md

(Code appends entries here at the end of every meaningful work session. Format: dated entry with what was built, decisions made, blockers, and the expected next task.)

---

## 2026-05-01 (late morning) — watcher: self-death email path

### Built

Follow-up to today's earlier reconnect fix. Realtime drops are now handled in-process (so they don't kill the watcher), but the three remaining fatal paths — `unhandledRejection`, `uncaughtException`, fatal chokidar `error` — still call `process.exit(1)` because they reflect real bugs / filesystem disappearance, not transient network issues. The watcher runs as a detached `node.exe` with no supervisor, so those silent exits would leave the user discovering the problem only when their next phone request hangs (which is exactly what happened this morning before the reconnect fix).

**watcher/src/index.js** — new `fatalAndExit(reason, body)` helper
- Logs the FATAL line as before, then calls the existing [`notify()`](watcher/src/notify.js) SMTP path with subject `cellar27 watcher died (<reason>) on <hostname>` and a body containing the reason, timestamp, error detail (truncated to 3KB), and a pointer to the restart procedure.
- Wrapped in `Promise.race(notify, setTimeout(5000))` so a hung SMTP server can't keep the watcher alive in a corrupted state — 5 seconds is enough for any responsive SMTP, and if it's not, exit anyway.
- `notify()`'s per-key cooldown (default 30 min, configurable via `NOTIFY_COOLDOWN_MS`) prevents a flapping process from spamming the inbox.
- The three handlers (`unhandledRejection`, `uncaughtException`, chokidar `error`) all route through the helper; logged reason comes from the constructor name so each gets its own cooldown bucket.

### Decisions
- **Reuse the existing `notify()` infrastructure rather than write a separate path**: the SMTP credentials, cooldown logic, and Gmail App Password setup are already wired and proven via the existing limit-hit notifications. Adding a parallel path would duplicate config without adding capability.
- **5-second SMTP timeout**: long enough that a healthy SMTP responds, short enough that a dead one doesn't make the failure mode "watcher seems frozen" instead of "watcher died visibly."
- **Per-reason cooldown key**: `watcher-fatal:unhandledRejection` and `watcher-fatal:chokidar` are separate buckets, so two genuinely-different fatal events within the cooldown window each get an email.
- **Skipped a weekly cloud routine option**: the user originally asked for one, but a remote agent has zero access to local watcher logs (gitignored, never reach the GitHub repo). The "watcher emails on its own death" approach is strictly better — instant signal vs ≤7-day signal, no routine slot consumed, no false-clear when the cloud agent finds nothing in a missing log.

### Validation
- Watcher restarted; both channels `SUBSCRIBED` cleanly; no DEP0190 in stderr; idle. Real test path is unfortunately "wait for the next genuine fatal" — no clean way to provoke an `unhandledRejection` for verification without hacking the source temporarily.

### No version bump
- Watcher-only change. PWA `version.js` stays at 0.9.6.

---

## 2026-05-01 (morning) — watcher: realtime reconnect + DEP0190 fix

### Built

A real morning request stuck in `pending`, never picked up. Root cause: at `2026-05-01T11:23:23Z` the Supabase realtime channel transitioned to `CHANNEL_ERROR` (transient network hiccup); the v0.9.0 fail-fast logic correctly exited the process expecting a supervisor restart. **But there is no supervisor** — the watcher runs as a detached `node.exe` (no PM2, no service, no scheduled task; see `watcher_runtime` memory). Fail-fast = silent death until manual restart.

**Watcher: reconnect in-process** ([`watcher/src/index.js`](watcher/src/index.js))
- Replaced `process.exit(1)` on `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED` with exponential-backoff reconnect: 2s → 4s → 8s → 16s → 32s → cap 60s. Per-channel state in a `Map`, debounced so repeated status callbacks during a flap don't stack timers.
- On successful re-`SUBSCRIBED`, sweep that channel's table for `status='pending'` rows. Realtime doesn't replay INSERTs that fired during the dead window, so without this any request landing during the gap stays pending forever (which is exactly what happened today).
- Refactored: extracted `subscribeChannel(name)` so initial subscribe and reconnect share the same code path. Channel handle stored in a `Map` keyed by name; the prior handle is unsubscribed before replacement so realtime doesn't end up with two subs and duplicate INSERT events.
- Shutdown handler clears any pending reconnect timers before unsubscribing so SIGINT/SIGTERM stays clean.
- `uncaughtException` / `unhandledRejection` keep their fail-fast behavior — those reflect bugs in the process, not transient network issues, and continuing in a corrupted state is worse than restarting.

**Watcher: DEP0190 fix** ([`watcher/src/agent.js`](watcher/src/agent.js))
- Was: `spawn(claudeBin, args, { shell: process.platform === 'win32', ... })`. Needed `shell:true` so cmd.exe could resolve `claude.cmd` (npm CLI shim on Windows).
- Now: explicit PATH-based binary resolution honoring `PATHEXT`, then `spawn(resolvedPath, args, { shell: false })`. Cached after first call. No string concatenation, no DEP0190 warning, no shell-injection surface.

### Decisions
- **Reconnect in-process over "add a supervisor"**: matches the user's explicit choice in `watcher_runtime` memory. PM2 was rejected; we work with the runtime model that exists.
- **Per-table sweep on reconnect, not full sweep**: a channel can flap independently — we shouldn't pay an O(N) sweep across every table because pairing-requests had a hiccup.
- **Backoff cap at 60s**: Supabase outages are usually seconds-long; a 60s cap means we recover within a minute of service restoration even after several failed attempts. Don't go longer — stale `pending` requests on the phone show as spinners until processed.
- **Keep fail-fast on uncaught*/unhandledRejection*** : those are bug signatures, not network signatures. Different failure mode, different right answer.
- **Resolve `.cmd` once and cache**: spawn is the hot path; PATH search shouldn't happen per-request.

### Validation
- Watcher restarted cleanly after the edits; both channels `SUBSCRIBED` on first try; no DEP0190 in stderr; today's stuck request was picked up by the startup sweep before the restart and completed in ~50s.

### No version bump
- These are watcher-only changes (no frontend, no SQL). PWA `version.js` stays at 0.9.6. Watcher has no semver of its own.

---

## 2026-04-30 (late evening) — v0.9.6: guest-sharing hardening

### Built

Audit-driven follow-ups on the v0.9.5 guest-sharing surface — the only public, anonymous, AI-spawning code path in the project, so worth a real second pass. Five items shipped (the auditor surfaced ~10; verified two of the "high-impact" findings were over-stated and skipped them — see Decisions).

**SQL — search_path lockdown + per-link QPS guard**
[`supabase/migrations/0011_share_search_path_hardening.sql`](supabase/migrations/0011_share_search_path_hardening.sql)
- Re-creates all five share-link `security definer` functions with `set search_path = pg_catalog, public` and fully schema-qualified table refs (`public.share_links`, `public.bottles`, `public.pairing_requests`, `public.pairing_responses`, `public.cellar27_allowed_users`). `extensions.gen_random_bytes` schema-qualified directly so we don't need `extensions` on search_path. Mirrors the pattern 0006 established for the older security-definer functions.
- Added a per-link rate guard inside `cellar27_share_create_pairing_request`: counts requests created in the last 2 seconds for the resolved `share_link_id`; raises `rate_too_fast` if any. The guard runs *before* the atomic quota claim so a denied request doesn't burn a quota unit. Caps the link to ~one new request per 2 seconds, which matches owner expectation ("spread over the link's lifetime") and prevents a script from draining a 50-quota link in milliseconds. The 5-in-flight trigger and 250/day ceiling already bound severity, but neither paces.

**Frontend — referrer + SRI on Supabase CDN**
[`docs/index.html`](docs/index.html)
- Added `<meta name="referrer" content="strict-origin-when-cross-origin" />`. Without this, if a guest follows any external link from a sommelier response, the destination sees `Referer: https://…/#/guest/<token>` and learns the share token. Modern browsers default close to this anyway, but explicit is safer on older mobile Safari.
- Pinned the Supabase JS UMD script from `@2/dist/umd/supabase.min.js` to `@2.105.1/dist/umd/supabase.js` (the verbatim npm artifact) with `integrity="sha384-pNDx8ebKKncqRMS1aZKjmB1T1jdd6psogvE0+sPrwW/Sy94M6geGuQpYXQnLCdRq"` and `crossorigin="anonymous"`. Crucial detail: jsDelivr's `.min.js` variant is dynamically re-minified per request, so SRI on it is unsupported; the unsuffixed `.js` is the original npm tarball file served verbatim. Comment in the script tag documents the upgrade procedure (curl + openssl dgst).
- Why this matters for guest mode specifically: guest tokens are the *only* secret in guest mode (no auth session, no localStorage credential). A compromised CDN or coffee-shop MitM swapping the Supabase bundle could read the token from `location.hash` and exfiltrate. SRI closes that.

**Frontend — exponential backoff in guest polling**
[`docs/js/guest.js`](docs/js/guest.js)
- Replaced the flat 2-second polling loop with backoff: 500ms → 1s → 2s → cap at 5s. Drops worst-case call volume from ~150 to ~70 RPCs per 5-min request without changing first-result latency for the common 5–15s case. Added `rate_too_fast` to `prettyShareError` so the new server-side QPS guard surfaces a friendly message instead of raw `P0001`.

**Bundle**
- Rebuilt: 56.3 KB minified (was 49.4 at v0.9.1; growth from the merged-in share + guest code from v0.9.5 + the small backoff/error-message changes here).
- `docs/version.js`: `0.9.5` → `0.9.6`.

### Decisions
- **Skipped "response scope allows cross-link probing"**: the auditor flagged that a guest with a valid token might enumerate other links' request IDs. Verified directly against [`0009_share_links_ai.sql:117-127`](supabase/migrations/0009_share_links_ai.sql#L117) — the JOIN already requires `pr.share_link_id = sl.id` AND `sl.token = p_token`, and request IDs are UUIDs (`gen_random_uuid()`), not enumerable. Both "doesn't exist" and "exists under different token" return zero rows — indistinguishable. No real leak.
- **Skipped "guest bypasses owner rate limit"**: documented by-design behavior on [`0009:6-7`](supabase/migrations/0009_share_links_ai.sql#L6) — guests are intentionally on a per-link budget, not the owner's 100/hr. The 5-in-flight table trigger and 250/day global ceiling still fire because they're table-level, not RLS. The new per-link QPS guard in 0011 covers the residual abuse vector (in-link spam pacing).
- **Skipped "timing-safe token comparison"**: 192 bits of entropy in `gen_random_bytes(24)` makes a timing oracle infeasible regardless of comparison constant-time-ness. Adding `pg_crypto.constant_time_eq` would be theater.
- **Pinned `2.105.1` over latest-`@2`**: SRI requires bit-stable bytes. Trade-off: future security fixes in supabase-js require manual upgrade + hash refresh (one-line + curl). Acceptable for the security gain.
- **Server-side QPS guard over client-side throttle**: a malicious script bypasses any client-side rate limit trivially. Server-side enforcement is the only one that actually counts.

### Owner action required
Apply [`supabase/migrations/0011_share_search_path_hardening.sql`](supabase/migrations/0011_share_search_path_hardening.sql) in the Supabase SQL Editor (in addition to 0006 + 0007 still pending from prior sessions). Restart watcher only needed for 0006/0007 — 0011 is RPC re-creation, no service restart.

---

## 2026-04-30 (evening) — v0.9.5: guest sharing (temporary read+AI link with QR)

### Built

A short-lived, mobile-first share link that lets a guest browse the owner's cellar and run pair / flight / ask-sommelier — without an account — over an anonymous Supabase client. Implements the pattern sketched in `ARCHITECTURE.md`'s "share_links" note and extends it to AI features with a per-link spawn cap.

**Database** (three new migrations; applied in order)
- `0008_share_links.sql` — `share_links` table (`owner_user_id`, `token`, `expires_at`, `ai_quota`, `ai_used`, `revoked_at`). RLS: owners can read/revoke their own rows; inserts go through `cellar27_share_create()` so the prior active link can be revoked atomically. Two SECURITY DEFINER RPCs granted to `anon`: `cellar27_share_resolve(token)` returns expiry / quota for an active token (no row if missing/revoked/expired); `cellar27_share_list_bottles(token)` returns the same field set as `snapshotForBridge` in `pairings.js` — `acquired_price`, `notes`, `storage_location`, label paths, and `user_id` are explicitly dropped.
- `0009_share_links_ai.sql` — adds `share_link_id uuid` to `pairing_requests` (FK + index, nullable so existing rows are unaffected). Two more anon-callable RPCs: `cellar27_share_create_pairing_request(token, type, ctx)` atomically increments `ai_used` (raises `quota_exhausted` or `link_invalid` if the row didn't update), builds the sanitized snapshot in SQL, and inserts into `pairing_requests` with the owner's `user_id` so the watcher sees an identical row to an owner-originated request. `cellar27_share_get_response(token, request_id)` joins `pairing_requests` to `share_links` and only returns rows whose `share_link_id` matches the supplied token — prevents probing of owner-originated requests with a guest token.
- `0010_share_create.sql` — `cellar27_share_create(p_ttl_hours, p_ai_quota)` for owners. Allowlist gate (same as creating real requests), TTL clamped 1–168 h, quota clamped 1–50. Generates the token from `extensions.gen_random_bytes(24)` (url-safe base64), revokes any prior active row for the caller, returns the new row.

**Owner UI** (`docs/views/share.html` + `docs/js/share.js` + `mountShare` in `app.js`)
- New `#/share` route + topbar icon (last in nav). Form: TTL dropdown (2 / 6 / 24 / 72 h), AI quota input (default 20). Active-link panel renders the full URL, a QR via vendored qrcodejs (`docs/vendor/qrcode.min.js`, ~20 KB, MIT), `ai_used / ai_quota` line with hours-left, copy button, revoke button. Revoke is a plain RLS update.

**Guest UI** (`docs/views/guest.html` + `docs/js/guest.js` + `mountGuest` in `app.js`)
- New `#/guest/<token>` route. Auth bypass: `render()` short-circuits before the session check; `body.guest-mode` hides the topbar nav and email pill via CSS. Tabs: Cellar / Pair / Flight / Sommelier. Cellar tab reuses the same filter chips + sort UI as the owner cellar; bottle rows and pick cards open a modal showing the sanitized fields (anon clients can't hit `/bottle/:id` — that route queries via RLS).
- AI flow polls `cellar27_share_get_response` on a 2 s loop, 5 min cap (matches the owner-side `waitForResponse` shape — anon clients can't subscribe to RLS-protected tables via Realtime, so polling beats the alternative of broadening Realtime publication scope).
- Banner reads "Shared cellar · N requests left" — quota refreshes after each successful submit.

**Cross-cutting**
- Recommendation renderers (owner + guest): narrative now leads, picks follow. All bottle cards/rows are clickable — owner → `/bottle/:id`, guest → modal.
- `docs/sw.js` SHELL list adds `views/share.html`, `views/guest.html`, `vendor/qrcode.min.js` so the guest landing works offline-after-first-load.
- `docs/version.js`: `0.9.1` → `0.9.5`. Bundle rebuilt.

### Decisions
- **Per-link AI cap, not "draws from owner quota"**: a leaked link should not be able to drain the owner's daily Claude allowance. Owner picks both TTL and quota at creation; both are clamped server-side.
- **Revoke-on-create over multiple-active-links**: the simplest mental model. A small revoke button in the active-link panel covers the "share, then immediately regret it" case.
- **No real `auth.users` row for guests**: avoids polluting the user table and the allowlist with throwaway accounts; sidesteps the lack of native TTL on Supabase auth users. The token-in-table + SECURITY DEFINER pattern is the same shape `ARCHITECTURE.md` already documented.
- **Bypass owner allowlist + 100/hr rate limit on guest inserts**: enforced inside `cellar27_share_create_pairing_request`, which is the only path. Guests are intentionally on a separate budget. The watcher's global 250/day Claude ceiling still applies.
- **Sanitized snapshot in SQL, not "trust the frontend"**: the `cellar_snapshot` jsonb the watcher will see is built inside the RPC, so a future client bug can't accidentally include `acquired_price`.
- **Vendored qrcodejs, not a CDN**: the QR encodes a URL that includes a private token. A third-party CDN would have access to it on every render.

### Followups (logged in `HANDOFF_QUEUE.md`)
- None for v0.9.5 itself — owner has already applied 0008 / 0009 / 0010.
- Migrations 0006 + 0007 (search-path hardening + claimed_by invariant) still pending from v0.9.0 / v0.9.1.

### Next task
Owner finishes the v0.9.0 / v0.9.1 migration apply (0006, 0007) and restarts the watcher.

---

## 2026-04-30 (late PM) — v0.9.1: autoEnrich UX + innerHTML XSS audit

### Built

Three of the four "worth doing" items from the deferred audit list. The fourth (PWA screenshots) needs real raster captures from a phone — queued for the owner.

**autoEnrich error UX** ([`docs/js/app.js`](docs/js/app.js))
- New `enrichFailures` Map tracks the most recent enrichment failure per bottle. `autoEnrich()` records failures (both thrown errors and "no details returned" responses) into this map and triggers a re-render if the user is on the affected bottle's detail page.
- The detail-page button changes shape based on state: `Fetching sommelier notes…` while in flight, **`Retry sommelier notes`** (with the error message in the `title` attribute) when failed, `Refresh details` / `Get details` otherwise.
- Toast fires on failure if the user is on the affected bottle, so they know without scrolling.
- Closes the spinner-forever bug — previously `autoEnrich` only logged to `console.warn`, leaving the user staring at "Fetching sommelier notes…" indefinitely.

**innerHTML XSS audit** ([`docs/js/app.js`](docs/js/app.js))
- Walked every `.innerHTML =` site in `app.js` (no other JS file uses it; verified via grep across `docs/js/`). 30+ sites in total.
- Three real findings, all fixed:
  - Line 220 (`mountCellar`): `${e.message}` interpolated raw on the error path → now `escapeHtml`'d.
  - Line 825 (`mountDrinkNow`): same pattern → now `escapeHtml`'d.
  - Lines 1280–1281 (`renderBottleDetailHTML`): label-thumbnail `src=` attributes were interpolating Supabase signed URLs raw while the sibling `data-zoom=` attributes were using `escapeAttr`. Practically safe (signed URLs are URL-encoded), but the inconsistency is a foot-gun. Now both sides use `escapeAttr`.
- Added a comment above `escapeHtml` documenting the rule for future edits: anything from DB / Error / API / user input must go through `escapeHtml` (text) or `escapeAttr` (attribute); internal constants and verified-safe values (UUIDs, integers, fixed enum strings) can interpolate directly; markdown narrative goes through `markdownLite` which escapes first.
- Other 27+ sites were verified safe — they use `escapeHtml` / `escapeAttr` consistently, render only internal constants, or render UUIDs/integers from the DB which contain no HTML-special chars.

**SQL data-integrity invariant** ([`supabase/migrations/0007_claimed_by_invariant.sql`](supabase/migrations/0007_claimed_by_invariant.sql))
- Added CHECK constraint on both `pairing_requests` and `scan_requests`: `status <> 'picked_up' OR claimed_by IS NOT NULL`. The watcher already honors this in practice (sets `claimed_by = hostname()` in the same atomic update that flips status to `'picked_up'`, and clears it on stale-claim retry); this just locks the invariant in so a future code path or a service-role hand-edit during debugging can't leave a row in a half-claimed state.
- Added `NOT VALID` so the migration applies cleanly even if any legacy row pre-dates the invariant. Footer comment shows the optional `VALIDATE CONSTRAINT` step to upgrade to fully enforced once any legacy rows are cleaned up — safe to run with the watcher up since it only takes a SHARE UPDATE EXCLUSIVE lock.

**Bundle**
- Rebuilt: 49.4 KB minified (was 46.0 KB at v0.9.0). 3.4 KB growth from the new failure-tracking + retry-button code paths and the audit comment.
- `docs/version.js`: `0.9.0` → `0.9.1`.

### Decisions
- **Skipped PWA screenshots**: needs actual phone screenshots in PNG; no way to auto-generate. Queued for the owner with file naming + dimensions in HANDOFF_QUEUE.
- **Kept the audit comment near `escapeHtml`** instead of writing a `setSafeHTML(el, ...)` helper that callers must use. The current pattern (template literals with explicit `escapeHtml`/`escapeAttr` at each interpolation) is already the safest practical choice for this small file; a helper would create the illusion of safety without actually preventing a forgotten escape inside the template. The comment teaches the rule.
- **`NOT VALID` over fully-validated**: zero risk of breaking the migration on apply, full enforcement available via a one-line manual upgrade.

### Owner action required
1. Apply [`supabase/migrations/0007_claimed_by_invariant.sql`](supabase/migrations/0007_claimed_by_invariant.sql) in the Supabase SQL Editor (in addition to 0006 from the prior session).
2. Drop two phone screenshots into `docs/screenshots/` and wire them into the manifest if you want the install prompt UX boost.
3. Hard-refresh the PWA after the v0.9.1 banner appears.

---

## 2026-04-30 (PM) — v0.9.0: top-10 hardening / modernization batch

### Built

Curated punch list from a full audit of frontend / watcher / SQL — kept the items where the diff is small and the value is real, dropped the speculative ones (virtual scrolling, structured logging overhaul, broad innerHTML XSS audit). Plan in `~/.claude/plans/optimizations-modernixations-security-up-cached-kettle.md` if needed.

**Watcher security & robustness**
- [`watcher/src/agent.js`](watcher/src/agent.js): explicit env allowlist when spawning `claude`. Previously inherited the entire `process.env` — meaning every Claude session got `SUPABASE_SERVICE_ROLE_KEY`, `SMTP_PASS`, etc. it doesn't need. Now only `PATH`, `HOME`/`USERPROFILE`, OS shell essentials, and locale vars pass through.
- [`watcher/src/policy.js`](watcher/src/policy.js): LRU on the rate-limit map. Re-insert on every hit to refresh insertion order; evict oldest if size > 10 000. Closes a slow memory leak (one-time users' UUIDs lived forever).
- [`watcher/src/index.js`](watcher/src/index.js): fail-fast on realtime `CHANNEL_ERROR`/`TIMED_OUT`/`CLOSED`, on chokidar errors, on `unhandledRejection`, on `uncaughtException`. Pairs with the existing supervisor restart pattern. Graceful SIGINT/SIGTERM: tracks channel + watcher refs at startup, unsubscribes/closes on signal, then exits.

**Watcher performance**
- [`watcher/src/index.js`](watcher/src/index.js): scan-request image downloads now run in parallel via `Promise.all`. Two-image scans roughly halve in wall-clock time.

**SQL**
- [`supabase/migrations/0006_search_path_hardening.sql`](supabase/migrations/0006_search_path_hardening.sql): re-creates `cellar27_check_rate_limit`, `cellar27_sweep_stale_claims`, `cellar27_try_record_spawn` with `set search_path = pg_catalog, public` and fully schema-qualified table refs (`public.pairing_requests`, etc.). Best-practice hardening for `security definer` functions; closes the search-path-shadowing risk.

**Frontend**
- New root [`package.json`](package.json) with esbuild as dev dep + `npm run build:docs` script. Bundles [`docs/js/app.js`](docs/js/app.js) and its 6 imports into [`docs/js/dist/app.bundle.js`](docs/js/dist/app.bundle.js) — minified ESM, `target=es2022`, with sourcemap. ~46 KB minified vs ~83 KB raw across the original files.
- [`docs/index.html`](docs/index.html): `<script type="module">` now points at the bundle; the inline `onerror="this.remove()"` on `config.local.js` is gone.
- [`docs/js/app.js`](docs/js/app.js): `loadView()` uses an `AbortController`, aborts the previous fetch before starting a new one; the caller skips the assignment if the result is `null` (superseded). Bottom-of-file init now `await`s a JS-injected script tag for `config.local.js` (404s silently in production), keeping `index.html` free of inline event handlers — CSP-ready.
- [`docs/sw.js`](docs/sw.js): SHELL list collapses the seven `js/*.js` entries down to one `js/dist/app.bundle.js` entry.
- [`docs/version.js`](docs/version.js): `0.8.3` → `0.9.0`.

**Audit hygiene**
- esbuild pinned to `^0.25` (fixes the moderate-severity dev-server advisory; we don't run the dev server, but keeps `npm audit` clean).

### Decisions
- Bundle into a single ESM file rather than per-file minification: simpler `<script>` rewrite (one tag), simpler SW SHELL list, and esbuild's tree-shaking + minification work better across the whole graph.
- Sourcemap committed alongside the bundle so DevTools on phone still maps to original sources for debugging — adds ~135 KB but only fetched on demand.
- Fail-fast vs in-process retry for realtime errors: this watcher runs under a supervisor and is designed around long-lived restartability. Continuing in a half-broken state hides bugs; clean restart is the better default.

### Owner action required
1. Apply [`supabase/migrations/0006_search_path_hardening.sql`](supabase/migrations/0006_search_path_hardening.sql) in the Supabase SQL Editor.
2. Restart the watcher to pick up `agent.js` / `policy.js` / `index.js` changes.
3. Hard-refresh the PWA on phone after the v0.9.0 banner appears (existing manual update flow).

---

## 2026-04-28 — Phase 1 scaffold landed

### Built
- **Repo layout** chosen: monorepo in `mycellar` with `/frontend`, `/watcher`, `/supabase/migrations`. Planning docs at root.
- **Supabase migration** [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql): all 5 tables (`bottles`, `pairing_requests`, `pairing_responses`, `scan_requests`, `scan_responses`), RLS policies scoped to `auth.uid()`, `updated_at` trigger on bottles, `bottle-labels` Storage bucket with per-user prefix policies (insert/select/update/delete).
- **Frontend skeleton** ([`frontend/`](frontend/)): vanilla JS ES modules, no build step, Supabase JS v2 from CDN. Hash router, login gate, cellar grid, manual add-bottle form with live drink-window suggestion, drink-now bucketed view, tap-to-pour with undo toast.
- **Varietal lookup** ([`frontend/js/varietal-windows.js`](frontend/js/varietal-windows.js)): 35+ varietals + style fallbacks. Entries flagged `// TODO confirm` for Chat sign-off (see below).
- **Watcher stub** placeholder README pointing at BUILD_SPEC §2.
- **`.gitignore`** updated to exclude `frontend/config.local.js`, `.env*`, `node_modules`.

### Proposals — awaiting Chat confirmation

#### Color palette (proposed; STRATEGY.md says do not push to GH Pages until confirmed)

Spec's starting palette from BUILD_SPEC §1.3, applied as-is. Hex codes:

| Role | Hex | Notes |
|------|-----|-------|
| Background | `#1a0f0f` | Very dark oxblood |
| Surface | `#2d1818` | Card surface |
| Surface 2 | `#3a2020` | Subtle elevation step (added — spec didn't list one; needed for hover/border contrast) |
| Accent | `#8b1a1a` | Burgundy — primary buttons, active nav |
| Accent 2 | `#a83838` | Hover/border (added) |
| Highlight | `#d4a574` | Warm sand — section headers, drink-now badges |
| Text | `#f5e6d3` | Cream |
| Muted | `#b39d83` | Secondary text (added) |
| Error | `#e87474` | Soft red, distinct from burgundy accent |

Serif: Cormorant Garamond (with Georgia fallback) for the brand wordmark and headings — leaning into the wine-list aesthetic per spec. Sans: system stack for body.

**Open question for Chat:** OK to ship as-is? Specifically: is the burgundy accent (`#8b1a1a`) too dim against the dark oxblood background for primary buttons, or does the contrast feel right for this product?

#### Image upload params (HANDOFF_QUEUE item 5)

Per spec recommendation: **max 1600px long edge, JPEG quality 0.85**. Will resize client-side via canvas before upload to keep bandwidth low while preserving label legibility for vision. No further compression on the server. Confirm before Phase 3 implementation.

#### Varietal entries flagged `// TODO confirm` (HANDOFF_QUEUE item 3)

These are educated guesses from secondary sources; please validate or correct:

- **Barbera** — `[2,7]` peak `[3,5]` (Piedmont; varies by producer style)
- **Mourvèdre** — `[3,12]` peak `[5,10]`
- **Cabernet Franc** — `[3,12]` peak `[5,9]` (Loire vs. Bordeaux blends differ)
- **Petite Sirah** — `[3,15]` peak `[6,12]`
- **Rhône Blend** — `[3,15]` peak `[5,10]` (broad — Northern vs. Southern differ a lot)
- **Chenin Blanc** — `[1,12]` peak `[3,8]` (varies dramatically dry vs. sweet)
- **Gewürztraminer** — `[1,5]` peak `[2,4]` (off-dry Alsace can age longer)
- **Viognier** — `[1,4]` peak `[1,3]`
- **Grüner Veltliner** — `[1,6]` peak `[2,4]` (Smaragd-level can age 10+)
- **Sémillon** — `[2,10]` peak `[4,8]` (Hunter Valley ages much longer)
- **Cava** — `[1,5]` peak `[1,3]`
- **Sauternes** — `[5,30]` peak `[10,20]`
- **Sherry** — `[0,5]` peak `[0,3]` (very style-dependent — Fino vs. Oloroso vs. PX wildly different)
- **Ice Wine / Late Harvest** — `[2,15]` peak `[4,10]`

### Blockers / next actions
- **Supabase project not yet created.** Frontend can't run live until owner creates the project, runs `0001_init.sql`, and pastes URL + anon key into `frontend/config.local.js` (copied from `config.local.example.js`).
- **No `git push` yet.** Per STRATEGY constraint: do not push frontend until palette confirmed. Commits staged locally; awaiting Chat sign-off on the proposals above.
- **iOS Safari `getUserMedia` test** (HANDOFF_QUEUE item 4) — deferred to Phase 3 when scan UI is wired up; nothing camera-related in Phase 1.

### Expected next
Chat reviews this entry → confirms palette, image params, varietal flags → Code commits + (optionally) pushes → CURRENT_STATE flips back to Code for Phase 2 (the watcher).

---

## 2026-04-28 — Phase 1 verified live + auth UX fixes

After owner created the Supabase project (`mycellar`, ref `fksvvymeqvohyaestupo`), applied `0001_init.sql`, and set local config, sign-in/sign-up + add-bottle round-tripped successfully.

Fixed three bugs that surfaced during the live walkthrough:
1. **`[hidden]` attribute was being overridden** by `display: grid` on `.auth-view` — sign-in card stayed visible after login. Added `[hidden] { display: none !important; }`.
2. **Topbar was overflowing** — brand wordmark got covered by the active nav button. Added `flex-shrink: 0` to brand and `max-width + ellipsis` to the email display.
3. **Supabase v2 deadlock**: `onAuthStateChange` callback was calling `getSession()`, which tries to acquire the same lock `signInWithPassword` holds, causing sign-in to hang forever. Fix: pass session through from the callback instead of re-fetching, and defer the render to next tick via `setTimeout`. Also call `render()` directly after `signIn()` returns rather than depending solely on the listener.
4. Renamed `views/add-bottle.html` → `views/add.html` to match the route name.

---

## 2026-04-28 — Phase 2 landed: bridge watcher + pairing/flight/drink-now wiring

### Built — watcher (`watcher/`)

Node 20+ ES-module service. Single process, ~250 LOC.

- **[`src/index.js`](watcher/src/index.js)** — main loop. Subscribes to Postgres INSERT events on `pairing_requests` and `scan_requests`. Atomically claims pending rows (`status='pending' → 'picked_up'`) so a duplicate event can't double-process. Renders the request markdown into `<bridge>/requests/<file>.md`. For scans, downloads the label image from Supabase Storage to `<bridge>/images/<uuid>.<ext>` first.
- **chokidar** watches `<bridge>/responses/`. On any new `req-*.md` or `scan-*.md`: parses it, inserts into the matching `*_responses` table, marks the request `completed`, archives both files into `<bridge>/processed/`. Local image is deleted (Storage holds the durable copy).
- **Catch-up sweep on startup** picks up rows queued while the watcher was down.
- **Timeout sweep** runs every 60s — anything stuck `picked_up` for >`TIMEOUT_MINUTES` (default 10) flips to `status='error'` with a descriptive message.
- **[`src/render.js`](watcher/src/render.js)** — produces the markdown request files per BUILD_SPEC §2.2 / §2.2b. Cellar table is rendered with id + producer + wine + varietal + vintage + style + qty + drink window for pairing requests; without drink window for scan/pour requests.
- **[`src/parse.js`](watcher/src/parse.js)** — tolerant parser for Claude's response files. Handles frontmatter + ## sections + bullet/YAML-ish recommendation blocks. Extracts `bottle_id`, `confidence`, `reasoning`, `alternatives` for pairing; `extracted` scalars + `matched_bottle_id` + `match_candidates` for scan.

### Built — frontend bridge round-trip

- **[`frontend/js/pairings.js`](frontend/js/pairings.js)** — replaces the Phase 1 stubs. Snapshots the cellar (stripping `acquired_price` per STRATEGY constraint) into the request row, then opens a Realtime subscription on `pairing_responses` filtered by `request_id`. Also subscribes to UPDATE on the request itself to surface `status='error'` with `error_message`. Race-safe: after `SUBSCRIBED`, re-checks for an already-arrived response.
- **[`pairing.html`](frontend/views/pairing.html)** — dish + guests + occasion + constraints form
- **[`flight.html`](frontend/views/flight.html)** — theme + guests + length form
- **[`drink-now.html`](frontend/views/drink-now.html)** — keeps the local bucketed view, adds an "Ask the bridge" form below for AI-driven 1–3 picks
- **[`app.js`](frontend/js/app.js)** — three new mount handlers + a shared `renderRecommendations()` that renders bottle cards (resolving `bottle_id` against the live cellar so the data is fresh, not stale from snapshot) plus narrative markdown (minimal inline parser).

### Operational notes / things owner needs to do

- **Realtime publication**: in Supabase dashboard → Database → Replication → ensure `pairing_requests`, `scan_requests`, `pairing_responses`, `scan_responses` are enabled for the `supabase_realtime` publication. Not enabled by default. Without this, the watcher subscribes successfully but never receives events.
- **Service role key**: paste into `watcher/.env` (NEVER into the frontend). Settings → API in the Supabase dashboard.
- **Run the watcher on the VM**: see `watcher/README.md` — `npm install`, `npm start`. Recommended PM2.
- **Run Claude Code on the same VM**: with the prompt documented in `watcher/README.md`. Working dir = `<BRIDGE_DIR>` so it sees the `requests/` folder.
- **Scan flow remains stubbed** — that's Phase 3 (`getUserMedia` + camera UX + Storage upload). The watcher and schema are scan-ready though, so Phase 3 is purely frontend.

### Expected next
owner: deploy the watcher to the VM, enable Realtime publications, launch Claude Code with the bridge prompt, then do an end-to-end smoke test by submitting a pairing request from the frontend. Then either Phase 3 (scan UX) or polish (tasting log, mobile pass).

---

## 2026-04-28 — Phase 2 verified live + autonomous trigger

Deployed the watcher on this dev box (Win11) instead of the spec's home-lab VM — fastest path to a working round-trip. Realtime publications added via SQL (`alter publication supabase_realtime add table ...`) since the dashboard "Replication" UI was confusing (it primarily exposes paid read-replicas, not the free Postgres-changes publication).

First smoke test required a manual bridge-agent Claude Code session (user nudged "check requests/" each time). Worked end-to-end: pairing request submitted from browser → response card + narrative rendered, ~80 seconds.

### Autonomous trigger ([`watcher/src/agent.js`](watcher/src/agent.js))

Replaced manual nudging by spawning a fresh `claude --print` per request. Prompt is piped via stdin (avoids Windows quoting issues). `cwd = BRIDGE_DIR` so relative paths in the request file Just Work.

Important: do NOT pass `--bare`. It looks attractive (skips hooks/CLAUDE.md/etc for fast deterministic runs) but it ALSO disables keychain reads, so the spawned `claude` has no OAuth and exits with "Please run /login". Final flag set: `--print --permission-mode acceptEdits --no-session-persistence`.

Two consecutive autonomous round-trips: ~22s each, no human in the loop. Bridge-agent terminal no longer required.

Also confirmed: `AUTO_INVOKE=false` env var preserves the manual fallback for debugging request/response formatting drift.

### Operational shape now
- Watcher running in background (npm start) on this laptop
- Frontend served by `py -m http.server 8000` (background)
- Phone access not yet wired (still on `localhost`); GH Pages deploy + PWA wrapper queued
- Laptop must be awake for the watcher + agent to process; phone can read responses from Supabase even after laptop sleeps (Realtime still pushes to subscribed clients on next online window)

### Expected next
GH Pages deploy → PWA wrapper → phone-from-the-kitchen actually working. Phase 3 (scan UX) after.

---

## 2026-04-28 — Lockdown before going public

Concern: deploying to GH Pages exposes a public URL. Anyone could sign up → submit pairing requests → my watcher spawns Claude on my laptop for them. Defense in depth before publishing the URL.

### Layers

1. **Disable open sign-ups in Supabase** (Auth → Sign In / Providers → "Allow new users to sign up" OFF). Single-user system anyway. Done by owner.
2. **Watcher allowlist** ([`watcher/src/policy.js`](watcher/src/policy.js)): `ALLOWED_USER_IDS` env var, comma-separated UUIDs. Empty = open mode. Non-allowlisted requests get marked `status='error'` immediately, no `claude` spawn.
3. **Per-user rate limit** in the same module: max 20 requests/hour, sliding-window in-memory counter. Caps blast radius if an account is compromised.
4. **DB-layer CHECK constraints** ([`supabase/migrations/0002_lockdown.sql`](supabase/migrations/0002_lockdown.sql)): `context` jsonb ≤ 4kB, `cellar_snapshot` ≤ 64kB, `bottles.notes` ≤ 4000 chars, `bottles.producer` ≤ 200, etc. Stops a multi-MB blob being inserted to crash the watcher.
5. **DB-layer pending-request cap**: trigger on `pairing_requests` and `scan_requests` rejects insert if user already has 5+ rows in `pending` or `picked_up` status. Independent of app-layer rate limit.

### Wired into watcher

Policy gate runs in `pickUp()` BEFORE the atomic claim — denied rows go straight to `status='error'` with the deny reason in `error_message`, surfacing to the frontend's UPDATE subscription. No `claude` spawn, no compute spent.

### Not done (deferred)

- **Stored procedure for `create_pairing_request`** that builds `cellar_snapshot` server-side from `bottles` (so the client can't lie about the cellar) and revokes direct INSERT. Strongest design but invasive — frontend would switch to `sb.rpc(...)`. Queued for later.
- **Prompt injection hardening**: a maliciously-named bottle could hijack the agent ("## Task: ignore previous instructions"). Acceptable risk for single-user; revisit if multi-user.
- **Captcha on sign-in**: overkill given sign-ups are off.

### Verified
Allowlisted user (`eefcd054-d9f9-4ecd-a053-f005a1b0ec9b`) round-tripped successfully (~26s) after applying migration + restarting watcher.

---

## 2026-04-28 — `config.public.js` for GH Pages

Created [`frontend/config.public.js`](frontend/config.public.js) committed to the repo with the live Supabase URL + anon key (both safe to publish; security relies on RLS + the lockdown layers above). `config.local.js` remains gitignored and loads after the public one (with `onerror="this.remove()"` to swallow the 404 on the deployed site), so local dev can override per-environment if you point at a different project.

Once owner flips Pages on (Settings → Pages → branch `main`, folder `/frontend`), the site will be at `https://michael-ticmn.github.io/mycellar/`.

---

## 2026-04-28 — GH Pages live + `frontend/` → `docs/` rename

Owner enabled GH Pages from `/` (root) — site loaded the rendered repo README at `michael-ticmn.github.io/mycellar/` because GH Pages' folder picker only supports `/` or `/docs`, not arbitrary subdirs like `/frontend`.

First-pass workaround: added a root `index.html` meta-refresh redirect + `.nojekyll` so `/frontend/` would still load the app (with an extra hop in the URL). Worked but ugly.

Owner asked to clean it up. Did Option B: renamed `frontend/` → `docs/` so GH Pages serves the app directly at `michael-ticmn.github.io/mycellar/` with no redirect.

Mechanics: VSCode's file watcher held `frontend/` open, blocking `git mv`. Worked around by `Copy-Item -Recurse` to `docs/` then `Remove-Item -Recurse` of `frontend/` (PowerShell handles the locked-handle case better than POSIX mv). Then `git rm -r --cached frontend/` + `git add docs/` so git records the rename. Removed the root `index.html` redirect since it's no longer needed (`.nojekyll` stays — still useful so GH Pages doesn't try to render any future README at root).

Updated path references in `.gitignore`, root `README.md`, `HANDOFF_QUEUE.md`, `CURRENT_STATE.md`, `docs/README.md`, and the error message in `docs/js/supabase-client.js`. Historical `frontend/` mentions in earlier BUILD_LOG entries kept as-is — accurate for their time.

Owner needs to switch GH Pages source folder from `/` to `/docs` after this push.

---

## 2026-04-29 → 2026-04-30 — Phase 3 + security tuning + UX polish

A two-day stretch where Phase 3 shipped, the security plan landed, and a lot of UX rough edges got smoothed. Grouping by theme rather than commit (full record in `git log`).

### Scan flow (Phase 3)

- **`scan-add`**: front-label + optional back-label capture, Storage upload, scan_request round-trip, post-scan review form with AI-extracted producer/wine/varietal/vintage/region/style + AI enrichment (food pairings, tasting notes, serving recs). (v0.4.0)
- **`scan-pour`**: identify-from-photo with cellar context; matched bottle → "Pour this" button; multiple candidates → pick from a list. (v0.4.0)
- **Bottle detail** view: front + back thumbnails (lightbox on tap), structured details, actions (pour / edit / delete / fetch-or-refresh details).
- **Multi-bottle queue** (v0.6.0): submit a scan → return immediately to the intent stage to scan the next; tray below the buttons shows in-flight + ready entries; tap ready → review form with merge prompt; up to 5 in flight (gated to match the existing DB trigger). All queue state in-memory, cleared on reload.
- **Scan-add detects duplicate** (v0.5.2) on Save and offers merge (qty+1, opportunistically fill missing photos/details) vs separate row.

### Security — P0/P1 plan landed, then re-tuned for actual use

P0/P1 in `0004_security_p0_p1.sql` ([ca1dfcf](https://github.com/Michael-ticmn/mycellar/commit/ca1dfcf)):

- **P0-1**: allowlist moved from watcher env into RLS via `cellar27_allowed_users` + `WITH CHECK` clauses on `pairing_requests` / `scan_requests`. Watcher allowlist kept as redundant backstop.
- **P0-2**: per-user rate limit (`cellar27_check_rate_limit`) into the same RLS clause; index on `(user_id, created_at desc)` to keep the count fast.
- **P0-4**: `claimed_by` (hostname) + `retry_count` columns; `cellar27_sweep_stale_claims` resets timed-out `picked_up` rows back to `pending` for up to 2 retries before marking them `error`. Watcher calls it via RPC every 2 min and re-picks up retried rows.
- **P1-1**: `cellar27_watcher_metrics` table + `cellar27_try_record_spawn(p_max)` atomic upsert. Watcher checks before every `claude --print` spawn.

Tier 1 + Tier 2 re-tune ([507a778](https://github.com/Michael-ticmn/mycellar/commit/507a778), `0005_security_tune.sql`):

- DB rate limit default 20 → 100/hr; watcher in-memory rate limit 20 → 100/hr (env-tunable via `WATCHER_RATE_LIMIT_PER_HOUR`); daily ceiling default 100 → 250. The original numbers were tuned for a hostile-key abuse scenario and bottlenecked legitimate bulk-add inventorying.
- `watcher/src/notify.js` (new): nodemailer + SMTP. Watcher calls `notify()` on policy denial and ceiling refusal; per-key cooldown so a runaway loop can't flood the inbox. Gmail SMTP via App Password verified end-to-end with a real test send.

Documentation pass:

- **`docs/SECURITY.md`** (new) — one place for the limit table, where each layer enforces, and a tune/bypass cookbook. ARCHITECTURE.md "Security shape" unstaled (was still describing the rate limit and allowlist as living in the watcher).

### PWA caching — the long-tail of "version updated but UI didn't change"

Three layered fixes after a sequence of "I had to clear data" reports:

1. **`updateViaCache:'none'` on register** (v0.6.6) — bypasses HTTP cache for `sw.js` AND its `importScripts` so version-bump detection works.
2. **`cache:'reload'` on each addAll fetch in install** (v0.7.3) — bypasses HTTP cache for every SHELL asset on install, so the new SW doesn't cache stale CSS/views even after it installs successfully.
3. **In-app "Update ready" banner** (v0.7.1) — replaces silent auto-reload with a user-tappable Reload button. Drops `self.skipWaiting()` from install so the new SW enters `waiting`, lets the page show the banner, and only activates on user tap (which posts `skipWaiting`). Belt-and-braces against iOS Safari PWA's occasional failure to auto-reload after `controllerchange`.

### UX polish

- **Cellar list view as default** + List/Card toggle (v0.8.0). Compact rows with a style-colored 4px left edge; ~6–8 bottles per phone screen vs 2 in the old card grid. Toggle persists in localStorage. Card view kept for the photo grid.
- **Icon-only nav** (v0.7.5–0.7.7). Bottle (Manage), glass+plate (Pair), 3 glasses (Flight), tipped wine glass (Drink now). Touch target sized for mobile.
- **Merge Add + Scan into Manage** (v0.7.0). 2-column grid: Add a bottle [Scan label / Enter manually] · Pour a bottle [Scan to identify / Pick from cellar]. `#/scan` route alias kept for old PWA shortcuts.
- **Read-aloud on every narrative** (v0.8.2) via SpeechSynthesis API. Speaker icon next to each AI-generated narrative; click again to stop; cancels on navigation. **Voice + speed picker** (v0.8.3) behind a ▾ caret — single shared popover with a voice radio list (English-filtered by default, with a "show all" toggle), 0.7–1.3× rate slider, Test button. Selection persists in localStorage; falls back to default if the saved voice isn't available on the current device.
- **Pour-loader** (v0.8.1) — tilted SVG bottle dripping drops into a wine glass that fills, holds, then drains, on a 2.4s loop. Replaces the plain text "Asking your sommelier…" wherever we wait on Claude. Pure SMIL animation, no JS lifecycle.
- **Capture button** (v0.7.6): big round and centered (camera-app feel) instead of left-aligned default flex.
- **Wine-glass icon tilted -45°** (v0.7.4) — earlier 90° read as flat; -45° reads "tipped/knocked over."
- **Sommelier rename** + wine-color tinted bottle cards + flight extras suggestions (v0.5.0).
- **Quick wins**: edit bottle, cellar search/filter/sort + style chips, photo lightbox on tap, auto-enrich on save (v0.5.3).
- **Drink-now reorder** (v0.6.4): "Ask your sommelier" surfaced above the local peak-window list.
- **Sign-out button removed** (v0.6.5): single-user app, never tapped, just stole topbar space.
- **App version label in topbar** (v0.6.1) — `vX.Y.Z` next to the brand so we can eyeball whether the SW has swapped.

### Repo / docs

- **MIT License** added.
- **ARCHITECTURE.md** — one-page request lifecycle, plus a colored printable PDF version (`docs-pdf/architecture.html` / `.pdf`) sized to landscape letter.
- **Watcher runtime** — README updated to reflect the actual deployment shape (detached background `node.exe` started via `Start-Process -WindowStyle Hidden`, logs to `watcher/watcher.out.log` / `.err.log`, gitignored). No PM2, no service, no scheduled task.

### Decisions worth flagging

- **Why detached `node.exe` and not PM2 / a service**: this is a personal-use app on the owner's primary device. PM2 was overkill; a hidden background process started from a one-liner PowerShell snippet is simpler and survives terminal closing.
- **Why in-memory scan queue (not localStorage-persistent)**: simplest path to ship; on reload the queue clears but the underlying `scan_request` rows still complete in Postgres. A future "unreviewed responses" view could pick them up if this becomes a problem in practice. So far it hasn't.
- **Why limits raised to 100/hr + 250/day instead of building approval-via-email**: cost/benefit. For a single-user app, raising limits to fit normal use achieves the same practical outcome as an approval workflow with zero new moving parts. Tier 3 (HMAC-signed approval links + Edge Function + grants table) was scoped but deferred until there's actually a multi-user shape that needs it.

### Next session

No assigned next task. Owner driving feature requests. Optional cleanup item in HANDOFF_QUEUE: write the security smoke test that was scoped in P1-3.

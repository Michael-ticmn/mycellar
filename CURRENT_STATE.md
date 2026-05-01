# cellar27 — CURRENT_STATE.md

## As of 2026-05-01 (v0.10.0 — planned flights + guest plan view)

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
- **Planned flights** (`#/planned`): owner saves a flight builder result via a "Save this flight" button, gets a sommelier-generated food (3–5 options) + per-bottle prep (chill / breathe / decant note / glassware / notes) plan, editable inline. List view groups Upcoming / Undated / Past by `occasion_date`. Picks + narrative are captured at save time so they survive bottle deletion. Backed by the new `planned_flights` table (RLS, user-scoped) and `request_type='flight_plan'` AI requests that write `{food, prep}` into `pairing_responses.payload`.
- **Guest plan view** (`#/guest/<token>` Tonight tab): owner attaches one planned flight to their currently active share link; guests visiting the link land on a read-only walkthrough — welcome intro, food on offer, and a per-pour guide (what to look for, food cue with timing, transition to next pour). Walkthrough copy comes from a new `request_type='flight_guest'` that runs as the owner — does NOT consume the share-link AI quota. Lifetime + revoke ride on the existing `share_links.expires_at / revoked_at`. New anon RPC `cellar27_share_get_planned_flight(token)` projects only safe columns (no price / notes / storage / user_id leak).
- **Guest sharing** (`#/share`): owner generates a short-lived, mobile-friendly link with a QR. Guests browse the cellar and run pair / flight / ask-sommelier without an account; price / notes / storage / label fields are stripped server-side. Per-link AI budget (independent of the owner's 100/hr quota), owner-picks-TTL at creation, one active link at a time, generating a new link revokes the prior. SECURITY DEFINER RPCs over an `anon` client; RLS on `bottles` and `pairing_requests` untouched.

**Recently shipped (v0.10.0 — guest plan view):**
- New SQL migration [`0013_guest_plan_view.sql`](supabase/migrations/0013_guest_plan_view.sql): `planned_flights.shared_via_link_id` (FK to share_links), `planned_flights.guest_view jsonb`, partial unique index enforcing one-plan-per-link, `request_type='flight_guest'` added to the check constraint, and `cellar27_share_get_planned_flight(p_token text)` SECURITY DEFINER RPC granted to `anon`.
- New owner UI on the planned-flight detail page: Guest view section with three states (no active link → nudge to /share; active link not attached → "Show this plan to guests"; attached → "Generate guest walkthrough" + share URL + "Hide from guests").
- New guest UI: hidden Tonight tab in [`docs/views/guest.html`](docs/views/guest.html); `mountGuest()` calls the new RPC on mount, surfaces the tab as the default when a plan is attached, and renders a tinted-by-style pour-block layout for the walkthrough.
- Watcher: new `flight_guest` task body in [`watcher/src/render.js`](watcher/src/render.js) — produces structured `{guest_intro, pour_walkthrough[]}` JSON via the existing `## Plan` parser path. Speaks directly to the guest, references kept food by name, omits host-side prep details.

**Recently shipped (v0.9.9–v0.9.13 — planned flights + polish):**
- v0.9.9: planned flights MVP — new `planned_flights` table + RLS (migration 0012), `pairing_responses.payload` jsonb column, `request_type='flight_plan'`, "Save this flight" button on flight builder results, `#/planned` list + detail/edit views with inline-editable food and prep. Refactored the pairing transport (`createRequest` / `waitForResponse`) into a shared [`docs/js/pairing-bus.js`](docs/js/pairing-bus.js) for reuse by `planned-flights.js`.
- v0.9.10: planned-flight prep table now stacks per-row on mobile (no left/right scroll); food list framed as options to choose from, not a multi-course menu; nav reordered (Planned moved to the end after Share).
- v0.9.11: food items render as stacked cards (kind + name + remove button on top, full-width description textarea below) — no horizontal overflow on any viewport.
- v0.9.12: clearer prep table — column headers carry units ("Chill (min)", "Breathe (min)"); decant becomes a sommelier badge under the bottle name (no longer a user-editable checkbox); renamed "Open" → "Breathe" with a hint above the table.
- v0.9.13: "Other notes" in prep is now a heading + inline contenteditable region styled like the Narrative block — no boxed textarea, italic placeholder, dashed underline on focus, persists on blur.

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
- Apply migration [`0013_guest_plan_view.sql`](supabase/migrations/0013_guest_plan_view.sql) in the Supabase SQL Editor (0006–0012 already applied).
- Optional: drop two phone screenshots into `docs/screenshots/` and wire into the manifest for a richer install prompt.

**What's broken / incomplete:**
- Watcher runs on the owner's primary device, not an always-on host. Sleep = no AI processing during the sleep window. Acceptable for personal use.

**Immediate next action:** owner applies migration 0013 (watcher already restarted with the `flight_guest` task body).

**Which surface should act next:** owner.

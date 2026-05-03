# cellar27 — CURRENT_STATE.md

## As of 2026-05-02 (v0.12.0 — preserve food/notes intent on planned flights)

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
- **Guest sharing** (`#/share`): owner generates a short-lived, mobile-friendly link with a QR. Guests browse the cellar and run pair / flight / ask-sommelier without an account; price / notes / storage / label fields are stripped server-side. Per-link AI budget (independent of the owner's 100/hr quota), owner-picks-TTL at creation, one active link at a time, generating a new link revokes the prior. SECURITY DEFINER RPCs over an `anon` client; RLS on `bottles` and `pairing_requests` untouched. Guest bottle modal now surfaces the same sommelier enrichment (tasting notes / food pairings / producer / region / serving) the owner sees, via the widened `cellar27_share_list_bottles` RPC. Guest flight builder also takes the same Food + Notes inputs the owner has so guests can shape the flight by what they're eating.
- **Guest → host channel** (`#/share` Guest activity feed): guests can send AI results (Pair / Flight / Sommelier) and per-pour notes from Tonight back to the host. First share prompts for an optional display name (stored in localStorage); subsequent sends auto-fill. Host sees activity grouped by tasting (active link expanded at top, prior tastings collapsed under a date label) and split into "Suggestions sent back" + "Event comments" buckets. Each guest-sent flight result has a "Save as planned flight" button that pre-fills title with the guest's name + theme + food and fires the same flight_plan AI enrichment as the host's own Save flow. Activity persists across share-link expiry. Small unread pip on the Share nav icon clears once the host visits the page. Backed by a new `guest_messages` table (RLS-gated for hosts) and `cellar27_share_create_message` SECURITY DEFINER RPC for guests. No AI cost — these are persisted records, not new pairing requests.
- **Food/notes intent preserved end-to-end on planned flights**: anything typed in the Food or Notes field on the flight builder (host's or guest's) is captured on the planned_flight as `food_hint` / `notes_hint`, surfaced in an "Original ask" block on the detail page, and threaded into the flight_plan AI request so the model anchors its food suggestions on the host's actual ask (e.g. caviar shows up as the first item in the food array, not lost to a generic suggestion list).

**Recently shipped (v0.12.0 — preserve food/notes intent end-to-end):**
- New SQL migration [`0015_planned_flight_intent.sql`](supabase/migrations/0015_planned_flight_intent.sql): two nullable text columns on `planned_flights` — `food_hint` and `notes_hint`. Captured at save time, never overwritten by AI enrichment.
- [`docs/js/planned-flights.js`](docs/js/planned-flights.js): `createPlannedFlight` accepts and persists both hints; `requestFlightPlanEnrichment` includes them in the watcher context so the AI honors them.
- [`docs/js/app.js`](docs/js/app.js): host's own Save flow (`wireSaveFlight`) and the Guest-activity Save-as-planned-flight flow (`promoteGuestFlightToPlanned`) both forward food/notes from their respective contexts. Detail page renders an "Original ask" block above the editable food/prep so the host always sees what was originally asked, even after editing.
- [`watcher/src/render.js`](watcher/src/render.js): `flight_plan` task body now appends a conditional ORIGINAL ASK block — instructs the model to include `food_hint` as the FIRST item in the food array (with appropriate kind + pairing-grounded description) and to honor `notes_hint` as a constraint on both food and prep choices. Without hints the prompt behaves exactly as before.

**Recently shipped (v0.11.1 → v0.11.3 — flight + activity polish):**
- v0.11.1: defaulted the flight builder Theme to "Surprise me" (top of the dropdown) on both owner and guest forms.
- v0.11.2: "Save as planned flight" button on every guest-sent flight result in /share Guest activity. Mirrors the host's own Save flow; title auto-set to "From {guest} · {theme} · with {food}".
- v0.11.3: Guest activity now persists across share-link expiry/revoke. Renders all of the host's tastings grouped by share_link_id (active first/expanded, prior collapsed under date-labeled `<details>`) and split into "Suggestions sent back" + "Event comments" buckets within each tasting. Two new helpers in [`docs/js/share.js`](docs/js/share.js): `listAllOwnerShareLinks` and `listAllOwnerGuestMessages` (direct queries — RLS does the auth).

**Recently shipped (v0.11.0 — guest → host channel):**
- New SQL migration [`0014_guest_messages.sql`](supabase/migrations/0014_guest_messages.sql): `guest_messages` table with RLS (`for select` keyed on `share_links.owner_user_id = auth.uid()`), and `cellar27_share_create_message(token, guest_name, kind, payload)` SECURITY DEFINER RPC granted to `anon` (validates token + caps payload at 32 KB + constrains kind to `'ai_result' | 'pour_note'`).
- New owner UI: Guest activity section on the Share page rendering the messages newest-first; AI-result cards reuse `narrativeBlockHTML()` for the embedded narrative; pour-note cards link to `#/planned/<id>`. Small unread badge on the Share nav icon (`refreshShareNavBadge` runs on every route change, polled — no realtime).
- New guest UI: "Send this to the host" button appended to every guest AI result via `renderGuestRecommendations({ token, requestType, context })`; "Send a note to the host" affordance on every Tonight pour block. localStorage key `cellar27.guestName` for one-tap subsequent sends.

**Recently shipped (v0.10.1 → v0.10.3):**
- v0.10.1: fixed transparent guest bottle-detail modal (`var(--surface-1)` was undefined; switched to `--surface` and added a soft shadow).
- v0.10.2: guest bottle modal now shows the same depth as the owner detail page (sommelier enrichment block via the same `renderDetailsHTML()` helper); flight builder gained two optional inputs (Food + Notes) that the watcher's flight task body uses to weight picks.
- v0.10.3: guest flight builder mirrors the owner's Food + Notes inputs so guest-spawned flights get the same context-aware picks.

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
- Optional: apply migrations 0006 + 0007 (security hardening) in the Supabase SQL Editor.
- Optional: drop two phone screenshots into `docs/screenshots/` and wire into the manifest for a richer install prompt.

**What's broken / incomplete:**
- Watcher runs on the owner's primary device, not an always-on host. Sleep = no AI processing during the sleep window. Acceptable for personal use.

**Immediate next action:** none — food/notes intent preservation is live (0015 applied 2026-05-02; watcher restarted with the ORIGINAL ASK prompt block). Owner is testing the end-to-end caviar-style scenario on the phone.

**Which surface should act next:** owner (test on phone).

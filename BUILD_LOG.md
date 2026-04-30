# cellar27 — BUILD_LOG.md

(Code appends entries here at the end of every meaningful work session. Format: dated entry with what was built, decisions made, blockers, and the expected next task.)

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

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
- **Supabase project not yet created.** Frontend can't run live until Michael creates the project, runs `0001_init.sql`, and pastes URL + anon key into `frontend/config.local.js` (copied from `config.local.example.js`).
- **No `git push` yet.** Per STRATEGY constraint: do not push frontend until palette confirmed. Commits staged locally; awaiting Chat sign-off on the proposals above.
- **iOS Safari `getUserMedia` test** (HANDOFF_QUEUE item 4) — deferred to Phase 3 when scan UI is wired up; nothing camera-related in Phase 1.

### Expected next
Chat reviews this entry → confirms palette, image params, varietal flags → Code commits + (optionally) pushes → CURRENT_STATE flips back to Code for Phase 2 (the watcher).

---

## 2026-04-28 — Phase 1 verified live + auth UX fixes

After Michael created the Supabase project (`mycellar`, ref `fksvvymeqvohyaestupo`), applied `0001_init.sql`, and set local config, sign-in/sign-up + add-bottle round-tripped successfully.

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

### Operational notes / things Michael needs to do

- **Realtime publication**: in Supabase dashboard → Database → Replication → ensure `pairing_requests`, `scan_requests`, `pairing_responses`, `scan_responses` are enabled for the `supabase_realtime` publication. Not enabled by default. Without this, the watcher subscribes successfully but never receives events.
- **Service role key**: paste into `watcher/.env` (NEVER into the frontend). Settings → API in the Supabase dashboard.
- **Run the watcher on the VM**: see `watcher/README.md` — `npm install`, `npm start`. Recommended PM2.
- **Run Claude Code on the same VM**: with the prompt documented in `watcher/README.md`. Working dir = `<BRIDGE_DIR>` so it sees the `requests/` folder.
- **Scan flow remains stubbed** — that's Phase 3 (`getUserMedia` + camera UX + Storage upload). The watcher and schema are scan-ready though, so Phase 3 is purely frontend.

### Expected next
Michael: deploy the watcher to the VM, enable Realtime publications, launch Claude Code with the bridge prompt, then do an end-to-end smoke test by submitting a pairing request from the frontend. Then either Phase 3 (scan UX) or polish (tasting log, mobile pass).

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

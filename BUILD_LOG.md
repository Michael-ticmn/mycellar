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

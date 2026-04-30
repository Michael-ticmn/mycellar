# cellar27 — HANDOFF_QUEUE.md

## Pending

- [ ] [FROM: Code → Code, optional] Write `scripts/security-smoke-test.mjs` (was P1-3 in the original security plan; never built). Should exercise: allowlist rejection for non-members, rate-limit rejection past N, in-flight cap rejection past 5, daily-ceiling refusal — all without spawning Claude for blocked requests.

## Completed

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

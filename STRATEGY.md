# cellar27 — STRATEGY.md

## Current Direction
Build a personal wine cellar app: catalog bottles, get pairing suggestions, build tasting flights for small groups, track drink-by windows. Same stack as play27/grow27. Pairing/flight intelligence routes through Claude Code via a Supabase-backed message bus, mirroring the Master Todo handoff pattern.

## Confirmed Decisions

### Product
- **Name:** cellar27
- **Audience:** owner personally, plus occasional small-group tastings for guests
- **Scope v1:** catalog + pairing suggestions + tasting flight builder + drink-by dates (all four)

### Stack
- **Frontend:** Static HTML/CSS/JS hosted on GitHub Pages at `michael-ticmn.github.io/cellar27` (consistent with play27/grow27)
- **Auth + DB:** Supabase (consistent with play27/grow27)
- **AI reasoning:** Claude Code on the home lab Win11 VM, via file-drop bridge
- **Bridge transport:** Supabase Realtime (Path A — works from any device, no Tailscale dependency for the bridge itself)

### Bridge Architecture
```
cellar27 (browser)
  ↓ insert row
Supabase: pairing_requests
  ↓ Realtime subscription
VM watcher (Node, runs alongside Claude Code on win11)
  ↓ writes file
~/cellar27-bridge/requests/req-{uuid}.md
  ↓ Claude Code auto-monitors folder, reasons, writes
~/cellar27-bridge/responses/req-{uuid}.md
  ↓ watcher detects new file, uploads
Supabase: pairing_responses
  ↓ Realtime subscription
cellar27 displays result
```

### Data model decisions
- **Cellar snapshot in request:** request rows include a JSON snapshot of the cellar at request time. Self-contained, debuggable, cheap.
- **Catalog stays in Supabase:** bottles are the system of record; bridge tables are ephemeral message-bus rows.
- **Drink-by:** auto-suggested from a varietal/style lookup table, user-overridable per bottle (`drink_window_overridden` flag).

### Recommendation counts
- Pairing requests: 1–2 bottles
- Flight requests: 3–5 bottles
- Drink-now requests: 1–3 bottles entering or in peak window

### Scan / photo capture
- **Every bottle gets a label photo.** Scan IS the add flow. Manual entry exists as fallback but is not the default path.
- **Vision via the bridge.** Photo uploads to Supabase Storage. Watcher downloads to local path, Claude Code reads the image and returns structured wine metadata.
- **No scan cache.** Every scan goes through the bridge fresh. The photo itself is the durable artifact attached to the bottle row, used for visual browsing in the cellar view.
- **Two intents, one mechanism.** `intent: 'add'` creates a new bottle row after user reviews extracted fields. `intent: 'pour'` matches against existing cellar and decrements quantity by 1.
- **Pour has a tap fallback.** When at the laptop, bottle card → "Pour" button → -1 with undo toast. No camera. Scan is for when you're at the rack/wherever the bottles live.

### Bridge folder layout
- `~/cellar27-bridge/requests/req-{uuid}.md` — watcher writes, Code reads
- `~/cellar27-bridge/responses/req-{uuid}.md` — Code writes, watcher reads
- `~/cellar27-bridge/processed/` — watcher moves completed pairs here for audit

## Open Questions (for Chat to resolve later)
- Should we add a "tasting log" feature post-v1 (notes on bottles after drinking them, to feed back into future suggestions)?
- Mobile UX — does cellar27 need a separate phone-optimized view or does responsive web cover it?
- Should pairing requests support image upload (snap a menu, get a recommendation)? Defer to v2.
- Multi-user: any reason guests at a tasting need read-only links to the flight Claude built? Probably yes eventually, defer.

## Constraints Code must respect
- **No Anthropic API key in app code.** All AI reasoning routes through Claude Code on the VM via the bridge.
- **GitHub Pages = static only.** No server-side code in the frontend repo. All dynamic behavior via Supabase client SDK.
- **Brand consistency with play27/grow27.** Reuse the visual language already established. Dark theme acceptable but cellar27 may benefit from a warmer palette (deep red/burgundy accents) — Code should propose a palette in the BUILD_LOG and let Chat confirm.
- **Tailscale not required for end users.** The whole point of Path A is that cellar27 works from a phone in the kitchen without VPN.
- **Watcher must run unattended on the VM.** Use PM2 or a Windows scheduled task. Document the setup in the watcher repo README.
- **No PII or sensitive data in pairing_requests.** Cellar contents only. Acquired_price is fine but should not be sent into the bridge unless explicitly relevant.
- **Label images are user-private.** Storage bucket policies must enforce per-user access. Watcher uses a signed URL or service-role download; never expose images publicly.
- **Vision requests carry a local file path, not the Supabase URL.** The watcher downloads the image to a path under `~/cellar27-bridge/images/` and references that local path in the request file. Cleanup after processing.

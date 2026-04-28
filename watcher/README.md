# cellar27-watcher

**Phase 2 — not yet implemented.** See [BUILD_SPEC.md §2](../BUILD_SPEC.md) for the full design.

Will be a Node 20+ service running on the win11 home-lab VM under PM2. Subscribes to Supabase Realtime on `pairing_requests` and `scan_requests` (status='pending'), renders request files into `~/cellar27-bridge/requests/`, watches `~/cellar27-bridge/responses/` for Claude Code's replies, and uploads results back to Supabase.

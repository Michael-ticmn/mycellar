# cellar27 — how a request travels

```
┌──────────────┐                                                ┌────────────────┐
│  PHONE       │                                                │  LAPTOP        │
│ (Safari /    │                                                │ (always-on)    │
│  PWA)        │                                                │                │
│              │       ① INSERT pairing_request                 │                │
│  Tap "Pair"  │ ─────────────────────────────────┐             │                │
│              │                                  ▼             │                │
│              │                          ┌──────────────┐      │                │
│              │                          │              │      │                │
│              │                          │   SUPABASE   │      │                │
│              │                          │  (Postgres + │      │                │
│              │   ⑤ Realtime push        │   Realtime)  │      │                │
│ Card +       │ ◀───────────────────┐    │              │      │                │
│ narrative    │                     │    │              │      │                │
│ renders      │                     │    │              │      │                │
└──────────────┘                     │    │              │      │                │
                                     │    │              │      │                │
                                     │    │              │ ──── │ ② Realtime push│
                                     │    │              │      │                │
                                     │    │              │      │ ┌────────────┐ │
                                     │    │              │      │ │  watcher   │ │
                                     │    │              │      │ │  (Node)    │ │
                                     │    │              │      │ └─────┬──────┘ │
                                     │    │              │      │       │ writes │
                                     │    │              │      │       ▼ md     │
                                     │    │              │      │ ~/cellar27-    │
                                     │    │              │      │   bridge/      │
                                     │    │              │      │   requests/    │
                                     │    │              │      │       │        │
                                     │    │              │      │       ▼ spawn  │
                                     │    │              │      │ ┌────────────┐ │
                                     │    │              │      │ │ claude     │ │
                                     │    │              │      │ │ --print    │ │
                                     │    │              │      │ └─────┬──────┘ │
                                     │    │              │      │       │ writes │
                                     │    │              │      │       ▼ md     │
                                     │    │              │      │ ~/cellar27-    │
                                     │    │              │      │   bridge/      │
                                     │    │              │      │   responses/   │
                                     │    │              │      │       │        │
                                     │    │              │      │       │ chokidar
                                     │    │              │      │       ▼        │
                                     │    │              │ ◀──── ④ INSERT        │
                                     │    │              │      │   pairing_     │
                                     │    │              │      │   response     │
                                     │    └──────────────┘      │                │
                                     │                          │                │
                                     │   Realtime fanout to     │                │
                                     └─ all subscribed clients ─┘                │
                                                                └────────────────┘
```

## What happens, step by step

| # | Where     | What                                                                     |
|---|-----------|--------------------------------------------------------------------------|
| ① | Phone     | Frontend (`docs/js/pairings.js`) inserts a `pairing_request` row, with a `cellar_snapshot` and `context`. Anon key + RLS confines it to your `user_id`. |
| ② | Supabase  | Realtime publication fires an `INSERT` event for the new row.            |
| ③ | Laptop    | `watcher` (Node, `watcher/src/index.js`) is subscribed to that event. It runs the policy gate (allowlist + rate limit), atomically claims the row (`status: pending → picked_up`), renders the request to a markdown file in `requests/`, then `spawn`s `claude --print` with a one-shot prompt pointing at that file. Claude reads it, reasons, writes a response markdown file at the path the request specified (in `responses/`). |
| ④ | Laptop    | `chokidar` notices the new file. Watcher parses it, inserts a `pairing_response` row, marks the request `completed`, archives both files into `processed/`. |
| ⑤ | Phone     | Realtime delivers the new response row to the subscribed phone. Frontend renders the bottle cards + narrative. |

## Data ownership

| Lives in              | What                                                                |
|-----------------------|---------------------------------------------------------------------|
| **Supabase**          | Bottles, pairing/scan requests + responses, label photos (Storage)  |
| **Laptop disk**       | Bridge folder (`~/cellar27-bridge/`) — ephemeral request/response files for audit; Storage holds the durable image copies |
| **Phone**             | Nothing persistent. Service worker caches the app shell; data is fetched fresh from Supabase on each visit |

## Liveness model

The laptop only needs to be awake during step ③ (the AI reasoning window — typically 20–60s).

- Phone goes offline mid-flight → catches the response on next reconnect (Realtime + a one-shot row check on subscribe).
- Laptop goes to sleep AFTER the response was written → no impact; phone reads from Supabase.
- Laptop is asleep when the phone submits → request sits in `pending`. When laptop wakes, watcher's startup sweep picks it up and processes it. Phone gets the response when it lands.

## Security shape

- **Phone uses anon key.** RLS scopes every row to the signed-in `user_id`. The service-role key never leaves `watcher/.env`.
- **Sign-ups disabled** in Supabase. Only existing accounts (created from the dashboard) can sign in.
- **DB-enforced allowlist.** Only user_ids listed in `cellar27_allowed_users` can INSERT into `pairing_requests` / `scan_requests` (RLS `WITH CHECK`). Watcher's `ALLOWED_USER_IDS` env stays as a redundant backstop.
- **DB-enforced rate limit.** `cellar27_check_rate_limit(auth.uid())` in the same RLS check rejects any insert past 20 combined pairing+scan rows in the last 60 min.
- **Concurrent in-flight cap.** `enforce_pending_request_cap` / `enforce_pending_scan_cap` triggers reject a 6th in-flight (`pending` + `picked_up`) row per user.
- **Global daily Claude ceiling.** Watcher calls `cellar27_try_record_spawn(MAX_CLAUDE_CALLS_PER_DAY)` before every `claude --print` spawn; default 100/day across all users, atomic counter in `cellar27_watcher_metrics`. Resets at UTC midnight.
- **Stale-claim recovery.** `cellar27_sweep_stale_claims` resets timed-out `picked_up` rows to `pending` (up to 2 retries) before marking them `error`.
- **Size CHECK constraints** on user-supplied jsonb (`context` ≤ 4 KB, `cellar_snapshot` ≤ 65 KB, `image_paths` ≤ 4 KB) so a runaway phone payload can't bloat a row.

See [`docs/SECURITY.md`](docs/SECURITY.md) for the full limits table, where each is enforced, and how to tune.

## What about scan?

Same flow with two extras:

- **Front and optional back** label photos uploaded to Supabase Storage from the phone before the request inserts (path stored as an array in `image_paths`).
- **Watcher downloads** the images to `~/cellar27-bridge/images/`, references those local paths in the markdown so Claude can read them with vision.
- Response includes both **structured fields** (producer, varietal, vintage…) and **enrichment** (tasting notes, food pairings, producer background, serving recs), all packed into `scan_responses.extracted`.

## What about share / QR (planned, not yet built)?

Same shape but read-only and anonymous: a short-lived `share_links` token grants a guest's anonymous Supabase client `EXECUTE` on a `SECURITY DEFINER` function that returns sanitized bottle data for the owner. No mutations possible, no laptop compute consumed.

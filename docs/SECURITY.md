# cellar27 — Security & Limits

Single source of truth for what's enforced, where, and how to change it. The whole point of these limits is to prevent a leaked anon key, a frontend bug, or a runaway script from spawning unbounded `claude --print` processes on the laptop.

## Limits at a glance

| Limit | Default | Where enforced | Resets |
|---|---|---|---|
| **Allowlist** | members-only | RLS on INSERT (`pairing_requests`, `scan_requests`) | n/a |
| **Per-user rate limit (DB)** | 100 / hour | RLS on INSERT, sliding window | rolling 60 min |
| **Per-user rate limit (watcher)** | 100 / hour | In-memory map, redundant backstop | watcher restart or rolling 60 min |
| **Concurrent in-flight** | 5 per user | DB trigger on INSERT | as requests complete |
| **Global daily ceiling** | 250 spawns/day | Watcher → atomic counter in `cellar27_watcher_metrics` | UTC midnight |
| **Request payload size** | 4 KB context, 65 KB snapshot, 4 KB image paths | DB CHECK constraints | n/a |
| **Stale-claim retry cap** | 2 retries before `error` | DB function called every 2 min | per request |
| **Email notify on limit hit** | optional, configured via `SMTP_*` env vars | Watcher [`notify.js`](../watcher/src/notify.js) | per-key cooldown (default 30 min) |

The first four are independent gates; a request must pass all of them to spawn Claude.

## Layer 1 — Allowlist

**Where:** `cellar27_allowed_users` table + RLS policies on `pairing_requests` / `scan_requests` ([`supabase/migrations/0004_security_p0_p1.sql`](../supabase/migrations/0004_security_p0_p1.sql)).

**Effect:** A signed-in user whose id isn't in the table gets `new row violates row-level security policy` on every request insert.

**To add a user:**

```sql
insert into cellar27_allowed_users(user_id, note)
select id, email from auth.users where email = 'someone@example.com';
```

(Run as `service_role` — the table has no INSERT policy for `authenticated`.)

**To remove a user:** `delete from cellar27_allowed_users where user_id = '...';`

## Layer 2 — Per-user rate limit (DB)

**Where:** `cellar27_check_rate_limit(p_user_id, p_max=100, p_window_minutes=60)` invoked from the same RLS `WITH CHECK` clause as the allowlist. Default raised from 20 → 100 in [`0005_security_tune.sql`](../supabase/migrations/0005_security_tune.sql) so a normal bulk-add session doesn't bottleneck.

**Effect:** 101st combined pairing+scan insert in any rolling 60-minute window fails RLS.

**To tune:** edit the function defaults and re-run:

```sql
create or replace function cellar27_check_rate_limit(
  p_user_id uuid, p_max int default 50, p_window_minutes int default 60
) returns boolean
language sql stable security definer set search_path = public as $$
  select (
    (select count(*) from pairing_requests where user_id = p_user_id
       and created_at > now() - make_interval(mins => p_window_minutes))
    +
    (select count(*) from scan_requests where user_id = p_user_id
       and created_at > now() - make_interval(mins => p_window_minutes))
  ) < p_max;
$$;
```

**To temporarily disable** (e.g. bulk inventorying): replace the body with `select true;`. Restore by re-running migration `0004` or pasting the original definition above.

**Index used:** `pairing_requests_user_created_idx` and `scan_requests_user_created_idx` on `(user_id, created_at desc)` — keeps the count fast.

## Layer 3 — Concurrent in-flight cap

**Where:** `enforce_pending_request_cap` and `enforce_pending_scan_cap` triggers ([`supabase/migrations/0002_lockdown.sql`](../supabase/migrations/0002_lockdown.sql)).

**Effect:** 6th simultaneous request whose `status` is `pending` or `picked_up` raises `Too many pending …` and the insert fails. Cap is per-user, per-table.

**To tune:** edit the `cap int := 5;` constant in the trigger function and replace it. The frontend's multi-bottle scan queue UI also gates the "Scan label" button at this same number — search `MAX_IN_FLIGHT` in [`docs/js/app.js`](js/app.js) and update both.

## Layer 3b — Per-user rate limit (watcher in-memory)

**Where:** [`watcher/src/policy.js`](../watcher/src/policy.js) — sliding-window `Map` keyed by `user_id`. Redundant with the DB rate limit; this is the defense-in-depth backstop for cases where the DB layer is bypassed (e.g., service_role inserting on behalf of a user).

**Effect:** Watcher refuses to spawn Claude for the user past the limit; marks the request `status='error'` with `error_message='policy: rate limit: N/M requests in last hour'`.

**To tune:** set `WATCHER_RATE_LIMIT_PER_HOUR=200` in [`watcher/.env`](../watcher/.env.example) and restart the watcher.

**To clear immediately:** restart the watcher (the in-memory map starts fresh).

## Layer 4 — Global daily Claude ceiling

**Where:** Watcher calls `cellar27_try_record_spawn(p_max)` ([`supabase/migrations/0004_security_p0_p1.sql`](../supabase/migrations/0004_security_p0_p1.sql)) immediately before every `claude --print` spawn. Counter lives in `cellar27_watcher_metrics(metric_date, spawn_count)`.

**Effect:** First call past `p_max` returns false; watcher sets the request `status='error'` with `error_message='Daily AI capacity reached…'` and skips the spawn. Counter is **global across all users**.

**To tune:** `MAX_CLAUDE_CALLS_PER_DAY` in [`watcher/.env`](../watcher/.env.example), default 100. Change + restart the watcher (see [`watcher/README.md`](../watcher/README.md)).

**To inspect today's count:**

```sql
select * from cellar27_watcher_metrics where metric_date = current_date;
```

**To reset today's count to zero** (e.g. after raising the env var mid-day):

```sql
update cellar27_watcher_metrics set spawn_count = 0 where metric_date = current_date;
```

## Layer 5 — Payload size CHECK constraints

[`supabase/migrations/0002_lockdown.sql`](../supabase/migrations/0002_lockdown.sql) and [`0003_scan_multi_image.sql`](../supabase/migrations/0003_scan_multi_image.sql).

| Column | Cap |
|---|---|
| `pairing_requests.context` | 4096 bytes (jsonb text) |
| `pairing_requests.cellar_snapshot` | 65536 bytes |
| `scan_requests.context` | 4096 bytes |
| `scan_requests.cellar_snapshot` | 65536 bytes |
| `scan_requests.image_paths` | 4096 bytes (1–4 paths for `add`/`pour`, exactly 0 for `enrich`) |
| `bottles.producer` | 200 chars |
| `bottles.notes` | 4000 chars |
| `bottles.storage_location` | 200 chars |
| `bottles.details` | 8192 bytes |

A 5 MB blob can't make it into the request row.

## Layer 6 — Stale-claim sweep

`cellar27_sweep_stale_claims(p_timeout_minutes=10, p_max_retries=2)` runs every 2 min from the watcher (and once on startup). Rows stuck in `status='picked_up'` past the timeout get reset to `pending` for up to 2 retries; on the 3rd they're marked `error` so the phone stops spinning.

`claimed_by` (hostname) and `retry_count` columns are added to both request tables for visibility.

## Common bypass / one-shot cookbook

- **"I need to bulk-scan 50 bottles right now":** raise the rate limit ceiling or replace the function body with `select true;` (see Layer 2). Restore when done.
- **"Daily AI capacity reached":** bump `MAX_CLAUDE_CALLS_PER_DAY`, restart watcher, and `update cellar27_watcher_metrics set spawn_count = 0 where metric_date = current_date;` if you want today's accounting cleared.
- **"Too many pending scans (5)":** rare with the multi-bottle queue UI which already gates at 5; if hit, wait for one to complete (`status` flips to `completed` or `error` quickly) or tune the trigger constant.
- **A user got compromised:** `delete from cellar27_allowed_users where user_id = '...';` is the quickest cut.

## Layer 7 — Email notification on limit hit

**Where:** Watcher [`src/notify.js`](../watcher/src/notify.js), called from `index.js` on policy denial and daily-ceiling refusal.

**Effect:** Sends a plain-text email summarizing the limit hit + the SQL/env tweaks needed to grant more. Per-key cooldown so a runaway loop hitting the same limit can't flood your inbox.

**To enable:** set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `NOTIFY_FROM`, `NOTIFY_TO` in [`watcher/.env`](../watcher/.env.example). Gmail with an App Password (Account Settings → Security → 2FA → App passwords) works; so do Resend / Mailgun / SES SMTP. Leave any blank to disable.

**Cooldown:** `NOTIFY_COOLDOWN_MS` (default 30 min) per limit-key.

This is intentionally informational only — no clickable approve / deny in the email. With the limits raised in v0.8, hitting them should be rare and worth investigating manually rather than rubber-stamping.

## Verification

`scripts/security-smoke-test.mjs` (TODO — not yet written; was P1-3 in the original plan).

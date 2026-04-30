-- cellar27 — Security limits tuning
--
-- The original P0/P1 limits (20/hr, 100/day) were tuned for a hostile-key
-- abuse scenario. For a single-user cellar with bulk-add bursts (full
-- inventory ingest = 50–100 scans in an evening), they bottleneck normal
-- use. Raise to numbers that still cap a runaway-loop bug to a contained
-- burn but don't bother legitimate use.
--
-- Daily ceiling (cellar27_try_record_spawn p_max) is set in watcher/.env
-- via MAX_CLAUDE_CALLS_PER_DAY — separate change there, default 100 → 250.
--
-- Run via Supabase SQL Editor. Idempotent.

------------------------------------------------------------
-- Per-user rate limit: 20/hr → 100/hr.
-- Restores the original function body too, in case it's currently in
-- bypass mode (e.g. replaced with `select true;` for bulk inventorying).
------------------------------------------------------------

create or replace function cellar27_check_rate_limit(
  p_user_id        uuid,
  p_max            int default 100,
  p_window_minutes int default 60
) returns boolean
language sql stable security definer set search_path = public as $$
  select (
    (select count(*) from pairing_requests
       where user_id = p_user_id
         and created_at > now() - make_interval(mins => p_window_minutes))
    +
    (select count(*) from scan_requests
       where user_id = p_user_id
         and created_at > now() - make_interval(mins => p_window_minutes))
  ) < p_max;
$$;

revoke all on function cellar27_check_rate_limit(uuid, int, int) from public;
grant execute on function cellar27_check_rate_limit(uuid, int, int) to authenticated;

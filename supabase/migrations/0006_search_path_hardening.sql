-- cellar27 — search_path hardening on security definer functions.
--
-- The functions defined in 0004 used `set search_path = public`, meaning
-- they trust whatever lives in the `public` schema at call time. If
-- anything ever creates a same-named table in another searched schema
-- (or rewrites public), the function would silently use the wrong table.
--
-- Best practice: lock search_path to `pg_catalog, public` (so only system
-- catalogs and public are searched, in that order) AND fully schema-qualify
-- every table reference inside the function body. Belt and suspenders.
--
-- Idempotent: each function is recreated with `create or replace function`.
-- Run via Supabase SQL Editor.

------------------------------------------------------------
-- cellar27_check_rate_limit
------------------------------------------------------------
create or replace function cellar27_check_rate_limit(
  p_user_id        uuid,
  p_max            int default 100,
  p_window_minutes int default 60
) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select (
    (select count(*) from public.pairing_requests
       where user_id = p_user_id
         and created_at > now() - make_interval(mins => p_window_minutes))
    +
    (select count(*) from public.scan_requests
       where user_id = p_user_id
         and created_at > now() - make_interval(mins => p_window_minutes))
  ) < p_max;
$$;

revoke all on function cellar27_check_rate_limit(uuid, int, int) from public;
grant execute on function cellar27_check_rate_limit(uuid, int, int) to authenticated;

------------------------------------------------------------
-- cellar27_sweep_stale_claims
------------------------------------------------------------
create or replace function cellar27_sweep_stale_claims(
  p_timeout_minutes int default 10,
  p_max_retries     int default 2
) returns table(table_name text, request_id uuid, action text)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  cutoff timestamptz := now() - make_interval(mins => p_timeout_minutes);
begin
  return query
  with retry as (
    update public.pairing_requests
       set status      = 'pending',
           picked_up_at = null,
           claimed_by  = null,
           retry_count = retry_count + 1
     where status      = 'picked_up'
       and picked_up_at < cutoff
       and retry_count < p_max_retries
    returning id
  )
  select 'pairing_requests'::text, id, 'retry'::text from retry;

  return query
  with fail as (
    update public.pairing_requests
       set status        = 'error',
           error_message = format('stale: no completion after %s retries', p_max_retries)
     where status      = 'picked_up'
       and picked_up_at < cutoff
       and retry_count >= p_max_retries
    returning id
  )
  select 'pairing_requests'::text, id, 'fail'::text from fail;

  return query
  with retry as (
    update public.scan_requests
       set status      = 'pending',
           picked_up_at = null,
           claimed_by  = null,
           retry_count = retry_count + 1
     where status      = 'picked_up'
       and picked_up_at < cutoff
       and retry_count < p_max_retries
    returning id
  )
  select 'scan_requests'::text, id, 'retry'::text from retry;

  return query
  with fail as (
    update public.scan_requests
       set status        = 'error',
           error_message = format('stale: no completion after %s retries', p_max_retries)
     where status      = 'picked_up'
       and picked_up_at < cutoff
       and retry_count >= p_max_retries
    returning id
  )
  select 'scan_requests'::text, id, 'fail'::text from fail;
end;
$$;

revoke all on function cellar27_sweep_stale_claims(int, int) from public;

------------------------------------------------------------
-- cellar27_try_record_spawn
------------------------------------------------------------
create or replace function cellar27_try_record_spawn(p_max int)
returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  incremented int;
begin
  insert into public.cellar27_watcher_metrics(metric_date, spawn_count)
    values (current_date, 0)
    on conflict (metric_date) do nothing;

  update public.cellar27_watcher_metrics
     set spawn_count = spawn_count + 1,
         updated_at  = now()
   where metric_date = current_date
     and spawn_count < p_max
  returning spawn_count into incremented;

  return incremented is not null;
end;
$$;

revoke all on function cellar27_try_record_spawn(int) from public;

-- cellar27 — P0/P1 security hardening
--   P0-1  Allowlist enforced in RLS
--   P0-2  Per-user rate limit enforced in RLS
--   P0-4  Stale-claim recovery with retry cap
--   P1-1  Global daily Claude-call ceiling
--
-- Run via Supabase SQL Editor. Idempotent.
-- After applying, seed cellar27_allowed_users with each real user's id.

------------------------------------------------------------
-- P0-1  Allowlist table
------------------------------------------------------------

create table if not exists cellar27_allowed_users (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now(),
  note     text
);

alter table cellar27_allowed_users enable row level security;

drop policy if exists "users read own allowlist row" on cellar27_allowed_users;
create policy "users read own allowlist row" on cellar27_allowed_users
  for select to authenticated
  using (user_id = auth.uid());
-- No insert/update/delete policies → only service_role can mutate.

------------------------------------------------------------
-- P0-2  Rate-limit helper
-- Combined count across pairing+scan requests in last p_window_minutes.
------------------------------------------------------------

create index if not exists pairing_requests_user_created_idx
  on pairing_requests(user_id, created_at desc);
create index if not exists scan_requests_user_created_idx
  on scan_requests(user_id, created_at desc);

create or replace function cellar27_check_rate_limit(
  p_user_id        uuid,
  p_max            int default 20,
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

------------------------------------------------------------
-- P0-1 + P0-2  Tighten RLS on request tables
-- Existing FOR ALL policy is replaced with split SELECT/UPDATE/INSERT
-- so we can attach the allowlist + rate-limit checks to INSERT only.
------------------------------------------------------------

drop policy if exists "users see own pairing requests" on pairing_requests;
drop policy if exists "users select own pairing requests" on pairing_requests;
drop policy if exists "users update own pairing requests" on pairing_requests;
drop policy if exists "users insert own pairing requests" on pairing_requests;

create policy "users select own pairing requests" on pairing_requests
  for select to authenticated using (auth.uid() = user_id);

create policy "users update own pairing requests" on pairing_requests
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "users insert own pairing requests" on pairing_requests
  for insert to authenticated with check (
    auth.uid() = user_id
    and exists (select 1 from cellar27_allowed_users where user_id = auth.uid())
    and cellar27_check_rate_limit(auth.uid())
  );

drop policy if exists "users see own scan requests" on scan_requests;
drop policy if exists "users select own scan requests" on scan_requests;
drop policy if exists "users update own scan requests" on scan_requests;
drop policy if exists "users insert own scan requests" on scan_requests;

create policy "users select own scan requests" on scan_requests
  for select to authenticated using (auth.uid() = user_id);

create policy "users update own scan requests" on scan_requests
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "users insert own scan requests" on scan_requests
  for insert to authenticated with check (
    auth.uid() = user_id
    and exists (select 1 from cellar27_allowed_users where user_id = auth.uid())
    and cellar27_check_rate_limit(auth.uid())
  );

------------------------------------------------------------
-- P0-4  Claim metadata + stale-claim sweep with retry cap
-- picked_up_at already exists; we add claimed_by + retry_count.
------------------------------------------------------------

alter table pairing_requests
  add column if not exists claimed_by  text,
  add column if not exists retry_count int not null default 0;

alter table scan_requests
  add column if not exists claimed_by  text,
  add column if not exists retry_count int not null default 0;

create or replace function cellar27_sweep_stale_claims(
  p_timeout_minutes int default 10,
  p_max_retries     int default 2
) returns table(table_name text, request_id uuid, action text)
language plpgsql security definer set search_path = public as $$
declare
  cutoff timestamptz := now() - make_interval(mins => p_timeout_minutes);
begin
  -- pairing_requests retries
  return query
  with retry as (
    update pairing_requests
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

  -- pairing_requests terminal failures
  return query
  with fail as (
    update pairing_requests
       set status        = 'error',
           error_message = format('stale: no completion after %s retries', p_max_retries)
     where status      = 'picked_up'
       and picked_up_at < cutoff
       and retry_count >= p_max_retries
    returning id
  )
  select 'pairing_requests'::text, id, 'fail'::text from fail;

  -- scan_requests retries
  return query
  with retry as (
    update scan_requests
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

  -- scan_requests terminal failures
  return query
  with fail as (
    update scan_requests
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
-- Watcher uses service_role, which can execute regardless. No grants needed.

------------------------------------------------------------
-- P1-1  Global daily Claude-call ceiling
-- One row per UTC date. cellar27_try_record_spawn atomically
-- increments only if under p_max; returns true iff incremented.
------------------------------------------------------------

create table if not exists cellar27_watcher_metrics (
  metric_date date primary key,
  spawn_count int  not null default 0,
  updated_at  timestamptz not null default now()
);

alter table cellar27_watcher_metrics enable row level security;
-- No policies → only service_role can read/write.

create or replace function cellar27_try_record_spawn(p_max int)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  incremented int;
begin
  insert into cellar27_watcher_metrics(metric_date, spawn_count)
    values (current_date, 0)
    on conflict (metric_date) do nothing;

  update cellar27_watcher_metrics
     set spawn_count = spawn_count + 1,
         updated_at  = now()
   where metric_date = current_date
     and spawn_count < p_max
  returning spawn_count into incremented;

  return incremented is not null;
end;
$$;

revoke all on function cellar27_try_record_spawn(int) from public;

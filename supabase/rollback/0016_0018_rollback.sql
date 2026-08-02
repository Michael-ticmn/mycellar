-- cellar27 — rollback for migrations 0016, 0017, 0018
--
-- Restores the database to its state at commit 33e9d96 (v0.13.9), before the
-- 2026-08 review. Run this if applying 0016-0018 breaks something and you need
-- to get back to a known-good state fast.
--
-- NOT in supabase/migrations/ on purpose — it must never be picked up as the
-- next migration to apply. It only exists to be run deliberately.
--
-- Safe to run even if only some of 0016-0018 were applied: every statement is a
-- create-or-replace or a drop-then-create back to the original definition, so
-- re-asserting an already-original object is a no-op.
--
-- WHAT THIS DOES NOT DO: nothing here touches your data. No table is dropped, no
-- row is deleted or modified. 0016-0018 only changed functions and policies —
-- that is the whole reason this rollback is clean. If you also need row-level
-- recovery, that's what scripts/backup-data.mjs is for.
--
-- Reverting the app code is separate and is just git: see the rollback section
-- in README.md.
--
-- Run via Supabase SQL Editor. Idempotent.

------------------------------------------------------------
-- Undo 0018 — atomic pour + RLS perf
------------------------------------------------------------

-- The client tolerates these being gone: bottles.js catches PGRST202 and falls
-- back to the read-then-write it used before. Dropping them restores the old
-- behaviour (including its lost-update race) rather than breaking Pour.
drop function if exists cellar27_pour_bottle(uuid);
drop function if exists cellar27_unpour_bottle(uuid);

-- Policies back to bare auth.uid(), as defined in 0001 / 0004 / 0008 / 0012 /
-- 0014 / 0015. Only a performance difference; semantics are identical.
drop policy if exists "users see own bottles" on bottles;
create policy "users see own bottles" on bottles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "users select own pairing requests" on pairing_requests;
create policy "users select own pairing requests" on pairing_requests
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "users update own pairing requests" on pairing_requests;
create policy "users update own pairing requests" on pairing_requests
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "users insert own pairing requests" on pairing_requests;
create policy "users insert own pairing requests" on pairing_requests
  for insert to authenticated with check (
    auth.uid() = user_id
    and exists (select 1 from cellar27_allowed_users where user_id = auth.uid())
    and cellar27_check_rate_limit(auth.uid())
  );

drop policy if exists "users select own scan requests" on scan_requests;
create policy "users select own scan requests" on scan_requests
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "users update own scan requests" on scan_requests;
create policy "users update own scan requests" on scan_requests
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "users insert own scan requests" on scan_requests;
create policy "users insert own scan requests" on scan_requests
  for insert to authenticated with check (
    auth.uid() = user_id
    and exists (select 1 from cellar27_allowed_users where user_id = auth.uid())
    and cellar27_check_rate_limit(auth.uid())
  );

drop policy if exists "users see responses to own pairing requests" on pairing_responses;
create policy "users see responses to own pairing requests" on pairing_responses
  for select using (
    exists (select 1 from pairing_requests pr
             where pr.id = pairing_responses.request_id and pr.user_id = auth.uid())
  );

drop policy if exists "users see responses to own scan requests" on scan_responses;
create policy "users see responses to own scan requests" on scan_responses
  for select using (
    exists (select 1 from scan_requests sr
             where sr.id = scan_responses.request_id and sr.user_id = auth.uid())
  );

drop policy if exists "users read own allowlist row" on cellar27_allowed_users;
create policy "users read own allowlist row" on cellar27_allowed_users
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "owners read own share links" on share_links;
create policy "owners read own share links" on share_links
  for select to authenticated using (auth.uid() = owner_user_id);

drop policy if exists "owners revoke own share links" on share_links;
create policy "owners revoke own share links" on share_links
  for update to authenticated
  using (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

drop policy if exists "users see own planned flights" on planned_flights;
create policy "users see own planned flights" on planned_flights
  for select using (auth.uid() = user_id);

drop policy if exists "users insert own planned flights" on planned_flights;
create policy "users insert own planned flights" on planned_flights
  for insert with check (auth.uid() = user_id);

drop policy if exists "users update own planned flights" on planned_flights;
create policy "users update own planned flights" on planned_flights
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "users delete own planned flights" on planned_flights;
create policy "users delete own planned flights" on planned_flights
  for delete using (auth.uid() = user_id);

drop policy if exists "owners read guest messages on their links" on guest_messages;
create policy "owners read guest messages on their links" on guest_messages
  for select to authenticated using (
    exists (select 1 from share_links sl
            where sl.id = guest_messages.share_link_id
              and sl.owner_user_id = auth.uid())
  );

drop policy if exists "owners delete guest messages on their links" on guest_messages;
create policy "owners delete guest messages on their links" on guest_messages
  for delete to authenticated using (
    exists (select 1 from share_links sl
            where sl.id = guest_messages.share_link_id
              and sl.owner_user_id = auth.uid())
  );

------------------------------------------------------------
-- Undo 0017 — search_path sweep
------------------------------------------------------------

-- cellar27_share_get_planned_flight back to the 0013 definition.
create or replace function cellar27_share_get_planned_flight(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_link_id uuid;
  v_owner   uuid;
  v_plan    planned_flights%rowtype;
  v_bottles jsonb;
begin
  select id, owner_user_id into v_link_id, v_owner
    from share_links
   where token       = p_token
     and revoked_at is null
     and expires_at  > now();
  if v_link_id is null then
    raise exception 'link_invalid' using errcode = 'P0001';
  end if;

  select * into v_plan
    from planned_flights
   where shared_via_link_id = v_link_id
     and user_id = v_owner;

  if v_plan.id is null then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id',                 b.id,
           'producer',           b.producer,
           'wine_name',          b.wine_name,
           'varietal',           b.varietal,
           'blend_components',   b.blend_components,
           'vintage',            b.vintage,
           'region',             b.region,
           'country',            b.country,
           'style',              b.style,
           'sweetness',          b.sweetness,
           'body',               b.body,
           'drink_window_start', b.drink_window_start,
           'drink_window_end',   b.drink_window_end,
           'details',            b.details
         )), '[]'::jsonb)
    into v_bottles
    from bottles b
   where b.user_id = v_owner
     and b.id = any (
       select (elem->>'bottle_id')::uuid
         from jsonb_array_elements(v_plan.picks) elem
     );

  return jsonb_build_object(
    'id',            v_plan.id,
    'title',         v_plan.title,
    'occasion_date', v_plan.occasion_date,
    'theme',         v_plan.theme,
    'guests',        v_plan.guests,
    'narrative',     v_plan.narrative,
    'picks',         v_plan.picks,
    'food',          v_plan.food,
    'guest_view',    v_plan.guest_view,
    'bottles',       v_bottles
  );
end;
$$;

revoke all on function cellar27_share_get_planned_flight(text) from public;
grant execute on function cellar27_share_get_planned_flight(text) to anon, authenticated;

-- Trigger functions back to their original search_path-less definitions
-- (0001 / 0002), and planned_flights_touch_updated_at back to 0012's.
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create or replace function enforce_pending_request_cap() returns trigger
language plpgsql as $$
declare
  pending_count int;
  cap int := 5;
begin
  select count(*) into pending_count
  from pairing_requests
  where user_id = new.user_id
    and status in ('pending', 'picked_up');
  if pending_count >= cap then
    raise exception 'Too many pending requests (%): wait for the bridge to finish before submitting more.', pending_count
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace function enforce_pending_scan_cap() returns trigger
language plpgsql as $$
declare
  pending_count int;
  cap int := 5;
begin
  select count(*) into pending_count
  from scan_requests
  where user_id = new.user_id
    and status in ('pending', 'picked_up');
  if pending_count >= cap then
    raise exception 'Too many pending scans (%): wait for processing to finish.', pending_count
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace function planned_flights_touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

------------------------------------------------------------
-- Undo 0016 — share access hardening
------------------------------------------------------------

-- cellar27_share_get_response back to the 0011 definition (no revoked/expired
-- predicate). NOTE: this re-opens S2 — a revoked link can read its results
-- again. That's what "back to 33e9d96" means; don't leave it here.
create or replace function cellar27_share_get_response(
  p_token      text,
  p_request_id uuid
) returns table (
  status          text,
  error_message   text,
  recommendations jsonb,
  narrative       text
)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  return query
    select pr.status,
           pr.error_message,
           presp.recommendations,
           presp.narrative
      from public.pairing_requests pr
      join public.share_links sl on sl.id = pr.share_link_id
      left join public.pairing_responses presp on presp.request_id = pr.id
     where pr.id    = p_request_id
       and sl.token = p_token;
end;
$$;

revoke all on function cellar27_share_get_response(text, uuid) from public;
grant execute on function cellar27_share_get_response(text, uuid) to anon, authenticated;

-- cellar27_share_create_message back to the 0014 definition (no pacing guard,
-- no per-link ceiling).
create or replace function cellar27_share_create_message(
  p_token      text,
  p_guest_name text,
  p_kind       text,
  p_payload    jsonb
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_link_id uuid;
  v_id      uuid;
begin
  if p_kind not in ('ai_result', 'pour_note') then
    raise exception 'invalid_kind' using errcode = 'P0001';
  end if;
  if p_payload is null or octet_length(p_payload::text) > 32768 then
    raise exception 'payload_too_large' using errcode = 'P0001';
  end if;

  select id into v_link_id
    from public.share_links
   where token       = p_token
     and revoked_at is null
     and expires_at  > now();
  if v_link_id is null then
    raise exception 'link_invalid' using errcode = 'P0001';
  end if;

  insert into public.guest_messages (share_link_id, guest_name, kind, payload)
  values (v_link_id, nullif(trim(p_guest_name), ''), p_kind, p_payload)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function cellar27_share_create_message(text, text, text, jsonb) from public;
grant execute on function cellar27_share_create_message(text, text, text, jsonb) to anon, authenticated;

-- Storage UPDATE policy back to the 0001 definition (USING only, no WITH CHECK).
drop policy if exists "users update own labels" on storage.objects;
create policy "users update own labels" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'bottle-labels'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- cellar27 — finish the search_path sweep
--
-- 0006 hardened the SECURITY DEFINER functions that existed at the time, and
-- 0011 did the same for the share family. Two gaps were left, both found in the
-- 2026-08 review:
--
--   S8   cellar27_share_get_planned_flight (added in 0013, after 0011) shipped
--        with `set search_path = public` and unqualified table references — the
--        one share-family function that never got the treatment.
--   S13  the three trigger functions from 0001/0002 have no `set search_path`
--        at all.
--
-- Run via Supabase SQL Editor. Idempotent.

------------------------------------------------------------
-- S8 — cellar27_share_get_planned_flight
--
-- SECURITY DEFINER, granted to anon, and reads bottles directly (RLS bypassed
-- by design, with an explicit column projection so a future bottles column
-- can't leak). That combination is exactly the one where a mutable search_path
-- matters, so bring it in line with the rest of 0011: pin to
-- `pg_catalog, public` and schema-qualify every reference.
--
-- Body is otherwise unchanged from 0013.
------------------------------------------------------------

create or replace function cellar27_share_get_planned_flight(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  v_link_id uuid;
  v_owner   uuid;
  v_plan    public.planned_flights%rowtype;
  v_bottles jsonb;
begin
  select id, owner_user_id into v_link_id, v_owner
    from public.share_links
   where token       = p_token
     and revoked_at is null
     and expires_at  > now();
  if v_link_id is null then
    raise exception 'link_invalid' using errcode = 'P0001';
  end if;

  select * into v_plan
    from public.planned_flights
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
    from public.bottles b
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

------------------------------------------------------------
-- S13 — trigger functions
--
-- These are SECURITY INVOKER, so the exposure is much smaller than the
-- definer functions above — they run as the caller and can't be used to
-- escalate. Pinning search_path anyway: it's what Supabase's linter asks for
-- (function_search_path_mutable), it removes the "same-named table in another
-- searched schema" footgun, and it costs nothing.
--
-- Bodies unchanged from 0001 / 0002.
------------------------------------------------------------

create or replace function set_updated_at() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function enforce_pending_request_cap() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
declare
  pending_count int;
  cap int := 5;
begin
  select count(*) into pending_count
  from public.pairing_requests
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
language plpgsql set search_path = pg_catalog, public as $$
declare
  pending_count int;
  cap int := 5;
begin
  select count(*) into pending_count
  from public.scan_requests
  where user_id = new.user_id
    and status in ('pending', 'picked_up');
  if pending_count >= cap then
    raise exception 'Too many pending scans (%): wait for processing to finish.', pending_count
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- planned_flights_touch_updated_at (0012) already sets search_path = public.
-- Pin it to the same value as the rest for consistency.
create or replace function planned_flights_touch_updated_at()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Triggers themselves are unchanged — CREATE OR REPLACE FUNCTION keeps the
-- existing bindings, so no DROP/CREATE TRIGGER is needed.

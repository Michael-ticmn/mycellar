-- cellar27 — share-link hardening: search_path lockdown + per-link QPS guard.
--
-- Two things in one migration since both touch the same five SECURITY DEFINER
-- functions defined across 0008 / 0009 / 0010:
--
--   1. Lock search_path to `pg_catalog, public` (matching 0006's pattern for
--      the older security-definer functions) and fully schema-qualify every
--      table reference. Closes the "what if a same-named table appears in
--      another searched schema" footgun.
--
--   2. Add a per-link rate limit inside cellar27_share_create_pairing_request
--      so a guest with quota=50 can't burn the whole budget in <1 s by spamming
--      the RPC. Caps to one new request per 2 seconds per link. The 5-in-flight
--      table trigger and the watcher's 250/day global ceiling already apply,
--      but those bound severity, not pacing — this enforces "spread over the
--      link's lifetime" the way the owner expects.
--
-- Idempotent (uses `create or replace function`). Run via Supabase SQL Editor.

------------------------------------------------------------
-- cellar27_share_resolve  (from 0008)
------------------------------------------------------------
create or replace function cellar27_share_resolve(p_token text)
returns table (
  expires_at  timestamptz,
  ai_quota    int,
  ai_used     int
)
language sql stable security definer set search_path = pg_catalog, public as $$
  select expires_at, ai_quota, ai_used
    from public.share_links
   where token       = p_token
     and revoked_at is null
     and expires_at  > now();
$$;

revoke all on function cellar27_share_resolve(text) from public;
grant execute on function cellar27_share_resolve(text) to anon, authenticated;

------------------------------------------------------------
-- cellar27_share_list_bottles  (from 0008)
------------------------------------------------------------
create or replace function cellar27_share_list_bottles(p_token text)
returns table (
  id                 uuid,
  producer           text,
  wine_name          text,
  varietal           text,
  blend_components   jsonb,
  vintage            int,
  region             text,
  country            text,
  style              text,
  sweetness          text,
  body               int,
  quantity           int,
  drink_window_start int,
  drink_window_end   int
)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  v_owner uuid;
begin
  select owner_user_id into v_owner
    from public.share_links
   where token       = p_token
     and revoked_at is null
     and expires_at  > now();

  if v_owner is null then
    raise exception 'link_invalid' using errcode = 'P0001';
  end if;

  return query
    select b.id, b.producer, b.wine_name, b.varietal, b.blend_components,
           b.vintage, b.region, b.country, b.style, b.sweetness, b.body,
           b.quantity, b.drink_window_start, b.drink_window_end
      from public.bottles b
     where b.user_id = v_owner;
end;
$$;

revoke all on function cellar27_share_list_bottles(text) from public;
grant execute on function cellar27_share_list_bottles(text) to anon, authenticated;

------------------------------------------------------------
-- cellar27_share_create_pairing_request  (from 0009, with new QPS guard)
------------------------------------------------------------
create or replace function cellar27_share_create_pairing_request(
  p_token        text,
  p_request_type text,
  p_context      jsonb
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_link_id  uuid;
  v_owner    uuid;
  v_snapshot jsonb;
  v_req_id   uuid;
  v_recent   int;
begin
  if p_request_type not in ('pairing','flight','drink_now') then
    raise exception 'invalid_request_type' using errcode = 'P0001';
  end if;

  -- Resolve the link first (without claiming) so we can apply the per-link
  -- QPS guard before burning a quota unit on a request we'd otherwise refuse.
  select id, owner_user_id into v_link_id, v_owner
    from public.share_links
   where token       = p_token
     and revoked_at is null
     and expires_at  > now();

  if v_link_id is null then
    raise exception 'link_invalid' using errcode = 'P0001';
  end if;

  -- Per-link rate guard: one new request per 2 seconds. A guest spamming the
  -- RPC in a 1-second loop can't drain a 50-quota link in milliseconds.
  select count(*) into v_recent
    from public.pairing_requests
   where share_link_id = v_link_id
     and created_at    > now() - interval '2 seconds';

  if v_recent > 0 then
    raise exception 'rate_too_fast' using errcode = 'P0001';
  end if;

  -- Atomic claim of one quota unit. Returns no row if the link was just
  -- revoked / expired between the resolve and the claim, or if quota was
  -- consumed by a concurrent caller.
  update public.share_links
     set ai_used = ai_used + 1
   where id          = v_link_id
     and revoked_at is null
     and expires_at  > now()
     and ai_used     < ai_quota
  returning id into v_link_id;

  if v_link_id is null then
    raise exception 'quota_exhausted' using errcode = 'P0001';
  end if;

  -- Build the same sanitized snapshot the owner-side code uses
  -- (see snapshotForBridge in docs/js/pairings.js). Drops price, notes, etc.
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
           'quantity',           b.quantity,
           'drink_window_start', b.drink_window_start,
           'drink_window_end',   b.drink_window_end
         )), '[]'::jsonb)
    into v_snapshot
    from public.bottles b
   where b.user_id = v_owner;

  insert into public.pairing_requests (user_id, request_type, context, cellar_snapshot, share_link_id)
       values (v_owner, p_request_type, p_context, v_snapshot, v_link_id)
    returning id into v_req_id;

  return v_req_id;
end;
$$;

revoke all on function cellar27_share_create_pairing_request(text, text, jsonb) from public;
grant execute on function cellar27_share_create_pairing_request(text, text, jsonb) to anon, authenticated;

------------------------------------------------------------
-- cellar27_share_get_response  (from 0009)
------------------------------------------------------------
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

------------------------------------------------------------
-- cellar27_share_create  (from 0010 — also needs gen_random_bytes
-- which lives in the `extensions` schema in Supabase)
------------------------------------------------------------
create or replace function cellar27_share_create(
  p_ttl_hours int,
  p_ai_quota  int
) returns table (
  id          uuid,
  token       text,
  expires_at  timestamptz,
  ai_quota    int,
  ai_used     int
)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_uid   uuid := auth.uid();
  v_token text;
  v_ttl   int  := greatest(1, least(p_ttl_hours, 168));
  v_quota int  := greatest(1, least(p_ai_quota, 50));
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.cellar27_allowed_users where user_id = v_uid) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;

  update public.share_links
     set revoked_at = now()
   where owner_user_id = v_uid
     and revoked_at is null;

  -- Schema-qualify gen_random_bytes (lives in the `extensions` schema in
  -- Supabase) so we don't need extensions on search_path.
  v_token := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_');

  return query
    insert into public.share_links (owner_user_id, token, expires_at, ai_quota)
    values (v_uid, v_token, now() + make_interval(hours => v_ttl), v_quota)
    returning share_links.id, share_links.token, share_links.expires_at,
              share_links.ai_quota, share_links.ai_used;
end;
$$;

revoke all on function cellar27_share_create(int, int) from public;
grant execute on function cellar27_share_create(int, int) to authenticated;

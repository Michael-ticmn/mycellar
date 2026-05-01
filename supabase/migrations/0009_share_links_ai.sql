-- cellar27 — share-link AI flows (phase 2)
--
-- Lets a guest with a valid share token spawn pair / flight / drink_now
-- requests against the link's owner. Per-link quota (share_links.ai_quota)
-- is enforced atomically inside the create function. Owner's per-user
-- 100/hr rate-limit and allowlist do NOT apply (guests are intentionally
-- on a separate budget). The watcher's global daily ceiling still does.
--
-- Run via Supabase SQL Editor. Idempotent.

------------------------------------------------------------
-- Tag pairing_requests with the share link that created them so
-- (a) we can audit guest activity, and (b) cellar27_share_get_response
-- only returns rows that originated from the supplied token.
------------------------------------------------------------

alter table pairing_requests
  add column if not exists share_link_id uuid references share_links(id) on delete set null;

create index if not exists pairing_requests_share_link_idx
  on pairing_requests(share_link_id) where share_link_id is not null;

------------------------------------------------------------
-- Create a pairing/flight/drink_now request via a share token.
-- Atomically increments ai_used; raises 'quota_exhausted' if at cap,
-- 'link_invalid' if the token is missing/revoked/expired.
------------------------------------------------------------

create or replace function cellar27_share_create_pairing_request(
  p_token        text,
  p_request_type text,
  p_context      jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_link_id  uuid;
  v_owner    uuid;
  v_snapshot jsonb;
  v_req_id   uuid;
begin
  if p_request_type not in ('pairing','flight','drink_now') then
    raise exception 'invalid_request_type' using errcode = 'P0001';
  end if;

  -- Atomic claim of one quota unit. Returns no row if invalid / over cap.
  update share_links
     set ai_used = ai_used + 1
   where token       = p_token
     and revoked_at is null
     and expires_at  > now()
     and ai_used     < ai_quota
  returning id, owner_user_id into v_link_id, v_owner;

  if v_link_id is null then
    -- Distinguish quota-exhausted from invalid for clearer client errors.
    if exists (
      select 1 from share_links
        where token       = p_token
          and revoked_at is null
          and expires_at  > now()
    ) then
      raise exception 'quota_exhausted' using errcode = 'P0001';
    else
      raise exception 'link_invalid' using errcode = 'P0001';
    end if;
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
    from bottles b
   where b.user_id = v_owner;

  insert into pairing_requests (user_id, request_type, context, cellar_snapshot, share_link_id)
       values (v_owner, p_request_type, p_context, v_snapshot, v_link_id)
    returning id into v_req_id;

  return v_req_id;
end;
$$;

revoke all on function cellar27_share_create_pairing_request(text, text, jsonb) from public;
grant execute on function cellar27_share_create_pairing_request(text, text, jsonb) to anon, authenticated;

------------------------------------------------------------
-- Read the response for a request that was created via this token.
-- Returns one row even if the request is still pending so the client
-- can poll a single function for status + (optional) result.
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
language plpgsql stable security definer set search_path = public as $$
begin
  return query
    select pr.status,
           pr.error_message,
           presp.recommendations,
           presp.narrative
      from pairing_requests pr
      join share_links sl on sl.id = pr.share_link_id
      left join pairing_responses presp on presp.request_id = pr.id
     where pr.id    = p_request_id
       and sl.token = p_token;
end;
$$;

revoke all on function cellar27_share_get_response(text, uuid) from public;
grant execute on function cellar27_share_get_response(text, uuid) to anon, authenticated;

-- cellar27 — share-access hardening
--
-- Three findings from the 2026-08 end-to-end review, all in the guest/share
-- surface. Grouped because they're one review pass over the same trust
-- boundary and get applied together.
--
--   S2  cellar27_share_get_response ignored revoked_at / expires_at, so a
--       revoked link still read back every result it ever produced.
--   S3  cellar27_share_create_message had no pacing or volume cap, unlike the
--       sibling RPC that creates pairing requests.
--   S4  the Storage UPDATE policy had USING but no WITH CHECK, so an object
--       could be renamed into another user's folder prefix.
--
-- Run via Supabase SQL Editor. Idempotent.

------------------------------------------------------------
-- S2 — cellar27_share_get_response honors link lifetime
--
-- Every other share RPC (resolve, list_bottles, create_pairing_request,
-- get_planned_flight, create_message) and the guest-label Edge Function gate
-- on `revoked_at is null and expires_at > now()`. This one gated on the token
-- alone, so revoking a link stopped new requests but left the old
-- recommendations and narratives readable to anyone still holding the token.
-- SECURITY.md claims photos and data stop resolving at the same moment; this
-- makes that true.
--
-- Re-runs the 0011 definition with the predicate added — same search_path
-- lockdown and schema-qualified refs.
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
     where pr.id           = p_request_id
       and sl.token        = p_token
       and sl.revoked_at  is null
       and sl.expires_at   > now();
end;
$$;

revoke all on function cellar27_share_get_response(text, uuid) from public;
grant execute on function cellar27_share_get_response(text, uuid) to anon, authenticated;

------------------------------------------------------------
-- S3 — pace and cap guest messages
--
-- guest_messages is the one table an anonymous caller can write to. The kind
-- enum and a 32 KB payload ceiling were the only limits, so a token holder
-- could insert unbounded 32 KB rows: table bloat, and a host activity feed
-- that's unusable for the tasting it was meant to support.
--
-- Two guards, mirroring what 0011 added to cellar27_share_create_pairing_request:
--   * one message per 2 seconds per link (pacing)
--   * 200 messages per link total (volume)
--
-- 200 is deliberately generous — a real tasting with a handful of guests
-- leaving pour notes on each of 5 pours lands well under it — while still
-- bounding a runaway loop. Both raise P0001 so the client's prettyShareError
-- can map them.
------------------------------------------------------------

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
  v_recent  int;
  v_total   int;
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

  -- Pacing: one message per 2 seconds per link.
  select count(*) into v_recent
    from public.guest_messages
   where share_link_id = v_link_id
     and created_at    > now() - interval '2 seconds';
  if v_recent > 0 then
    raise exception 'rate_too_fast' using errcode = 'P0001';
  end if;

  -- Volume: hard ceiling per link.
  select count(*) into v_total
    from public.guest_messages
   where share_link_id = v_link_id;
  if v_total >= 200 then
    raise exception 'message_limit_reached' using errcode = 'P0001';
  end if;

  insert into public.guest_messages (share_link_id, guest_name, kind, payload)
  values (v_link_id, nullif(trim(p_guest_name), ''), p_kind, p_payload)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function cellar27_share_create_message(text, text, text, jsonb) from public;
grant execute on function cellar27_share_create_message(text, text, text, jsonb) to anon, authenticated;

-- The pacing guard counts rows in the last 2 seconds per link; the volume
-- guard counts all rows per link. guest_messages_link_idx is on
-- (share_link_id, created_at desc), which serves both.

------------------------------------------------------------
-- S4 — Storage UPDATE policy needs WITH CHECK
--
-- 0001 created this policy with USING only. USING decides which rows you may
-- target; WITH CHECK decides what the row is allowed to become. Without the
-- second clause an authenticated user could UPDATE storage.objects.name and
-- relocate their own object under another user's {user_id}/ prefix — the row
-- passes USING on the way in (it's theirs) and nothing validates it on the way
-- out. Add the matching clause so the folder prefix has to stay theirs.
------------------------------------------------------------

drop policy if exists "users update own labels" on storage.objects;
create policy "users update own labels" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'bottle-labels'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'bottle-labels'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- cellar27 — share-link creation (phase 3)
--
-- Owner-callable RPC that atomically revokes the caller's prior active
-- share link and inserts a new one. Caller must be `authenticated` and
-- on the cellar27_allowed_users list. Token is server-generated so the
-- browser never has to source CSPRNG-quality bytes.
--
-- Run via Supabase SQL Editor. Idempotent.

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
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid   uuid := auth.uid();
  v_token text;
  v_ttl   int  := greatest(1, least(p_ttl_hours, 168));   -- 1h … 7d ceiling
  v_quota int  := greatest(1, least(p_ai_quota, 50));     -- 1 … 50
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;

  -- Owner must be on the allowlist (same gate as creating real requests).
  if not exists (select 1 from cellar27_allowed_users where user_id = v_uid) then
    raise exception 'not_allowed' using errcode = 'P0001';
  end if;

  -- Revoke any prior active links for this owner.
  update share_links
     set revoked_at = now()
   where owner_user_id = v_uid
     and revoked_at is null;

  -- url-safe token: 24 random bytes → base64 → strip padding/+//
  v_token := translate(encode(gen_random_bytes(24), 'base64'), '+/=', '-_');

  return query
    insert into share_links (owner_user_id, token, expires_at, ai_quota)
    values (v_uid, v_token, now() + make_interval(hours => v_ttl), v_quota)
    returning share_links.id, share_links.token, share_links.expires_at,
              share_links.ai_quota, share_links.ai_used;
end;
$$;

revoke all on function cellar27_share_create(int, int) from public;
grant execute on function cellar27_share_create(int, int) to authenticated;

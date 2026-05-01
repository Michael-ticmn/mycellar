-- cellar27 — guest share links (phase 1: read-only bottle access)
--
-- A short-lived token grants an anonymous Supabase client access to a
-- sanitized view of one owner's cellar via SECURITY DEFINER functions.
-- Phase 2 will extend this with AI request creation (pair / flight /
-- ask-sommelier). Phase 3 adds the owner-side generate/revoke UI.
--
-- Run via Supabase SQL Editor. Idempotent.

------------------------------------------------------------
-- Table
------------------------------------------------------------

create table if not exists share_links (
  id             uuid primary key default gen_random_uuid(),
  owner_user_id  uuid not null references auth.users(id) on delete cascade,
  token          text not null unique,
  expires_at     timestamptz not null,
  ai_quota       int  not null default 20 check (ai_quota >= 0),
  ai_used        int  not null default 0  check (ai_used  >= 0),
  revoked_at     timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists share_links_owner_idx
  on share_links(owner_user_id);
create index if not exists share_links_active_idx
  on share_links(token) where revoked_at is null;

alter table share_links enable row level security;

-- Owners can read and revoke their own links. Inserts go through
-- cellar27_share_create() (SECURITY DEFINER) so we can atomically
-- revoke prior links in the same statement.
drop policy if exists "owners read own share links" on share_links;
create policy "owners read own share links" on share_links
  for select to authenticated using (auth.uid() = owner_user_id);

drop policy if exists "owners revoke own share links" on share_links;
create policy "owners revoke own share links" on share_links
  for update to authenticated
  using (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

------------------------------------------------------------
-- Resolve: validate a token and return its public-safe metadata.
-- Returns no rows if the token is missing, revoked, or expired.
-- Granted to anon so the guest page can call it without a session.
------------------------------------------------------------

create or replace function cellar27_share_resolve(p_token text)
returns table (
  expires_at  timestamptz,
  ai_quota    int,
  ai_used     int
)
language sql stable security definer set search_path = public as $$
  select expires_at, ai_quota, ai_used
    from share_links
   where token       = p_token
     and revoked_at is null
     and expires_at  > now();
$$;

revoke all on function cellar27_share_resolve(text) from public;
grant execute on function cellar27_share_resolve(text) to anon, authenticated;

------------------------------------------------------------
-- List bottles via a share token. Returns the same field set as the
-- snapshotForBridge sanitizer in docs/js/pairings.js — explicitly drops
-- acquired_price, acquired_date, notes, storage_location, label paths,
-- and user_id so a leaked token cannot reveal any of those.
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
language plpgsql stable security definer set search_path = public as $$
declare
  v_owner uuid;
begin
  select owner_user_id into v_owner
    from share_links
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
      from bottles b
     where b.user_id = v_owner;
end;
$$;

revoke all on function cellar27_share_list_bottles(text) from public;
grant execute on function cellar27_share_list_bottles(text) to anon, authenticated;

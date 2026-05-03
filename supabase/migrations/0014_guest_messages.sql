-- cellar27 — guest → host channel
--
-- Lets a guest visiting #/guest/<token> send results back to the host:
--   * an AI result they got (Pair / Flight / Sommelier) — full
--     request_type + context + recommendations + narrative.
--   * a per-pour note attached to a Tonight planned_flight — bottle_id
--     + free-text comment.
-- Host reads them on the Share page (chronological feed) — direct
-- RLS-gated select. Guests insert via a SECURITY DEFINER RPC that
-- validates the token. No AI cost — these messages don't spawn
-- pairing_requests.
--
-- Run via Supabase SQL Editor. Idempotent.

------------------------------------------------------------
-- 1. Table
------------------------------------------------------------

create table if not exists guest_messages (
  id            uuid primary key default gen_random_uuid(),
  share_link_id uuid not null references share_links(id) on delete cascade,
  created_at    timestamptz not null default now(),
  guest_name    text,
  kind          text not null check (kind in ('ai_result', 'pour_note')),
  payload       jsonb not null
  -- payload shape by kind:
  --   ai_result: { request_type, context, recommendations, narrative }
  --   pour_note: { planned_flight_id, bottle_id, note }
);

create index if not exists guest_messages_link_idx
  on guest_messages(share_link_id, created_at desc);

alter table guest_messages enable row level security;

-- Hosts read messages tied to their own share links. No insert/update/
-- delete policies — guests use the SECURITY DEFINER RPC below; hosts
-- shouldn't be editing or deleting individual guest messages from the
-- client (cascade-on-link-delete handles cleanup).
drop policy if exists "owners read guest messages on their links" on guest_messages;
create policy "owners read guest messages on their links" on guest_messages
  for select to authenticated using (
    exists (select 1 from share_links sl
            where sl.id = guest_messages.share_link_id
              and sl.owner_user_id = auth.uid())
  );

------------------------------------------------------------
-- 2. Anon RPC: guest creates a message tied to their token's link.
--    Validates the token (active + not expired), constrains the
--    payload size, and constrains the kind enum. Returns the new id.
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

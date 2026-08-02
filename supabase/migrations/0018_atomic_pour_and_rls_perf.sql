-- cellar27 — atomic pour + RLS policy performance
--
-- From the 2026-08 review:
--   E3  pourBottle() read the row, then wrote quantity - 1. Two pours racing
--       both read N and both write N - 1, so one pour goes unrecorded.
--   E6  every RLS policy calls auth.uid() bare, which Postgres evaluates per
--       row rather than once per statement.
--
-- Run via Supabase SQL Editor. Idempotent.

------------------------------------------------------------
-- E3 — atomic decrement
--
-- One statement, so the read and the write can't be split by a concurrent
-- pour. `quantity > 0` in the WHERE clause is the floor: at zero no row
-- matches, we return null, and the client raises the same "No bottles left"
-- error it did before.
--
-- SECURITY INVOKER (the default) on purpose — this must stay subject to the
-- caller's RLS so it can only ever touch the caller's own bottles. It is not
-- an authorization bypass, just an atomic UPDATE.
------------------------------------------------------------

create or replace function cellar27_pour_bottle(p_bottle_id uuid)
returns table (id uuid, quantity int)
language sql set search_path = pg_catalog, public as $$
  update public.bottles
     set quantity = quantity - 1
   where bottles.id = p_bottle_id
     and quantity   > 0
  returning bottles.id, bottles.quantity;
$$;

revoke all on function cellar27_pour_bottle(uuid) from public;
grant execute on function cellar27_pour_bottle(uuid) to authenticated;

-- Undo is the mirror image. No ceiling: putting a bottle back is always valid,
-- and the row's own quantity >= 0 check still applies.
create or replace function cellar27_unpour_bottle(p_bottle_id uuid)
returns table (id uuid, quantity int)
language sql set search_path = pg_catalog, public as $$
  update public.bottles
     set quantity = quantity + 1
   where bottles.id = p_bottle_id
  returning bottles.id, bottles.quantity;
$$;

revoke all on function cellar27_unpour_bottle(uuid) from public;
grant execute on function cellar27_unpour_bottle(uuid) to authenticated;

------------------------------------------------------------
-- E6 — wrap auth.uid() so it's evaluated once per statement
--
-- Supabase's documented RLS performance guidance: a bare auth.uid() in a
-- policy is re-evaluated for every candidate row, while (select auth.uid()) is
-- treated as a stable subquery and run once. Same semantics, materially less
-- work on the tables that actually have rows.
--
-- Policy definitions are otherwise unchanged from 0001 / 0004 / 0008 / 0012 /
-- 0014 / 0015. Roles are made explicit (`to authenticated`) where the original
-- omitted them: anon has a null auth.uid() so it never matched anyway, but
-- saying so means the policy isn't even considered for anonymous callers.
------------------------------------------------------------

-- bottles (0001 used a single FOR ALL policy)
drop policy if exists "users see own bottles" on bottles;
create policy "users see own bottles" on bottles
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- pairing_requests / scan_requests (0004)
drop policy if exists "users select own pairing requests" on pairing_requests;
create policy "users select own pairing requests" on pairing_requests
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "users update own pairing requests" on pairing_requests;
create policy "users update own pairing requests" on pairing_requests
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "users insert own pairing requests" on pairing_requests;
create policy "users insert own pairing requests" on pairing_requests
  for insert to authenticated with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.cellar27_allowed_users where user_id = (select auth.uid()))
    and cellar27_check_rate_limit((select auth.uid()))
  );

drop policy if exists "users select own scan requests" on scan_requests;
create policy "users select own scan requests" on scan_requests
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "users update own scan requests" on scan_requests;
create policy "users update own scan requests" on scan_requests
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "users insert own scan requests" on scan_requests;
create policy "users insert own scan requests" on scan_requests
  for insert to authenticated with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.cellar27_allowed_users where user_id = (select auth.uid()))
    and cellar27_check_rate_limit((select auth.uid()))
  );

-- response tables (0001)
drop policy if exists "users see responses to own pairing requests" on pairing_responses;
create policy "users see responses to own pairing requests" on pairing_responses
  for select to authenticated using (
    exists (select 1 from public.pairing_requests pr
             where pr.id = pairing_responses.request_id
               and pr.user_id = (select auth.uid()))
  );

drop policy if exists "users see responses to own scan requests" on scan_responses;
create policy "users see responses to own scan requests" on scan_responses
  for select to authenticated using (
    exists (select 1 from public.scan_requests sr
             where sr.id = scan_responses.request_id
               and sr.user_id = (select auth.uid()))
  );

-- allowlist (0004)
drop policy if exists "users read own allowlist row" on cellar27_allowed_users;
create policy "users read own allowlist row" on cellar27_allowed_users
  for select to authenticated using (user_id = (select auth.uid()));

-- share_links (0008)
drop policy if exists "owners read own share links" on share_links;
create policy "owners read own share links" on share_links
  for select to authenticated using ((select auth.uid()) = owner_user_id);

drop policy if exists "owners revoke own share links" on share_links;
create policy "owners revoke own share links" on share_links
  for update to authenticated
  using ((select auth.uid()) = owner_user_id)
  with check ((select auth.uid()) = owner_user_id);

-- planned_flights (0012)
drop policy if exists "users see own planned flights" on planned_flights;
create policy "users see own planned flights" on planned_flights
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "users insert own planned flights" on planned_flights;
create policy "users insert own planned flights" on planned_flights
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "users update own planned flights" on planned_flights;
create policy "users update own planned flights" on planned_flights
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "users delete own planned flights" on planned_flights;
create policy "users delete own planned flights" on planned_flights
  for delete to authenticated using ((select auth.uid()) = user_id);

-- guest_messages (0014 / 0015)
drop policy if exists "owners read guest messages on their links" on guest_messages;
create policy "owners read guest messages on their links" on guest_messages
  for select to authenticated using (
    exists (select 1 from public.share_links sl
             where sl.id = guest_messages.share_link_id
               and sl.owner_user_id = (select auth.uid()))
  );

drop policy if exists "owners delete guest messages on their links" on guest_messages;
create policy "owners delete guest messages on their links" on guest_messages
  for delete to authenticated using (
    exists (select 1 from public.share_links sl
             where sl.id = guest_messages.share_link_id
               and sl.owner_user_id = (select auth.uid()))
  );

-- Storage policies are left alone here: 0016 rewrote the UPDATE one, and the
-- foldername() comparison there is the expensive part, not auth.uid().

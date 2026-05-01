-- cellar27 — planned flights (saved flight builder results + food/prep enrichment)
--
-- Adds a per-user table of saved flight plans plus the bits of plumbing the
-- watcher needs to write back richer responses.
--
-- Run via Supabase SQL Editor. Idempotent.

------------------------------------------------------------
-- 1. Allow a new request_type='flight_plan' on pairing_requests.
--    Watcher sees this, takes the saved flight's picks + narrative as
--    context, and returns {food, prep} in pairing_responses.payload.
------------------------------------------------------------

alter table pairing_requests
  drop constraint if exists pairing_requests_request_type_check;

alter table pairing_requests
  add constraint pairing_requests_request_type_check
  check (request_type in ('pairing','flight','drink_now','flight_plan'));

------------------------------------------------------------
-- 2. New jsonb payload column on pairing_responses for structured
--    response data that doesn't fit the recommendations/narrative shape.
--    Stays null for existing pairing/flight/drink_now responses.
------------------------------------------------------------

alter table pairing_responses
  add column if not exists payload jsonb;

------------------------------------------------------------
-- 3. planned_flights — user-scoped, RLS-gated.
--    Each row = a flight the user explicitly saved. picks/narrative are
--    captured at save time (so they survive even if the source bottle
--    is later deleted). food + prep are filled by a follow-up
--    flight_plan AI request and may be edited by the user.
------------------------------------------------------------

create table if not exists planned_flights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  title text,
  occasion_date date,
  source_request_id uuid references pairing_requests(id) on delete set null,
  theme text,
  guests int,
  narrative text not null,
  picks jsonb not null,
  food jsonb,
  prep jsonb,
  user_notes text
);

create index if not exists planned_flights_user_idx
  on planned_flights(user_id, occasion_date nulls last, created_at desc);

alter table planned_flights enable row level security;

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

-- Auto-bump updated_at on any update.
create or replace function planned_flights_touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists planned_flights_touch on planned_flights;
create trigger planned_flights_touch
  before update on planned_flights
  for each row execute function planned_flights_touch_updated_at();

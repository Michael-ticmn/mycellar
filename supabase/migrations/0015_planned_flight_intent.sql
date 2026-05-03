-- cellar27 — preserve original food/notes intent on planned flights
--
-- Captured from the host's flight builder (or a guest's, when promoted
-- from /share Guest activity). Both columns are advisory free text,
-- write-once at save time. The flight_plan AI request reads them as
-- additional context so the model honors the original ask instead of
-- producing generic suggestions. Detail page surfaces them above the
-- editable food/prep blocks so the host always sees what was asked
-- for, even after the AI enrichment lands.
--
-- Run via Supabase SQL Editor. Idempotent.

alter table planned_flights
  add column if not exists food_hint  text,
  add column if not exists notes_hint text;

-- 0020_planned_flight_soundtrack.sql
--
-- An evening has a soundtrack. Stored on the plan, suggested by the
-- flight_plan enrichment pass alongside food and prep.
--
-- Deliberately event-level rather than per-pour: changing music every twenty
-- minutes is fussier than an evening wants, and an arc across the night (opens
-- lively, settles for the main, quiets for dessert) is how people actually do
-- it. Per-pour cues can be added later without reshaping this column.
--
-- Shape (all optional, the client tolerates any subset):
--   {
--     "arc": "one or two sentences on how the evening moves",
--     "suggestions": [
--       { "phase": "opening" | "main" | "dessert" | free text,
--         "artist": "...",
--         "title":  "album or track",
--         "why":    "one sentence tying it to the pour or the food" }
--     ]
--   }
--
-- NOTE ON LINKS, deliberately absent: the bridge agent runs --tools Read,Write
-- with no network egress (STRATEGY.md, Layer 9 of docs/SECURITY.md). It cannot
-- check a streaming service or verify a station, so it returns NAMES it knows,
-- never URLs or playlist ids - those are exactly what a model invents
-- confidently, and a dead link is invisible until a guest taps it mid-evening.
-- Real playlist creation is an API-and-OAuth job on the app side, not here.

alter table planned_flights
  add column if not exists soundtrack jsonb;

------------------------------------------------------------------
-- Guests need to see it, and the share RPC projects plan columns
-- EXPLICITLY (it does not to_jsonb the row) - so a new column is invisible
-- to guests until it is named here. That projection is a privacy boundary,
-- not an oversight: `prep` and `user_notes` are host-side and stay omitted.
--
-- Re-runs the definition from 0013_guest_plan_view with 'soundtrack' added.
-- Idempotent, and keeps the same search_path lockdown and grants.
--
-- Incidental note for whoever reads this next: the picks scan below casts
-- elem->>'bottle_id' to uuid across EVERY pick, including the outside pours
-- added in v0.13.26 (a beer or cocktail, which carry no bottle_id). That is
-- safe - ->> yields NULL, NULL::uuid is NULL, and `b.id = any(...)` never
-- matches NULL - but it is safe by luck rather than by design. Anything that
-- tightens this scan must keep tolerating bottle_id-less picks.
------------------------------------------------------------------
create or replace function cellar27_share_get_planned_flight(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_link_id uuid;
  v_owner   uuid;
  v_plan    planned_flights%rowtype;
  v_bottles jsonb;
begin
  select id, owner_user_id into v_link_id, v_owner
    from share_links
   where token       = p_token
     and revoked_at is null
     and expires_at  > now();
  if v_link_id is null then
    raise exception 'link_invalid' using errcode = 'P0001';
  end if;

  select * into v_plan
    from planned_flights
   where shared_via_link_id = v_link_id
     and user_id = v_owner;

  if v_plan.id is null then
    return null;
  end if;

  -- Sanitized bottles for each pick. Queried directly (security definer
  -- bypasses RLS) with the safe columns projected explicitly rather than
  -- to_jsonb() - drop, so a future column on bottles can't accidentally leak.
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
    from bottles b
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
    'soundtrack',    v_plan.soundtrack,
    'guest_view',    v_plan.guest_view,
    'bottles',       v_bottles
  );
end;
$$;

revoke all on function cellar27_share_get_planned_flight(text) from public;
grant execute on function cellar27_share_get_planned_flight(text) to anon, authenticated;

// CRUD + AI enrichment for saved/planned flights.

import { sb } from './supabase-client.js';
import { createRequest, waitForResponse } from './pairing-bus.js';

export async function listPlannedFlights() {
  const { data, error } = await sb.from('planned_flights')
    .select('*')
    .order('occasion_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getPlannedFlight(id) {
  const { data, error } = await sb.from('planned_flights')
    .select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function createPlannedFlight(row) {
  const { data: userData } = await sb.auth.getUser();
  if (!userData?.user) throw new Error('Not signed in');
  const insert = {
    user_id: userData.user.id,
    title: row.title || null,
    occasion_date: row.occasion_date || null,
    source_request_id: row.source_request_id || null,
    theme: row.theme || null,
    guests: row.guests ?? null,
    narrative: row.narrative || '',
    picks: row.picks || [],
    food: row.food || null,
    prep: row.prep || null,
    user_notes: row.user_notes || null,
    // Original ask captured at save time — never overwritten by AI
    // enrichment. Surfaces in the detail UI and flows through to the
    // flight_plan AI prompt so the model honors it.
    food_hint:  row.food_hint  || null,
    notes_hint: row.notes_hint || null,
  };
  const { data, error } = await sb.from('planned_flights').insert(insert).select().single();
  if (error) throw error;
  return data;
}

export async function updatePlannedFlight(id, patch) {
  const { data, error } = await sb.from('planned_flights')
    .update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deletePlannedFlight(id) {
  const { error } = await sb.from('planned_flights').delete().eq('id', id);
  if (error) throw error;
}

// Fire a flight_plan AI request for a saved flight. The watcher returns
// {food, prep} in pairing_responses.payload, which we then merge into the
// planned_flights row. includeCellar=false because the picks are already
// known and we don't want the prompt to re-pick from the wider cellar.
export async function requestFlightPlanEnrichment(plan) {
  const req = await createRequest({
    requestType: 'flight_plan',
    includeCellar: false,
    context: {
      planned_flight_id: plan.id,
      title: plan.title,
      occasion_date: plan.occasion_date,
      theme: plan.theme,
      guests: plan.guests,
      narrative: plan.narrative,
      picks: plan.picks,
      // Carry the original ask through to the watcher prompt so the
      // model anchors its food/prep suggestions on it instead of
      // generating generics.
      food_hint:  plan.food_hint  || null,
      notes_hint: plan.notes_hint || null,
    },
  });
  const response = await waitForResponse(req.id);
  const payload = response.payload || {};
  const patch = {};
  if (payload.food !== undefined) patch.food = payload.food;
  if (payload.prep !== undefined) patch.prep = payload.prep;
  if (Object.keys(patch).length) await updatePlannedFlight(plan.id, patch);
  return { request: req, response, patch };
}

// Attach this planned flight to the owner's currently-active share link
// so guests visiting #/guest/<token> see the Tonight tab. The unique
// index on planned_flights.shared_via_link_id enforces one-plan-per-link;
// surface that error legibly if it trips.
export async function attachPlannedFlightToShare(planId, shareLinkId) {
  return updatePlannedFlight(planId, { shared_via_link_id: shareLinkId });
}

export async function detachPlannedFlightFromShare(planId) {
  return updatePlannedFlight(planId, { shared_via_link_id: null });
}

// Fire a flight_guest AI request to generate the guest-facing walkthrough
// (intro + per-pour blocks). Runs as the owner — does NOT count against
// the share-link AI quota. Includes only the kept food so the model
// doesn't reference items the user deleted.
export async function requestGuestWalkthrough(plan) {
  const req = await createRequest({
    requestType: 'flight_guest',
    includeCellar: false,
    context: {
      planned_flight_id: plan.id,
      title: plan.title,
      occasion_date: plan.occasion_date,
      theme: plan.theme,
      guests: plan.guests,
      narrative: plan.narrative,
      picks: plan.picks,
      food: Array.isArray(plan.food) ? plan.food : [],
    },
  });
  const response = await waitForResponse(req.id);
  const payload = response.payload || null;
  if (payload && (payload.guest_intro || payload.pour_walkthrough)) {
    await updatePlannedFlight(plan.id, { guest_view: payload });
  }
  return { request: req, response, payload };
}

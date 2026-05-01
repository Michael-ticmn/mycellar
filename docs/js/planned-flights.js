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

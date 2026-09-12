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
    // Only the id — the watcher loads the row (title, theme, picks,
    // narrative, food_hint, notes_hint) with its service key. Sending the
    // flight inline used to blow the 4096-byte context cap on larger
    // flights; see hydratePlanContext() in watcher/src/index.js.
    context: { planned_flight_id: plan.id },
  });
  const response = await waitForResponse(req.id);
  const payload = response.payload || {};
  const patch = {};
  if (payload.food !== undefined) patch.food = payload.food;
  if (payload.prep !== undefined) patch.prep = payload.prep;

  // Outside pours: non-cellar drinks the narrative leans on (a Maerzen with the
  // pretzel, a cocktail to open). Appended to picks as suggestions with
  // include:false - nothing reaches guests until the host ticks the box.
  // Deduped by name so re-running enrichment doesn't stack copies, and the
  // host's existing include choices survive because we only ever append.
  if (Array.isArray(payload.outside_pours) && payload.outside_pours.length) {
    const current = Array.isArray(plan.picks) ? plan.picks : [];
    const wines   = current.filter((p) => !p.external);
    const byName  = new Map(current.filter((p) => p.external)
      .map((p) => [String(p.name || '').trim().toLowerCase(), p]));

    // Refresh each proposed pour, but the host's include choice always wins over
    // whatever the model returns - re-running enrichment must never quietly
    // publish (or unpublish) something to guests.
    const externals = [];
    for (const o of payload.outside_pours) {
      if (!o || !o.name) continue;
      const key  = String(o.name).trim().toLowerCase();
      const prev = byName.get(key);
      const pos  = Number(o.position);
      externals.push({
        external: true,
        include:  prev ? prev.include === true : false,
        category: o.category || 'other',
        name:     o.name,
        detail:   o.detail  || null,
        serving:  o.serving || null,
        note:     o.note    || null,
        position: Number.isFinite(pos) && pos > 0 ? Math.floor(pos) : null,
      });
      byName.delete(key);
    }
    // A pour the model has stopped proposing but the host chose to keep stays.
    for (const kept of byName.values()) externals.push(kept);

    // Splice into the wine order by 1-based position, because picks order IS
    // serve order and the Tonight tab numbers pours by array index. Appending
    // put a beer the narrative opens on at the end as "Pour 3".
    // Ascending, so each insert lands before later ones shift the indices.
    const merged = [...wines];
    externals.filter((e) => e.position)
      .sort((a, b) => a.position - b.position)
      .forEach((e) => merged.splice(Math.min(Math.max(e.position - 1, 0), merged.length), 0, e));
    externals.filter((e) => !e.position).forEach((e) => merged.push(e));

    patch.picks = merged;
  }
  if (Object.keys(patch).length) await updatePlannedFlight(plan.id, patch);

  // Soundtrack is patched SEPARATELY and tolerantly. planned_flights.soundtrack
  // arrives with migration 0020, which is applied by hand in the SQL Editor - so
  // between deploying this and running that, the column may not exist. Folding it
  // into the patch above would make a missing column cost the whole enrichment
  // its food, prep and outside pours. Degrading to "no soundtrack" is the right
  // failure.
  if (payload.soundtrack !== undefined) {
    try {
      await updatePlannedFlight(plan.id, { soundtrack: payload.soundtrack });
      patch.soundtrack = payload.soundtrack;
    } catch (e) {
      console.warn('soundtrack not saved - is migration 0020 applied?', e.message);
    }
  }

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
    // Only the id — the watcher loads picks/narrative/food from the row.
    // The kept-food filtering the comment above refers to is already
    // persisted (the food editor writes deletions back before this runs,
    // and the caller re-reads the row), so the fetched food matches what
    // was previously sent inline.
    context: { planned_flight_id: plan.id },
  });
  const response = await waitForResponse(req.id);
  const payload = response.payload || null;
  if (payload && (payload.guest_intro || payload.pour_walkthrough)) {
    await updatePlannedFlight(plan.id, { guest_view: payload });
  }
  return { request: req, response, payload };
}

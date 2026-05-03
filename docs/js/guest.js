// Guest-side helpers: read a shared cellar via a share-link token. No auth
// session required — calls SECURITY DEFINER RPCs granted to the anon role.
// See supabase/migrations/0006_share_links.sql + 0007_share_links_ai.sql.

import { sb } from './supabase-client.js';

export async function resolveShare(token) {
  const { data, error } = await sb.rpc('cellar27_share_resolve', { p_token: token });
  if (error) throw error;
  return Array.isArray(data) && data.length ? data[0] : null;
}

export async function listBottlesForShare(token) {
  const { data, error } = await sb.rpc('cellar27_share_list_bottles', { p_token: token });
  if (error) throw error;
  return data || [];
}

// Returns the planned flight currently attached to this token's share
// link, with sanitized bottle metadata for each pick — or null if the
// owner hasn't attached a plan yet. RPC is SECURITY DEFINER (anon-safe).
export async function getSharedPlannedFlight(token) {
  const { data, error } = await sb.rpc('cellar27_share_get_planned_flight', { p_token: token });
  if (error) throw new Error(prettyShareError(error));
  return data || null;
}

// Anon clients can't subscribe to RLS-protected tables via Realtime; poll the
// SECURITY DEFINER reader instead. Mirrors the timeout shape of waitForResponse
// in pairings.js (5 min cap).
async function createAndAwait(token, requestType, context) {
  const { data: requestId, error } = await sb.rpc('cellar27_share_create_pairing_request', {
    p_token: token,
    p_request_type: requestType,
    p_context: context,
  });
  if (error) throw new Error(prettyShareError(error));
  if (!requestId) throw new Error('Could not create request.');

  // Exponential backoff: most enrichments come back in 5–15s, so polling
  // every 2s for the full 5 min is wasteful (~150 RPC calls). Start tight
  // (500ms), double each round, cap at 5s. Worst-case call count drops
  // from ~150 to ~70 while keeping the same first-result latency.
  const deadline = Date.now() + 5 * 60_000;
  let delay = 500;
  while (Date.now() < deadline) {
    const { data, error: pollErr } = await sb.rpc('cellar27_share_get_response', {
      p_token: token,
      p_request_id: requestId,
    });
    if (pollErr) throw pollErr;
    const row = Array.isArray(data) && data.length ? data[0] : null;
    if (row?.status === 'completed' && row.recommendations !== null) {
      return { request_id: requestId, response: row };
    }
    if (row?.status === 'error') {
      throw new Error(row.error_message || 'Request failed.');
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 5000);
  }
  throw new Error('Timed out waiting for response (5 min).');
}

function prettyShareError(err) {
  const m = err?.message || String(err);
  if (m.includes('quota_exhausted')) return 'This share link has used up its request budget.';
  if (m.includes('link_invalid'))    return 'This share link is invalid, revoked, or has expired.';
  if (m.includes('rate_too_fast'))   return 'Slow down — wait a couple of seconds before sending another request.';
  return m;
}

export async function requestPairingForShare(token, { dish, guests, occasion, constraints }) {
  return createAndAwait(token, 'pairing', { dish, guests, occasion, constraints });
}

export async function requestFlightForShare(token, { theme, guests, length, food, notes }) {
  return createAndAwait(token, 'flight', {
    theme,
    guests,
    length,
    food:  food  || null,
    notes: notes || null,
  });
}

export async function requestFlightExtrasForShare(token, { themeHint }) {
  return createAndAwait(token, 'flight', { kind: 'extras', theme_hint: themeHint || null });
}

export async function requestDrinkNowForShare(token, { notes }) {
  return createAndAwait(token, 'drink_now', { notes: notes || null });
}

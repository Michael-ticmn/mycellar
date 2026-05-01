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

  const deadline = Date.now() + 5 * 60_000;
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
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Timed out waiting for response (5 min).');
}

function prettyShareError(err) {
  const m = err?.message || String(err);
  if (m.includes('quota_exhausted')) return 'This share link has used up its request budget.';
  if (m.includes('link_invalid'))    return 'This share link is invalid, revoked, or has expired.';
  return m;
}

export async function requestPairingForShare(token, { dish, guests, occasion, constraints }) {
  return createAndAwait(token, 'pairing', { dish, guests, occasion, constraints });
}

export async function requestFlightForShare(token, { theme, guests, length }) {
  return createAndAwait(token, 'flight', { theme, guests, length });
}

export async function requestFlightExtrasForShare(token, { themeHint }) {
  return createAndAwait(token, 'flight', { kind: 'extras', theme_hint: themeHint || null });
}

export async function requestDrinkNowForShare(token, { notes }) {
  return createAndAwait(token, 'drink_now', { notes: notes || null });
}

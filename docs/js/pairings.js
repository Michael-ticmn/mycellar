import { sb } from './supabase-client.js';
import { listBottles } from './bottles.js';

// Strip fields the AI doesn't need (acquired_price especially — see STRATEGY).
function snapshotForBridge(bottles) {
  return bottles.map((b) => ({
    id: b.id,
    producer: b.producer,
    wine_name: b.wine_name,
    varietal: b.varietal,
    blend_components: b.blend_components,
    vintage: b.vintage,
    region: b.region,
    country: b.country,
    style: b.style,
    sweetness: b.sweetness,
    body: b.body,
    quantity: b.quantity,
    drink_window_start: b.drink_window_start,
    drink_window_end: b.drink_window_end,
  }));
}

async function createRequest({ requestType, context }) {
  const { data: userData } = await sb.auth.getUser();
  if (!userData?.user) throw new Error('Not signed in');
  const bottles = await listBottles();
  if (!bottles.length) throw new Error('Cellar is empty — add bottles before requesting suggestions.');

  const { data, error } = await sb.from('pairing_requests').insert({
    user_id: userData.user.id,
    request_type: requestType,
    context,
    cellar_snapshot: snapshotForBridge(bottles),
  }).select().single();
  if (error) throw error;
  return data;
}

// Wait for a pairing_response row matching this request_id. Resolves with the
// response, or rejects on timeout / status='error'.
function waitForResponse(requestId, { timeoutMs = 5 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, val) => { if (done) return; done = true; clearTimeout(timer); channel.unsubscribe(); fn(val); };

    const timer = setTimeout(() => finish(reject, new Error('Timed out waiting for response (5 min).')), timeoutMs);

    const channel = sb.channel(`pairing-resp-${requestId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'pairing_responses', filter: `request_id=eq.${requestId}` },
        ({ new: row }) => finish(resolve, row))
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'pairing_requests', filter: `id=eq.${requestId}` },
        ({ new: row }) => { if (row.status === 'error') finish(reject, new Error(row.error_message || 'Request failed.')); })
      .subscribe(async (status) => {
        // After subscribing, check if the response already arrived (race).
        if (status === 'SUBSCRIBED') {
          const { data: existing } = await sb.from('pairing_responses').select('*').eq('request_id', requestId).maybeSingle();
          if (existing) finish(resolve, existing);
        }
      });
  });
}

export async function requestPairing({ dish, guests, occasion, constraints }) {
  const req = await createRequest({
    requestType: 'pairing',
    context: { dish, guests, occasion, constraints },
  });
  return { request: req, response: await waitForResponse(req.id) };
}

export async function requestFlight({ theme, guests, length }) {
  const req = await createRequest({
    requestType: 'flight',
    context: { theme, guests, length },
  });
  return { request: req, response: await waitForResponse(req.id) };
}

// Ask the sommelier for 1–2 wines NOT in the cellar that would expand
// flight-building potential. Recommendations array stays empty (those
// picks aren't owned); the actual suggestions live in the narrative.
export async function requestFlightExtras({ themeHint }) {
  const req = await createRequest({
    requestType: 'flight',
    context: { kind: 'extras', theme_hint: themeHint || null },
  });
  return { request: req, response: await waitForResponse(req.id) };
}

export async function requestDrinkNow({ notes }) {
  const req = await createRequest({
    requestType: 'drink_now',
    context: { notes: notes || null },
  });
  return { request: req, response: await waitForResponse(req.id) };
}

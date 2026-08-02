// Shared transport for pairing_requests / pairing_responses round-trips.
// Pulled out of pairings.js so planned-flights.js can reuse it without
// duplicating the realtime subscription dance.

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

// Most request types want the full cellar snapshot; flight_plan operates
// only on bottles already chosen, so we let callers pass an empty snapshot
// to avoid hauling the whole cellar through the watcher prompt.
export async function createRequest({ requestType, context, includeCellar = true }) {
  const { data: userData } = await sb.auth.getUser();
  if (!userData?.user) throw new Error('Not signed in');

  let snapshot = [];
  if (includeCellar) {
    const bottles = await listBottles();
    if (!bottles.length) throw new Error('Cellar is empty — add bottles before requesting suggestions.');
    snapshot = snapshotForBridge(bottles);
  }

  const { data, error } = await sb.from('pairing_requests').insert({
    user_id: userData.user.id,
    request_type: requestType,
    context,
    cellar_snapshot: snapshot,
  }).select().single();
  if (error) throw error;
  requestCreatedHook?.(data);
  return data;
}

// ── Claim watch ──────────────────────────────────────────────────────
//
// A request row lands at status='pending'. A running watcher claims it within
// about a second: pending → picked_up, claimed_by set. If the bridge isn't
// running — laptop asleep, rebooted by an update, process died, and nothing
// alerts on death — the row just stays pending.
//
// Both cases looked identical to the user for five minutes: the same pour
// animation, then a timeout that *guessed* at the cause ("may be asleep"). The
// status column already holds the answer, on a table the client can read. This
// stops the guessing.
//
// Grace period first, because a claim normally takes ~1s and a brief blip
// shouldn't flash a scary message. Then poll, and report transitions in both
// directions — a watcher that comes back mid-wait should quietly correct the
// message rather than leaving it wrong.
export const CLAIM_GRACE_MS = 12_000;
const CLAIM_POLL_MS = 5_000;

let requestCreatedHook = null;
// Lets withBusySubmit observe the request it is waiting on without every call
// site having to thread an id through. Pass null to clear.
export function onRequestCreated(fn) { requestCreatedHook = fn; }

export function watchClaim(table, requestId, { onUnclaimed, onClaimed } = {}) {
  let stopped = false;
  let timer = null;
  let reported = null;              // last state handed to the caller

  const check = async () => {
    if (stopped) return;
    const { data } = await sb.from(table).select('status').eq('id', requestId).maybeSingle();
    if (stopped || !data) return;
    const claimed = data.status !== 'pending';
    if (claimed === reported) return;
    reported = claimed;
    if (claimed) onClaimed?.(); else onUnclaimed?.();
  };

  const grace = setTimeout(() => {
    check().catch(() => { /* transient; next tick retries */ });
    timer = setInterval(() => { check().catch(() => {}); }, CLAIM_POLL_MS);
  }, CLAIM_GRACE_MS);

  return () => {
    stopped = true;
    clearTimeout(grace);
    if (timer) clearInterval(timer);
  };
}

// Wait for a pairing_response row matching this request_id. Resolves with the
// response, or rejects on timeout / status='error'.
//
// Realtime is a latency optimization here, not the source of truth. This used to
// subscribe, check once for an already-present row, and otherwise wait out a
// 5-minute timer — so a dropped socket (phone sleeping, wifi handoff, lid shut)
// turned a completed 40-second AI run into "Timed out". Realtime does not replay
// missed events, so the INSERT was simply never delivered.
//
// That mattered more than a bad error message: requestFlightPlanEnrichment and
// requestGuestWalkthrough merge the payload into the planned_flights row *after*
// this await, so a false timeout discarded real work and cost a second unit of
// the daily ceiling on the re-run.
//
// Same three guards scan.js has had since its own version of this bug — a DB
// re-check before ever reporting a timeout, a polling fallback while the channel
// is down, and explicit handling of the terminal statuses. The two paths do the
// same job and should fail the same way.
const RESPONSE_POLL_MS = 5_000;

export function waitForResponse(requestId, { timeoutMs = 5 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    let poll = null;

    const finish = (fn, val) => {
      if (done) return; done = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (poll)  { clearInterval(poll); poll = null; }
      try { channel.unsubscribe(); } catch { /* idempotent */ }
      fn(val);
    };

    // Authoritative check against the rows themselves.
    const settleFromDb = async () => {
      if (done) return true;
      const { data: resp } = await sb.from('pairing_responses')
        .select('*').eq('request_id', requestId).maybeSingle();
      if (resp) { finish(resolve, resp); return true; }
      const { data: req } = await sb.from('pairing_requests')
        .select('status, error_message').eq('id', requestId).maybeSingle();
      if (req?.status === 'error') {
        finish(reject, new Error(req.error_message || 'Request failed.'));
        return true;
      }
      return false;
    };

    const channel = sb.channel(`pairing-resp-${requestId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'pairing_responses', filter: `request_id=eq.${requestId}` },
        ({ new: row }) => finish(resolve, row))
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'pairing_requests', filter: `id=eq.${requestId}` },
        ({ new: row }) => { if (row.status === 'error') finish(reject, new Error(row.error_message || 'Request failed.')); })
      .subscribe(async (status) => {
        // finish() unsubscribes, which itself emits CLOSED — without this guard
        // that would start a polling interval after we're already done.
        if (done) return;
        if (status === 'SUBSCRIBED') {
          if (poll) { clearInterval(poll); poll = null; }
          await settleFromDb();   // response may have landed before we subscribed
          return;
        }
        if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') && !poll) {
          poll = setInterval(() => { settleFromDb().catch(() => { /* retry next tick */ }); }, RESPONSE_POLL_MS);
        }
      });

    timer = setTimeout(async () => {
      if (await settleFromDb()) return;
      const span = timeoutMs >= 60_000
        ? `${Math.round(timeoutMs / 60_000)} min`
        : `${Math.round(timeoutMs / 1_000)}s`;
      finish(reject, new Error(`Timed out waiting for response (${span}).`));
    }, timeoutMs);
  });
}

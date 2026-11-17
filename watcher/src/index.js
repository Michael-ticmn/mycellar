import { basename, extname } from 'node:path';
import { hostname } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import { CONFIG } from './config.js';
import { renderPairingRequest, renderScanRequest, picksOnHand } from './render.js';
import { getWeather } from './weather.js';
import { parsePairingResponse, parseScanResponse } from './parse.js';
import { askClaude, describeFailure } from './claude.js';
import { denyReason, isOwnedStoragePath } from './policy.js';
import { notify } from './notify.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);
const err = (...args) => console.error(new Date().toISOString(), ...args);

const HOST = hostname();

// ───────────────────────── error logging ─────────────────────────

// Network-level failures (DNS, connect timeout, socket reset) are weather, not
// bugs: during an internet outage every timer tick fails identically and the
// full multi-line fetch stack says nothing new. A 6-hour outage on 2026-08-02
// wrote 1,494 lines of duplicate ENOTFOUND / ConnectTimeoutError traces and
// buried everything else. Collapse consecutive network failures per operation
// to one line, then one line on recovery. Non-network errors still log in full
// — those are real and each one may differ.
const NETWORK_ERROR_RE =
  /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET/i;

function isNetworkError(error) {
  if (!error) return false;
  return NETWORK_ERROR_RE.test(
    `${error.message || ''} ${error.details || ''} ${error.code || ''}`);
}

// Pull the most informative single line out of a nested fetch error. Supabase
// wraps the real cause ("getaddrinfo ENOTFOUND …") several lines down under
// "Caused by:", so prefer that over the generic "TypeError: fetch failed".
function briefCause(error) {
  const text = String(error?.details || error?.message || error || '');
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  const caused = lines.find((s) => s.startsWith('Caused by:'));
  return (caused || lines[0] || 'unknown').replace(/^Caused by:\s*/, '').slice(0, 160);
}

// key → count of consecutive suppressed network failures for that operation.
const netFailures = new Map();

function logOpError(key, error) {
  if (!isNetworkError(error)) {
    netFailures.delete(key);
    err(`${key}:`, error);
    return;
  }
  const n = (netFailures.get(key) || 0) + 1;
  netFailures.set(key, n);
  if (n === 1) {
    err(`${key}: network unreachable (${briefCause(error)}) — suppressing repeats until it recovers`);
  }
}

// Call after an operation succeeds, so the next outage reports fresh and we
// get a durable record of how long the last one lasted.
function clearOpError(key) {
  const n = netFailures.get(key);
  if (n) {
    netFailures.delete(key);
    log(`${key}: network recovered after ${n} failed attempt(s)`);
  }
}

// An unexpected throw out of pickUp() is the one failure shape nothing else
// reports. Both sweeps swallow it so one bad row cannot stop the batch, and the
// realtime path only writes the message onto the row — so a watcher that is up
// and failing every request looks, from outside, exactly like a healthy one.
// On 2026-08-18 that was not hypothetical: a TDZ ReferenceError failed 100% of
// pairing requests, and the first anyone knew of it was the app refusing new
// work once the stranded rows filled the 5-in-flight cap.
//
// Network errors are excluded on the same reasoning as logOpError(): this runs
// on a laptop that sleeps, they arrive in bursts, and they clear on their own.
// Everything else here means the watcher cannot do its job and needs a person.
//
// Reported per batch rather than per row: a sweep that fails five rows for one
// reason should say five, not send one email that undercounts it and then
// suppress the rest under the cooldown.
let pickUpFailuresSinceStart = 0;

function reportPickUpFailures(where, table, failures) {
  const real = failures.filter((f) => !isNetworkError(f.error));
  if (!real.length) return;
  pickUpFailuresSinceStart += real.length;
  const [{ error }] = real;
  notify({
    key: 'pickup-failure',
    subject: `cellar27 — watcher is running but failing requests (${real.length} in ${where})`,
    body: [
      `The watcher is up and claiming rows, but pickUp() threw on ${real.length}`,
      `row(s) in ${where} on ${table}. Nothing else reports this: the process is`,
      `alive, realtime is subscribed, and the app looks normal until requests`,
      `start piling up against the 5-in-flight cap.`,
      ``,
      `Time:  ${new Date().toISOString()}`,
      `Host:  ${HOST}`,
      `Failed this batch:  ${real.length}`,
      `Failed since start: ${pickUpFailuresSinceStart}`,
      ``,
      `First error:`,
      `  ${String(error?.stack || error?.message || error).slice(0, 400)}`,
      ``,
      `Rows: ${real.map((f) => f.id).join(', ')}`,
      ``,
      `Rows left in picked_up recover on their own — cellar27_sweep_stale_claims`,
      `resets them after ${CONFIG.timeoutMinutes} min, twice, then marks them error.`,
      `That retry is wasted if the cause is a code bug, so check first:`,
      ``,
      `  watcher/watcher.err.log   — full stack traces`,
      `  watcher/README.md         — 'Where it runs' for the restart procedure`,
      ``,
      `Further emails on this are suppressed for the notify cooldown window.`,
    ].join('\n'),
  });
}

const sb = createClient(CONFIG.supabaseUrl, CONFIG.supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Track resources for graceful shutdown + per-channel reconnect state.
// channels: name → the CURRENT channel handle. Doubles as an identity check —
//   status callbacks from a handle that is no longer the current one are
//   ignored, so our own unsubscribe()-induced CLOSED can't look like a drop.
// reconnect: name → { attempts, timer }, created once per name and never
//   replaced, so there is exactly one reconnect chain per channel.
const channels = new Map();
const reconnect = new Map();
let sweepTimer = null;

// Channel definitions — name → table. Used by both initial subscribe and
// reconnect, so we don't drift if the row-handler shape ever needs to
// change. Declared before top-level await so subscribeChannel() (called
// indirectly from line below) can read it without TDZ errors.
const CHANNEL_DEFS = {
  'pairing-requests': 'pairing_requests',
  'scan-requests':    'scan_requests',
};

// Same reason: the startup sweep below awaits pickUp(), which reaches
// hydratePlanContext(). Function declarations hoist, but these consts do not —
// beside that function they sat in the TDZ for the whole sweep.
const PLAN_BACKED_TYPES = new Set(['flight_plan', 'flight_guest']);
const PLAN_CONTEXT_FIELDS = [
  'title', 'occasion_date', 'theme', 'guests',
  'narrative', 'picks', 'food', 'food_hint', 'notes_hint',
];

await sweepStaleRequests(); // catch up on anything queued while we were down
await sweepStaleClaims();   // recover any picked_up rows abandoned by a prior crash
subscribePairingRequests();
subscribeScanRequests();
sweepTimer = setInterval(sweepStaleClaims, 120_000);

log(`cellar27-watcher running. Model: ${CONFIG.anthropic.model}, effort ${CONFIG.anthropic.effort}.`);

// ───────────────────────── setup ─────────────────────────

// On startup (and on realtime reconnect), pull anything stuck in 'pending'
// that we missed. Realtime doesn't replay missed INSERTs, so any row that
// landed during a connection gap stays pending forever without this.
async function sweepTable(table) {
  const { data, error } = await sb.from(table).select('*').eq('status', 'pending');
  if (error) { logOpError(`sweep ${table}`, error); return; }
  clearOpError(`sweep ${table}`);
  const failures = [];
  for (const row of data || []) {
    log(`sweep: picking up stale ${table}.${row.id}`);
    try { await pickUp(table, row); }
    catch (e) { err(`sweep pickUp ${row.id}:`, e); failures.push({ id: row.id, error: e }); }
  }
  reportPickUpFailures('the startup/reconnect sweep', table, failures);
}
async function sweepStaleRequests() {
  for (const table of ['pairing_requests', 'scan_requests']) {
    await sweepTable(table);
  }
}

// ───────────────────────── inbound (Supabase → file) ─────────────────────────

function subscribeChannel(name) {
  const table = CHANNEL_DEFS[name];

  // Any pending reconnect for this name is moot — we're subscribing right now.
  // Clearing it stops an orphaned timer from firing later and tearing down the
  // channel we're about to create.
  clearReconnectTimer(name);

  // Drop any previous channel with the same name before replacing the ref —
  // realtime tracks subs by name; leaving the old one connected wastes a slot
  // and produces duplicate INSERT events during the brief overlap.
  //
  // Clear the ref BEFORE unsubscribing: unsubscribe() emits CLOSED on the prior
  // handle, and onChannelStatus ignores status from any non-current channel.
  // Without that ordering, our own teardown looks like a drop and schedules
  // another reconnect — which tears down the next channel, forever.
  const prior = channels.get(name);
  channels.delete(name);
  if (prior) {
    try { prior.unsubscribe(); } catch { /* best-effort */ }
  }

  const ch = sb.channel(name)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table },
      async ({ new: row }) => {
        if (row.status !== 'pending') return;
        try { await pickUp(table, row); }
        catch (e) {
          err(`${name} pickUp:`, e);
          await markError(table, row.id, String(e?.message || e));
          reportPickUpFailures('the realtime handler', table, [{ id: row.id, error: e }]);
        }
      });
  // Register as current before subscribing, so a synchronously-delivered
  // SUBSCRIBED isn't mistaken for a stale channel's callback.
  channels.set(name, ch);
  ch.subscribe((status) => onChannelStatus(name, ch, status));
}

function subscribePairingRequests() { subscribeChannel('pairing-requests'); }
function subscribeScanRequests()    { subscribeChannel('scan-requests'); }

// Realtime status handler. On terminal errors we don't kill the process —
// the watcher runs as a detached node.exe with no supervisor, so exit
// would mean silent death until the next manual restart. Reconnect in
// place with exponential backoff instead, and on successful re-subscribe
// run a stale-pending sweep so we catch any INSERTs that fired during
// the dead window (realtime doesn't replay missed events).
function onChannelStatus(name, ch, status) {
  // Ignore status from a channel we've already replaced. Our own
  // subscribeChannel() unsubscribes the prior handle, which emits CLOSED;
  // treating that as a drop is what made reconnects self-sustaining. Stale
  // handles left inside supabase-js get filtered here too.
  if (channels.get(name) !== ch) return;

  log(`${name} channel:`, status);
  if (status === 'SUBSCRIBED') {
    const state = reconnect.get(name);
    if (state?.attempts) {
      log(`${name} reconnected after ${state.attempts} attempt(s); sweeping stale pending`);
      // Catch up on anything inserted while the channel was down. We sweep
      // only this channel's table, not all of them, so a flapping channel
      // doesn't cause O(N) sweeps elsewhere.
      sweepTable(CHANNEL_DEFS[name]).catch((e) => err(`reconnect sweep ${name}:`, e));
    }
    // Reset the backoff but KEEP the entry. Deleting it would hide a still-
    // pending timer from scheduleReconnect's debounce, letting a second
    // independent reconnect chain start — that's how one loop became 14.
    clearReconnectTimer(name);
    if (state) state.attempts = 0;
    return;
  }
  if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
    scheduleReconnect(name);
  }
}

// Single state object per channel name, created once and never replaced, so
// there is exactly one reconnect chain per channel for the process lifetime.
function reconnectState(name) {
  let state = reconnect.get(name);
  if (!state) {
    state = { attempts: 0, timer: null };
    reconnect.set(name, state);
  }
  return state;
}

function clearReconnectTimer(name) {
  const state = reconnect.get(name);
  if (state?.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function scheduleReconnect(name) {
  const state = reconnectState(name);
  if (state.timer) return; // already scheduled — debounce repeated status callbacks
  state.attempts += 1;
  // 2, 4, 8, 16, 32, 60, 60, … (capped at 60s)
  const delay = Math.min(2_000 * 2 ** (state.attempts - 1), 60_000);
  err(`${name} dropped; reconnect attempt ${state.attempts} in ${delay / 1000}s`);
  state.timer = setTimeout(() => {
    state.timer = null;
    try { subscribeChannel(name); }
    catch (e) {
      err(`${name} resubscribe threw:`, e);
      scheduleReconnect(name);
    }
  }, delay);
}

// flight_plan / flight_guest are backed by a saved planned_flights row. The
// client used to ship the whole thing (picks + narrative + food) inline through
// pairing_requests.context, which is capped at 4096 bytes by
// pairing_requests_context_size — a flight with 5 food items hit 4367 B and the
// insert failed outright. Clients now send just planned_flight_id and we load
// the row here with the service key.
//
// Hydrating into row.context (rather than changing render.js) keeps the
// renderer reading every field off the context exactly as before. Inline values
// win over fetched ones, so a client still sending the full context behaves
// identically — that's what lets the app and the watcher deploy independently.
async function hydratePlanContext(row) {
  if (!PLAN_BACKED_TYPES.has(row.request_type)) return row;
  const planId = row.context?.planned_flight_id;
  if (!planId) return row;

  // Scoped to the requesting row's owner. This client holds the service-role
  // key, so RLS does not apply — without the user_id predicate, any
  // authenticated user could name someone else's planned_flight_id and have its
  // title, theme, narrative, picks and hints rendered into their own agent
  // prompt, then read the answer back off their own pairing_responses row.
  // Correct for flight_guest too: those rows carry the host's user_id, and the
  // plan belongs to the host.
  const { data, error } = await sb.from('planned_flights')
    .select('*').eq('id', planId).eq('user_id', row.user_id).maybeSingle();
  if (error || !data) {
    // Fall back to whatever the client sent rather than failing the request.
    err(`hydrate planned_flight ${planId}:`, error?.message || 'row not found');
    return row;
  }

  const context = { ...(row.context || {}) };
  let filled = 0;
  for (const field of PLAN_CONTEXT_FIELDS) {
    if (context[field] == null && data[field] != null) { context[field] = data[field]; filled++; }
  }
  log(`hydrated ${row.request_type} from planned_flights.${planId} (${filled} field(s))`);
  return { ...row, context };
}

// isRetry marks a row the stale-claim sweep sent back to 'pending'. It's the
// same user request being processed again, so it must not consume a second
// rate-limit slot. (It does still consume a daily-ceiling slot, and should:
// that counter measures actual Claude calls, and a retry is a real one.)
async function pickUp(table, row, { isRetry = false } = {}) {
  // Policy gate: allowlist + rate limit. Reject pre-claim so the request shows
  // status=error to the client immediately, without calling Claude.
  const denied = denyReason(row.user_id, {
    // Guest-originated rows carry share_link_id and are already bounded by the
    // link's ai_quota and the per-link pacing guard; keep the watcher backstop
    // per-link too rather than billing it to the host.
    subject: row.share_link_id ? `share:${row.share_link_id}` : row.user_id,
    record: !isRetry,
  });
  if (denied) {
    log(`policy deny ${table}.${row.id}: ${denied}`);
    await sb.from(table).update({
      status: 'error',
      error_message: `policy: ${denied}`,
    }).eq('id', row.id).eq('status', 'pending');
    notify({
      key: `policy:${row.user_id}`,
      subject: `cellar27 — limit hit (${row.user_id.slice(0, 8)})`,
      body: [
        `User ${row.user_id} hit a watcher-side limit on cellar27.`,
        ``,
        `Reason: ${denied}`,
        `Time:   ${new Date().toISOString()}`,
        `Table:  ${table}`,
        ``,
        `What this likely means:`,
        `  - "rate limit: N/${process.env.WATCHER_RATE_LIMIT_PER_HOUR || 100} requests in last hour"`,
        `      → in-memory window. Restart the watcher to clear it,`,
        `        or raise WATCHER_RATE_LIMIT_PER_HOUR in watcher/.env.`,
        `  - "user X not on allowlist"`,
        `      → only on the allowlist when added to cellar27_allowed_users.`,
        ``,
        `See docs/SECURITY.md for tuning options.`,
      ].join('\n'),
    }).catch((e) => err('notify policy:', e));
    return;
  }

  // Re-check + atomically claim with status='picked_up' to avoid double-processing.
  const { data: claimed, error: claimErr } = await sb.from(table)
    .update({ status: 'picked_up', picked_up_at: new Date().toISOString(), claimed_by: HOST })
    .eq('id', row.id).eq('status', 'pending')
    .select().single();
  if (claimErr || !claimed) { log(`already claimed: ${table}.${row.id}`); return; }

  // Fetch current weather (cached 30 min, returns null on failure / not
  // configured). Awaited up front so it can flow into either render path.
  const weather = await getWeather();

  // content: the single user turn sent to the API. Label photos first, each
  // after a line naming it, then the rendered request.
  let content;
  if (table === 'pairing_requests') {
    const prompt = renderPairingRequest(await hydratePlanContext(claimed), weather);
    content = [{ type: 'text', text: prompt }];
    log(`rendered pairing ${claimed.id} (${claimed.request_type})`);
  } else if (table === 'scan_requests') {
    const paths = Array.isArray(claimed.image_paths) ? claimed.image_paths : [];
    // image_paths is client-written: submitScanRequest passes through whatever
    // it's handed, and the RLS policy on scan_requests only constrains user_id.
    // We fetch these with the service key, which is not subject to the bucket's
    // per-user folder policies — so without this check a request naming
    // "<someone-else>/scan-<uuid>-front.jpg" would have the model read and
    // describe a stranger's label photo. Object paths aren't secret either: a
    // guest-label signed URL embeds one in full.
    //
    // Refuse the whole request rather than skipping the offending path. A path
    // outside the requester's own prefix means a bug or an attempt, and neither
    // should be quietly downgraded into a partial scan.
    const foreign = paths.filter((p) => !isOwnedStoragePath(p, claimed.user_id));
    if (foreign.length) {
      err(`scan ${claimed.id}: ${foreign.length} image path(s) outside user ${claimed.user_id}'s prefix; refusing`);
      await markError(table, claimed.id, 'Image path is not yours.');
      return;
    }
    const unsupported = paths.filter((p) => !IMAGE_MEDIA_TYPES[extname(p).toLowerCase() || '.jpg']);
    if (unsupported.length) {
      err(`scan ${claimed.id}: unsupported image type(s): ${unsupported.join(', ')}`);
      await markError(table, claimed.id, 'Unsupported image type.');
      return;
    }

    // Straight from Storage into the request: the photos never touch this disk.
    // Parallel, so a two-photo scan doesn't pay for two sequential downloads.
    const images = await Promise.all(paths.map(async (storagePath, i) => {
      const ext = extname(storagePath).toLowerCase() || '.jpg';
      // Convention: paths are uploaded as ".../scan-<uuid>-<label>.jpg".
      // Extract the label from the basename if present, else fall back to index.
      const baseLabel = basename(storagePath, extname(storagePath)).split('-').pop();
      const label = ['front', 'back', 'side', 'top'].includes(baseLabel) ? baseLabel : `image${i + 1}`;
      return { label, mediaType: IMAGE_MEDIA_TYPES[ext], data: await downloadImage(storagePath) };
    }));

    // For 'enrich' intent, optionally fetch the bottle row to give the model context.
    let existingBottle = null;
    if (claimed.intent === 'enrich' && claimed.context?.bottle_id) {
      // user_id predicate for the same reason as hydratePlanContext: the
      // service-role key bypasses RLS, and context.bottle_id is client-supplied.
      const { data, error: bErr } = await sb
        .from('bottles')
        .select('id, producer, wine_name, varietal, blend_components, vintage, region, country, style, sweetness, body, drink_window_start, drink_window_end, notes')
        .eq('id', claimed.context.bottle_id)
        .eq('user_id', claimed.user_id)
        .maybeSingle();
      if (bErr) throw bErr;
      existingBottle = data;
    }

    const prompt = renderScanRequest(claimed, images.map((img) => img.label), existingBottle, weather);
    content = [
      ...images.flatMap((img) => [
        { type: 'text', text: `Label photo: ${img.label}` },
        { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } },
      ]),
      { type: 'text', text: prompt },
    ];
    log(`rendered scan ${claimed.id} (intent=${claimed.intent}, images=${images.length})`);
  } else {
    return;
  }

  // Global daily ceiling: refuse to call the API if we're at cap. Atomic upsert
  // in Postgres (cellar27_try_record_spawn, named for the old per-request
  // process) so two watchers / parallel requests can't race past the limit.
  const { data: allowed, error: ceilErr } = await sb.rpc('cellar27_try_record_spawn', {
    p_max: CONFIG.maxClaudeCallsPerDay,
  });
  if (ceilErr) {
    err('try_record_spawn:', ceilErr);
    // Fail closed: if we can't talk to Postgres, don't call either.
    await sb.from(table).update({
      status: 'error',
      error_message: `ceiling check failed: ${ceilErr.message}`,
    }).eq('id', claimed.id);
    return;
  }
  if (allowed !== true) {
    log(`DAILY CEILING REACHED (${CONFIG.maxClaudeCallsPerDay}); refusing to call for ${table}.${claimed.id}`);
    await sb.from(table).update({
      status: 'error',
      error_message: `Daily AI capacity reached (${CONFIG.maxClaudeCallsPerDay}). Resets at midnight UTC.`,
    }).eq('id', claimed.id);
    notify({
      key: 'daily-ceiling',
      subject: `cellar27 — daily Claude ceiling reached (${CONFIG.maxClaudeCallsPerDay})`,
      body: [
        `cellar27 has hit the global daily Claude-call ceiling.`,
        ``,
        `Cap:    ${CONFIG.maxClaudeCallsPerDay}`,
        `Time:   ${new Date().toISOString()}`,
        `Table:  ${table}`,
        `User:   ${claimed.user_id}`,
        ``,
        `Resets at UTC midnight. To allow more today:`,
        `  1) Bump MAX_CLAUDE_CALLS_PER_DAY in watcher/.env`,
        `  2) update cellar27_watcher_metrics set spawn_count = 0`,
        `       where metric_date = current_date;`,
        `  3) Restart the watcher.`,
        ``,
        `If this looks unexpected, check cellar27_audit_log (if enabled)`,
        `or scan logs for a runaway loop. See docs/SECURITY.md.`,
      ].join('\n'),
    }).catch((e) => err('notify ceiling:', e));
    return;
  }

  // Not awaited. The sweeps call pickUp() row by row and a call takes 20-60 s;
  // claude.js queues and caps concurrency, and answer() records the outcome on
  // the row whichever way it goes.
  answer(table, claimed, content);
}

// The label photos are uploaded by the app as JPEG. Anything else is refused
// up front rather than sent with a guessed media type.
const IMAGE_MEDIA_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
};

async function downloadImage(storagePath) {
  const { data, error } = await sb.storage.from(CONFIG.storageBucket).download(storagePath);
  if (error) throw new Error(`storage download failed: ${error.message}`);
  return Buffer.from(await data.arrayBuffer()).toString('base64');
}

// ───────────────────────── answer (API → Supabase) ─────────────────────────

// The answer is bound to its request by construction: this function holds the
// claimed row, so nothing the model writes can attach it to another request.
// (The file bridge needed request_id-vs-filename checks for that; gone with it.)
async function answer(table, claimed, content) {
  try {
    const text = await askClaude(claimed.id, content);
    if (table === 'pairing_requests') await completePairing(claimed, text);
    else await completeScan(claimed, text);
  } catch (e) {
    const { userMessage, ownerShouldKnow } = describeFailure(e);
    err(`answer ${table}.${claimed.id}:`, e?.message || e);
    // Nothing awaits answer(), so anything thrown from here would be an
    // unhandled rejection, which is fatal by design (see fatalAndExit).
    try { await markError(table, claimed.id, userMessage); }
    catch (me) { err(`markError ${table}.${claimed.id}:`, me?.message || me); }
    if (ownerShouldKnow && !isNetworkError(e)) notifyApiFailure(table, claimed.id, e);
  }
}

// A failure the user can't fix by trying again. Same shape and cooldown as the
// other alerts; the likeliest cause, once this is running for a while, is the
// month's credits running out.
function notifyApiFailure(table, id, e) {
  notify({
    key: 'claude-api',
    subject: 'cellar27 — Claude API calls are failing',
    body: [
      `A request reached the Claude API and failed in a way retrying won't fix.`,
      `The user was told "The sommelier is unavailable right now."`,
      ``,
      `Time:    ${new Date().toISOString()}`,
      `Host:    ${HOST}`,
      `Request: ${table}.${id}`,
      `Error:   ${e?.constructor?.name || 'Error'}${e?.status ? ` (HTTP ${e.status})` : ''}`,
      `  ${String(e?.message || e).slice(0, 400)}`,
      ``,
      `Usual causes:`,
      `  - The month's API credits are used up ("credit balance is too low").`,
      `    See Promotional credits on the Console's Billing page. They refresh`,
      `    with the Max plan's billing cycle.`,
      `  - ANTHROPIC_API_KEY in watcher/.env is wrong or was revoked.`,
      `  - CELLAR27_MODEL names a model this org can't use.`,
      `  - Anything else: watcher log, with the full error.`,
      ``,
      `Further emails on this are suppressed for the notify cooldown window.`,
    ].join('\n'),
  }).catch((ne) => err('notify api failure:', ne));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Both response tables have a unique index on request_id. Completion is two
// steps, insert then mark completed, and only the first is guarded by that
// index. If the insert lands and the update fails, the row stays 'picked_up',
// the stale-claim sweep retries it, and the second insert hits the index. A
// duplicate key means the response is already stored, which is the outcome we
// wanted: log it and carry on to the idempotent update.
function isDuplicateKey(error) {
  return error?.code === '23505' || /duplicate key value/i.test(error?.message || '');
}

async function completePairing(claimed, text) {
  const parsed = parsePairingResponse(text);

  // The model is shown only on-hand bottles (render.js onHand), so a pick naming
  // any other id is either invented or a bottle already poured out when the
  // request was made. The app can't act on either; drop that pick and keep the
  // rest. Planned flights have no picks here: theirs are saved on the plan.
  let recommendations = parsed.recommendations;
  if (!PLAN_BACKED_TYPES.has(claimed.request_type)) {
    recommendations = picksOnHand(recommendations, claimed.cellar_snapshot);
    const dropped = parsed.recommendations.length - recommendations.length;
    if (dropped) log(`pairing ${claimed.id}: dropped ${dropped} pick(s) not on hand in the request's snapshot`);
  }

  const { error: insErr } = await sb.from('pairing_responses').insert({
    request_id: claimed.id,
    recommendations,
    narrative: parsed.narrative,
    payload: parsed.payload,
  });
  if (insErr && !isDuplicateKey(insErr)) throw insErr;
  if (insErr) log(`pairing ${claimed.id}: response already stored; finishing`);

  const { error: updErr } = await sb.from('pairing_requests')
    .update({ status: 'completed' })
    .eq('id', claimed.id);
  if (updErr) throw updErr;
  log(`completed pairing ${claimed.id}`);
}

// Returns the id if it is a real bottle belonging to whoever made this scan
// request, else null. Never throws: a bad match is a reason to drop one field,
// not to lose the response.
async function verifyMatchedBottle(candidate, claimed) {
  if (candidate == null) return null;
  const id = String(candidate).trim();
  if (!UUID_RE.test(id)) {
    log(`scan ${claimed.id}: matched_bottle_id is not a uuid; dropping it`);
    return null;
  }
  const { data: bottle, error } = await sb.from('bottles')
    .select('id').eq('id', id).eq('user_id', claimed.user_id).maybeSingle();
  if (error) {
    log(`scan ${claimed.id}: could not verify matched_bottle_id (${error.message}); dropping it`);
    return null;
  }
  if (!bottle) {
    log(`scan ${claimed.id}: matched_bottle_id ${id} is not a bottle of this user; dropping it`);
    return null;
  }
  return id;
}

async function completeScan(claimed, text) {
  const parsed = parseScanResponse(text);

  // scan_responses has no `details` column: details ride along inside
  // `extracted` (as extracted.details) and the frontend splits them back out.
  let extracted = parsed.extracted;
  if (parsed.details) {
    extracted = { ...(extracted || {}), details: parsed.details };
  }

  // matched_bottle_id is a uuid column with an FK to bottles, and its value
  // comes straight out of the model's JSON. A model that invents a plausible id
  // (or emits a non-uuid string) would fail the insert on the cast or the FK
  // and take `extracted` and `narrative` down with it — fields that were
  // probably fine. Verify it instead, and drop just that field when it doesn't
  // hold up. A null matched_bottle_id is the ordinary "no match found" answer
  // the client already renders.
  const matchedBottleId = await verifyMatchedBottle(parsed.matched_bottle_id, claimed);

  const { error: insErr } = await sb.from('scan_responses').insert({
    request_id: claimed.id,
    extracted,
    matched_bottle_id: matchedBottleId,
    match_candidates: parsed.match_candidates,
    narrative: parsed.narrative,
  });
  if (insErr && !isDuplicateKey(insErr)) throw insErr;
  if (insErr) log(`scan ${claimed.id}: response already stored; finishing`);

  const { error: updErr } = await sb.from('scan_requests')
    .update({ status: 'completed' })
    .eq('id', claimed.id);
  if (updErr) throw updErr;
  log(`completed scan ${claimed.id}`);
}

// ───────────────────────── stale-claim sweep ─────────────────────────

// Calls cellar27_sweep_stale_claims in Postgres, which atomically resets
// timed-out 'picked_up' rows to 'pending' (up to 2 retries) or marks them
// 'error'. For each row sent back to 'pending' we re-pick it up here,
// since INSERT-only realtime subscriptions don't fire on UPDATE.
async function sweepStaleClaims() {
  const { data, error } = await sb.rpc('cellar27_sweep_stale_claims', {
    p_timeout_minutes: CONFIG.timeoutMinutes,
    p_max_retries: 2,
  });
  if (error) { logOpError('sweep_stale_claims', error); return; }
  clearOpError('sweep_stale_claims');
  for (const row of data || []) {
    log(`sweep ${row.action}: ${row.table_name}.${row.request_id}`);
    if (row.action !== 'retry') continue;
    const { data: full, error: fetchErr } = await sb
      .from(row.table_name).select('*').eq('id', row.request_id).single();
    if (fetchErr || !full) { err(`refetch retry row:`, fetchErr); continue; }
    try { await pickUp(row.table_name, full, { isRetry: true }); }
    catch (e) {
      err(`retry pickUp ${row.request_id}:`, e);
      reportPickUpFailures('a stale-claim retry', row.table_name, [{ id: row.request_id, error: e }]);
    }
  }
}

async function markError(table, id, message) {
  await sb.from(table).update({ status: 'error', error_message: message }).eq('id', id);
}

// ───────────────────────── lifecycle ─────────────────────────

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}, shutting down`);
  if (sweepTimer) clearInterval(sweepTimer);
  for (const state of reconnect.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  reconnect.clear();
  for (const ch of channels.values()) {
    try { await ch.unsubscribe(); } catch (e) { err('unsubscribe:', e?.message || e); }
  }
  channels.clear();
  // Calls still in flight are abandoned: their rows stay 'picked_up' and the
  // stale-claim sweep returns them to 'pending' after the next start.
  log('shutdown complete');
  process.exit(0);
}
process.on('SIGINT',  () => { shutdown('SIGINT').catch(()  => process.exit(1)); });
process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });

// Fail-fast on unhandled rejections / uncaught exceptions. These reflect bugs,
// not transient network drops — continuing in a corrupted state is worse than
// dying.
//
// Email via the existing notify() SMTP path before exiting so the owner finds
// out at the moment of death rather than when they next try to use the app.
// That mattered most when the watcher ran with no supervisor (2026-05-01: a
// real morning request stuck in pending). Under systemd the unit restarts it,
// and the notify cooldown keeps a crash loop from flooding the inbox.
async function fatalAndExit(reason, body) {
  err(`FATAL ${reason}:`, body);
  // Race the email against a 5-second timeout — don't let a hung SMTP
  // server keep us alive in a broken state. notify() has its own per-key
  // cooldown so a flapping process doesn't spam the inbox.
  try {
    await Promise.race([
      notify({
        key: `watcher-fatal:${reason}`,
        subject: `cellar27 watcher died (${reason}) on ${HOST}`,
        body: [
          `The cellar27 watcher on ${HOST} hit a fatal error and exited.`,
          ``,
          `Reason: ${reason}`,
          `Time:   ${new Date().toISOString()}`,
          ``,
          `Detail:`,
          String(body).slice(0, 3000),
          ``,
          `Restart procedure: see watcher/README.md "Where it runs". Until`,
          `restart, any new pair / scan request from the phone will sit in`,
          `status='pending' and the user will see a spinner.`,
        ].join('\n'),
      }),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch (e) {
    err('notify (fatal path) failed:', e?.message || e);
  }
  process.exit(1);
}

process.on('unhandledRejection', (reason) => {
  fatalAndExit('unhandledRejection', reason?.stack || String(reason));
});
process.on('uncaughtException', (e) => {
  fatalAndExit('uncaughtException', e?.stack || String(e));
});

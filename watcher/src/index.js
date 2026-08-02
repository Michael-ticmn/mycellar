import { mkdir, writeFile, readFile, rename, unlink } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { hostname } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import chokidar from 'chokidar';
import { CONFIG } from './config.js';
import { renderPairingRequest, renderScanRequest } from './render.js';
import { getWeather } from './weather.js';
import { parsePairingResponse, parseScanResponse } from './parse.js';
import { invokeBridgeAgent } from './agent.js';
import { denyReason } from './policy.js';
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
let responsesWatcher = null;
let sweepTimer = null;

// Channel definitions — name → table. Used by both initial subscribe and
// reconnect, so we don't drift if the row-handler shape ever needs to
// change. Declared before top-level await so subscribeChannel() (called
// indirectly from line below) can read it without TDZ errors.
const CHANNEL_DEFS = {
  'pairing-requests': 'pairing_requests',
  'scan-requests':    'scan_requests',
};

await ensureDirs();
await sweepStaleRequests(); // catch up on anything queued while we were down
await sweepStaleClaims();   // recover any picked_up rows abandoned by a prior crash
subscribePairingRequests();
subscribeScanRequests();
watchResponses();
sweepTimer = setInterval(sweepStaleClaims, 120_000);

log('cellar27-watcher running. Bridge dir:', CONFIG.bridgeDir);

// ───────────────────────── setup ─────────────────────────

async function ensureDirs() {
  for (const dir of Object.values(CONFIG.dirs)) {
    await mkdir(dir, { recursive: true });
  }
}

// On startup (and on realtime reconnect), pull anything stuck in 'pending'
// that we missed. Realtime doesn't replay missed INSERTs, so any row that
// landed during a connection gap stays pending forever without this.
async function sweepTable(table) {
  const { data, error } = await sb.from(table).select('*').eq('status', 'pending');
  if (error) { logOpError(`sweep ${table}`, error); return; }
  clearOpError(`sweep ${table}`);
  for (const row of data || []) {
    log(`sweep: picking up stale ${table}.${row.id}`);
    try { await pickUp(table, row); }
    catch (e) { err(`sweep pickUp ${row.id}:`, e); }
  }
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
        catch (e) { err(`${name} pickUp:`, e); await markError(table, row.id, String(e?.message || e)); }
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
const PLAN_BACKED_TYPES = new Set(['flight_plan', 'flight_guest']);
const PLAN_CONTEXT_FIELDS = [
  'title', 'occasion_date', 'theme', 'guests',
  'narrative', 'picks', 'food', 'food_hint', 'notes_hint',
];

async function hydratePlanContext(row) {
  if (!PLAN_BACKED_TYPES.has(row.request_type)) return row;
  const planId = row.context?.planned_flight_id;
  if (!planId) return row;

  const { data, error } = await sb.from('planned_flights')
    .select('*').eq('id', planId).maybeSingle();
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
// that counter measures actual claude spawns, and a retry is a real one.)
async function pickUp(table, row, { isRetry = false } = {}) {
  // Policy gate: allowlist + rate limit. Reject pre-claim so the request shows
  // status=error to the client immediately, without spawning claude.
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

  let reqPath;
  if (table === 'pairing_requests') {
    const fileName = `req-${claimed.id}.md`;
    const respondTo = join(CONFIG.dirs.responses, fileName);
    const body = renderPairingRequest(await hydratePlanContext(claimed), respondTo, weather);
    reqPath = join(CONFIG.dirs.requests, fileName);
    await writeFile(reqPath, body, 'utf8');
    log(`wrote pairing request ${reqPath}`);
  } else if (table === 'scan_requests') {
    const fileName = `scan-${claimed.id}.md`;
    const respondTo = join(CONFIG.dirs.responses, fileName);

    // Download all images (front, back, etc) to local paths the agent can read.
    // Parallelize: a 2-image scan halves wall-clock latency vs sequential awaits.
    const paths = Array.isArray(claimed.image_paths) ? claimed.image_paths : [];
    const images = await Promise.all(paths.map(async (storagePath, i) => {
      const ext = extname(storagePath) || '.jpg';
      // Convention: paths are uploaded as ".../scan-<uuid>-<label>.jpg".
      // Extract the label from the basename if present, else fall back to index.
      const baseLabel = basename(storagePath, ext).split('-').pop();
      const label = ['front', 'back', 'side', 'top'].includes(baseLabel) ? baseLabel : `image${i + 1}`;
      const localImage = join(CONFIG.dirs.images, `${claimed.id}-${label}${ext}`);
      await downloadImage(storagePath, localImage);
      return { label, path: localImage };
    }));

    // For 'enrich' intent, optionally fetch the bottle row to give the agent context.
    let existingBottle = null;
    if (claimed.intent === 'enrich' && claimed.context?.bottle_id) {
      const { data, error: bErr } = await sb
        .from('bottles')
        .select('id, producer, wine_name, varietal, blend_components, vintage, region, country, style, sweetness, body, drink_window_start, drink_window_end, notes')
        .eq('id', claimed.context.bottle_id)
        .maybeSingle();
      if (bErr) throw bErr;
      existingBottle = data;
    }

    const body = renderScanRequest(claimed, images, respondTo, existingBottle, weather);
    reqPath = join(CONFIG.dirs.requests, fileName);
    await writeFile(reqPath, body, 'utf8');
    log(`wrote scan request ${reqPath} (intent=${claimed.intent}, images=${images.length})`);
  }

  if (reqPath) {
    // Global daily ceiling: refuse to spawn if we're at cap. Atomic upsert
    // in Postgres (cellar27_try_record_spawn) so two watchers / parallel
    // requests can't race past the limit.
    const { data: allowed, error: ceilErr } = await sb.rpc('cellar27_try_record_spawn', {
      p_max: CONFIG.maxClaudeCallsPerDay,
    });
    if (ceilErr) {
      err('try_record_spawn:', ceilErr);
      // Fail closed: if we can't talk to Postgres, don't spawn either.
      await sb.from(table).update({
        status: 'error',
        error_message: `ceiling check failed: ${ceilErr.message}`,
      }).eq('id', claimed.id);
      try { await unlink(reqPath); } catch { /* best-effort */ }
      return;
    }
    if (allowed !== true) {
      log(`DAILY CEILING REACHED (${CONFIG.maxClaudeCallsPerDay}); refusing to spawn for ${table}.${claimed.id}`);
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
      try { await unlink(reqPath); } catch { /* best-effort */ }
      return;
    }
    invokeBridgeAgent(reqPath);
  }
}

async function downloadImage(storagePath, localPath) {
  const { data, error } = await sb.storage.from(CONFIG.storageBucket).download(storagePath);
  if (error) throw new Error(`storage download failed: ${error.message}`);
  const buf = Buffer.from(await data.arrayBuffer());
  await writeFile(localPath, buf);
}

// ───────────────────────── outbound (file → Supabase) ─────────────────────────

function watchResponses() {
  const watcher = chokidar.watch(CONFIG.dirs.responses, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 100 },
  });
  watcher.on('add', async (path) => {
    const name = basename(path);
    try {
      if (name.startsWith('req-') && name.endsWith('.md'))   await ingestPairingResponse(path);
      else if (name.startsWith('scan-') && name.endsWith('.md')) await ingestScanResponse(path);
      else log(`ignoring unrecognized file in responses/: ${name}`);
    } catch (e) {
      err(`ingest ${name}:`, e);
    }
  });
  watcher.on('error', (e) => {
    fatalAndExit('chokidar', e?.stack || e?.message || String(e));
  });
  responsesWatcher = watcher;
}

// The response file is written by the agent, so its frontmatter is agent
// output — not a trusted identifier. The filename, by contrast, is ours: we
// created it as `<prefix>-<claimed.id>.md` and told the agent to write there.
// Requiring them to match means a hallucinated (or injected) request_id can't
// attach a response to somebody else's request, or archive the wrong file.
function requestIdFromFilename(path, prefix) {
  const m = basename(path).match(
    new RegExp(`^${prefix}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\.md$`, 'i'));
  return m ? m[1].toLowerCase() : null;
}

function resolveRequestId(path, prefix, frontmatterId) {
  const fromName = requestIdFromFilename(path, prefix);
  if (!fromName) throw new Error(`unparseable response filename: ${basename(path)}`);
  const claimed = String(frontmatterId || '').trim().toLowerCase();
  if (claimed && claimed !== fromName) {
    throw new Error(
      `request_id mismatch in ${basename(path)}: frontmatter says ${claimed}, filename says ${fromName}`);
  }
  return fromName;
}

async function ingestPairingResponse(path) {
  const text = await readFile(path, 'utf8');
  const parsed = parsePairingResponse(text);
  const requestId = resolveRequestId(path, 'req', parsed.frontmatter.request_id);

  const { error: insErr } = await sb.from('pairing_responses').insert({
    request_id: requestId,
    recommendations: parsed.recommendations,
    narrative: parsed.narrative,
    payload: parsed.payload,
  });
  if (insErr) throw insErr;

  const { error: updErr } = await sb.from('pairing_requests')
    .update({ status: 'completed' })
    .eq('id', requestId);
  if (updErr) throw updErr;

  await archive(`req-${requestId}.md`, path);
  log(`completed pairing ${requestId}`);
}

async function ingestScanResponse(path) {
  const text = await readFile(path, 'utf8');
  const parsed = parseScanResponse(text);
  const requestId = resolveRequestId(path, 'scan', parsed.frontmatter.request_id);

  // scan_responses doesn't have a `details` column yet — pack details into
  // `extracted` for add intents, into `match_candidates` slot? No — cleaner:
  // merge extracted+details into extracted for add (frontend will split them
  // back out), or store details under extracted.details. Use the latter.
  let extracted = parsed.extracted;
  if (parsed.details) {
    extracted = { ...(extracted || {}), details: parsed.details };
  }

  const { error: insErr } = await sb.from('scan_responses').insert({
    request_id: requestId,
    extracted,
    matched_bottle_id: parsed.matched_bottle_id,
    match_candidates: parsed.match_candidates,
    narrative: parsed.narrative,
  });
  if (insErr) throw insErr;

  const { error: updErr } = await sb.from('scan_requests')
    .update({ status: 'completed' })
    .eq('id', requestId);
  if (updErr) throw updErr;

  await archive(`scan-${requestId}.md`, path);

  // Clean up local image (Storage holds the durable copy).
  try {
    const dir = await import('node:fs/promises').then((m) => m.readdir(CONFIG.dirs.images));
    for (const f of dir) {
      if (f.startsWith(requestId)) await unlink(join(CONFIG.dirs.images, f));
    }
  } catch { /* best-effort */ }

  log(`completed scan ${requestId}`);
}

async function archive(reqFileName, responsePath) {
  const reqPath = join(CONFIG.dirs.requests, reqFileName);
  try { await rename(reqPath, join(CONFIG.dirs.processed, reqFileName)); } catch { /* request file may already be moved */ }
  try { await rename(responsePath, join(CONFIG.dirs.processed, basename(responsePath))); } catch { /* same */ }
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
    catch (e) { err(`retry pickUp ${row.request_id}:`, e); }
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
  if (responsesWatcher) {
    try { await responsesWatcher.close(); } catch (e) { err('chokidar close:', e?.message || e); }
  }
  log('shutdown complete');
  process.exit(0);
}
process.on('SIGINT',  () => { shutdown('SIGINT').catch(()  => process.exit(1)); });
process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });

// Fail-fast on unhandled rejections / uncaught exceptions / fatal chokidar
// errors. These reflect bugs (or filesystem disappearance), not transient
// network drops — continuing in a corrupted state is worse than dying.
//
// BUT: the watcher runs as a detached node.exe with no supervisor, so a
// silent exit would leave it dead until the owner notices (which happened
// on 2026-05-01 — a real morning request stuck in pending). Email via the
// existing notify() SMTP path before exiting so the owner finds out at the
// moment of death rather than when they next try to use the app.
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

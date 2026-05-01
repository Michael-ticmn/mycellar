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

const sb = createClient(CONFIG.supabaseUrl, CONFIG.supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Track resources for graceful shutdown + per-channel reconnect state.
// channels: name → most recent channel handle (replaced on reconnect).
// reconnect: name → { attempts, timer } so we can back off and cancel cleanly.
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
  if (error) { err(`sweep ${table}:`, error); return; }
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
  // Drop any previous channel with the same name before replacing the ref —
  // realtime tracks subs by name; leaving the old one connected wastes a slot
  // and produces duplicate INSERT events during the brief overlap.
  const prior = channels.get(name);
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
      })
    .subscribe((status) => onChannelStatus(name, status));
  channels.set(name, ch);
}

function subscribePairingRequests() { subscribeChannel('pairing-requests'); }
function subscribeScanRequests()    { subscribeChannel('scan-requests'); }

// Realtime status handler. On terminal errors we don't kill the process —
// the watcher runs as a detached node.exe with no supervisor, so exit
// would mean silent death until the next manual restart. Reconnect in
// place with exponential backoff instead, and on successful re-subscribe
// run a stale-pending sweep so we catch any INSERTs that fired during
// the dead window (realtime doesn't replay missed events).
function onChannelStatus(name, status) {
  log(`${name} channel:`, status);
  if (status === 'SUBSCRIBED') {
    const state = reconnect.get(name);
    if (state) {
      log(`${name} reconnected after ${state.attempts} attempt(s); sweeping stale pending`);
      reconnect.delete(name);
      // Catch up on anything inserted while the channel was down. We sweep
      // only this channel's table, not all of them, so a flapping channel
      // doesn't cause O(N) sweeps elsewhere.
      sweepTable(CHANNEL_DEFS[name]).catch((e) => err(`reconnect sweep ${name}:`, e));
    }
    return;
  }
  if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
    scheduleReconnect(name);
  }
}

function scheduleReconnect(name) {
  const state = reconnect.get(name) || { attempts: 0, timer: null };
  if (state.timer) return; // already scheduled — debounce repeated status callbacks
  state.attempts += 1;
  // 2, 4, 8, 16, 32, 60, 60, … (capped at 60s)
  const delay = Math.min(2_000 * 2 ** (state.attempts - 1), 60_000);
  err(`${name} dropped; reconnect attempt ${state.attempts} in ${delay / 1000}s`);
  state.timer = setTimeout(() => {
    state.timer = null;
    reconnect.set(name, state);
    try { subscribeChannel(name); }
    catch (e) {
      err(`${name} resubscribe threw:`, e);
      scheduleReconnect(name);
    }
  }, delay);
  reconnect.set(name, state);
}

async function pickUp(table, row) {
  // Policy gate: allowlist + per-user rate limit. Reject pre-claim so
  // the request shows status=error to the client immediately, without
  // spawning claude.
  const denied = denyReason(row.user_id);
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
    const body = renderPairingRequest(claimed, respondTo, weather);
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

async function ingestPairingResponse(path) {
  const text = await readFile(path, 'utf8');
  const parsed = parsePairingResponse(text);
  const requestId = parsed.frontmatter.request_id;
  if (!requestId) throw new Error(`no request_id in ${path}`);

  const { error: insErr } = await sb.from('pairing_responses').insert({
    request_id: requestId,
    recommendations: parsed.recommendations,
    narrative: parsed.narrative,
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
  const requestId = parsed.frontmatter.request_id;
  if (!requestId) throw new Error(`no request_id in ${path}`);

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
  if (error) { err('sweep_stale_claims:', error); return; }
  for (const row of data || []) {
    log(`sweep ${row.action}: ${row.table_name}.${row.request_id}`);
    if (row.action !== 'retry') continue;
    const { data: full, error: fetchErr } = await sb
      .from(row.table_name).select('*').eq('id', row.request_id).single();
    if (fetchErr || !full) { err(`refetch retry row:`, fetchErr); continue; }
    try { await pickUp(row.table_name, full); }
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

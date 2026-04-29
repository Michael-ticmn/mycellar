import { mkdir, writeFile, readFile, rename, unlink } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import chokidar from 'chokidar';
import { CONFIG } from './config.js';
import { renderPairingRequest, renderScanRequest } from './render.js';
import { parsePairingResponse, parseScanResponse } from './parse.js';
import { invokeBridgeAgent } from './agent.js';
import { denyReason } from './policy.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);
const err = (...args) => console.error(new Date().toISOString(), ...args);

const sb = createClient(CONFIG.supabaseUrl, CONFIG.supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

await ensureDirs();
await sweepStaleRequests(); // catch up on anything queued while we were down
subscribePairingRequests();
subscribeScanRequests();
watchResponses();
setInterval(timeoutStaleRequests, 60_000);

log('cellar27-watcher running. Bridge dir:', CONFIG.bridgeDir);

// ───────────────────────── setup ─────────────────────────

async function ensureDirs() {
  for (const dir of Object.values(CONFIG.dirs)) {
    await mkdir(dir, { recursive: true });
  }
}

// On startup, pull anything stuck in 'pending' that we missed.
async function sweepStaleRequests() {
  for (const table of ['pairing_requests', 'scan_requests']) {
    const { data, error } = await sb.from(table).select('*').eq('status', 'pending');
    if (error) { err(`sweep ${table}:`, error); continue; }
    for (const row of data || []) {
      log(`sweep: picking up stale ${table}.${row.id}`);
      try { await pickUp(table, row); }
      catch (e) { err(`sweep pickUp ${row.id}:`, e); }
    }
  }
}

// ───────────────────────── inbound (Supabase → file) ─────────────────────────

function subscribePairingRequests() {
  sb.channel('pairing-requests')
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'pairing_requests' },
      async ({ new: row }) => {
        if (row.status !== 'pending') return;
        try { await pickUp('pairing_requests', row); }
        catch (e) { err('pairing pickUp:', e); await markError('pairing_requests', row.id, String(e?.message || e)); }
      })
    .subscribe((status) => log('pairing-requests channel:', status));
}

function subscribeScanRequests() {
  sb.channel('scan-requests')
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'scan_requests' },
      async ({ new: row }) => {
        if (row.status !== 'pending') return;
        try { await pickUp('scan_requests', row); }
        catch (e) { err('scan pickUp:', e); await markError('scan_requests', row.id, String(e?.message || e)); }
      })
    .subscribe((status) => log('scan-requests channel:', status));
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
    return;
  }

  // Re-check + atomically claim with status='picked_up' to avoid double-processing.
  const { data: claimed, error: claimErr } = await sb.from(table)
    .update({ status: 'picked_up', picked_up_at: new Date().toISOString() })
    .eq('id', row.id).eq('status', 'pending')
    .select().single();
  if (claimErr || !claimed) { log(`already claimed: ${table}.${row.id}`); return; }

  let reqPath;
  if (table === 'pairing_requests') {
    const fileName = `req-${claimed.id}.md`;
    const respondTo = join(CONFIG.dirs.responses, fileName);
    const body = renderPairingRequest(claimed, respondTo);
    reqPath = join(CONFIG.dirs.requests, fileName);
    await writeFile(reqPath, body, 'utf8');
    log(`wrote pairing request ${reqPath}`);
  } else if (table === 'scan_requests') {
    const fileName = `scan-${claimed.id}.md`;
    const respondTo = join(CONFIG.dirs.responses, fileName);

    // Download all images (front, back, etc) to local paths the agent can read.
    const paths = Array.isArray(claimed.image_paths) ? claimed.image_paths : [];
    const images = [];
    for (let i = 0; i < paths.length; i++) {
      const storagePath = paths[i];
      const ext = extname(storagePath) || '.jpg';
      // Convention: paths are uploaded as ".../scan-<uuid>-<label>.jpg".
      // Extract the label from the basename if present, else fall back to index.
      const baseLabel = basename(storagePath, ext).split('-').pop();
      const label = ['front', 'back', 'side', 'top'].includes(baseLabel) ? baseLabel : `image${i + 1}`;
      const localImage = join(CONFIG.dirs.images, `${claimed.id}-${label}${ext}`);
      await downloadImage(storagePath, localImage);
      images.push({ label, path: localImage });
    }

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

    const body = renderScanRequest(claimed, images, respondTo, existingBottle);
    reqPath = join(CONFIG.dirs.requests, fileName);
    await writeFile(reqPath, body, 'utf8');
    log(`wrote scan request ${reqPath} (intent=${claimed.intent}, images=${images.length})`);
  }

  if (reqPath) invokeBridgeAgent(reqPath);
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

// ───────────────────────── timeouts ─────────────────────────

async function timeoutStaleRequests() {
  const cutoff = new Date(Date.now() - CONFIG.timeoutMinutes * 60_000).toISOString();
  for (const table of ['pairing_requests', 'scan_requests']) {
    const { data, error } = await sb.from(table)
      .update({ status: 'error', error_message: `timeout after ${CONFIG.timeoutMinutes} min in picked_up` })
      .eq('status', 'picked_up').lt('picked_up_at', cutoff)
      .select('id');
    if (error) { err(`timeout sweep ${table}:`, error); continue; }
    for (const row of data || []) log(`timed out ${table}.${row.id}`);
  }
}

async function markError(table, id, message) {
  await sb.from(table).update({ status: 'error', error_message: message }).eq('id', id);
}

// ───────────────────────── lifecycle ─────────────────────────

process.on('SIGINT',  () => { log('SIGINT, exiting'); process.exit(0); });
process.on('SIGTERM', () => { log('SIGTERM, exiting'); process.exit(0); });
process.on('unhandledRejection', (reason) => err('unhandledRejection:', reason));

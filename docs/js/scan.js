// Scan primitives: camera capture, image resize, Storage upload, request
// insert, response wait. UI orchestration lives in app.js.

import { sb } from './supabase-client.js';

const STORAGE_BUCKET = 'bottle-labels';
const MAX_EDGE_PX = 1600;
const JPEG_QUALITY = 0.85;

// Open the rear camera and attach to a <video> element. Returns the stream.
export async function startCamera(videoEl) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera API not available. On iOS this only works in Safari (or a PWA), and only over HTTPS.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  });
  videoEl.srcObject = stream;
  await videoEl.play().catch(() => {}); // some browsers need an explicit play()
  return stream;
}

export function stopCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

// Grab a still from the live <video>, resize so longest edge ≤ MAX_EDGE_PX,
// return a JPEG blob.
export async function captureFrame(videoEl) {
  const sw = videoEl.videoWidth, sh = videoEl.videoHeight;
  if (!sw || !sh) throw new Error('Video frame not ready yet.');
  const scale = Math.min(1, MAX_EDGE_PX / Math.max(sw, sh));
  const dw = Math.round(sw * scale), dh = Math.round(sh * scale);
  const canvas = document.createElement('canvas');
  canvas.width = dw; canvas.height = dh;
  canvas.getContext('2d').drawImage(videoEl, 0, 0, dw, dh);
  return await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/jpeg', JPEG_QUALITY);
  });
}

// Upload a captured blob to Storage under the user's prefix.
// label is "front" / "back" / etc.
// scanId is a client-generated uuid used to group images of the same scan.
export async function uploadCapture(blob, { scanId, label }) {
  const { data: userData } = await sb.auth.getUser();
  if (!userData?.user) throw new Error('Not signed in');
  const path = `${userData.user.id}/scan-${scanId}-${label}.jpg`;
  const { error } = await sb.storage.from(STORAGE_BUCKET).upload(path, blob, {
    contentType: 'image/jpeg',
    upsert: false,
  });
  if (error) throw error;
  return path;
}

// Insert a scan_request row. Returns the inserted row.
export async function submitScanRequest({ intent, imagePaths, context = null, cellarSnapshot = null }) {
  const { data: userData } = await sb.auth.getUser();
  if (!userData?.user) throw new Error('Not signed in');
  const row = {
    user_id: userData.user.id,
    intent,
    image_paths: imagePaths,
    context,
    cellar_snapshot: cellarSnapshot,
  };
  const { data, error } = await sb.from('scan_requests').insert(row).select().single();
  if (error) throw error;
  return data;
}

// Subscribe to a single scan_request's outcome. Calls onResponse(row) when
// the scan_responses row arrives, or onError(err) if the request transitions
// to status='error' or the timeout expires. Returns an unsubscribe function.
// Each handler fires at most once. Used by both waitForScanResponse (one-shot
// await) and the background scan queue in app.js.
//
// Realtime is treated as a latency optimization, not the source of truth. The
// channel has no reconnect logic, so a dropped connection used to strand the
// caller forever — the background queue in particular had no timeout at all and
// would spin indefinitely with no recovery but a page reload. Three guards now:
// a hard timeout, a DB re-check before ever reporting a timeout, and a polling
// fallback while the channel is down.
const SCAN_POLL_MS = 5_000;

export function subscribeForResponse(requestId, { onResponse, onError, timeoutMs = 5 * 60_000 } = {}) {
  let done = false;
  let timer = null;
  let poll = null;

  const finish = (fn, val) => {
    if (done) return; done = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (poll)  { clearInterval(poll); poll = null; }
    try { channel.unsubscribe(); } catch { /* idempotent */ }
    fn?.(val);
  };

  // Authoritative check against the row. Used for the subscribe-race, as the
  // polling fallback, and before declaring a timeout — so a realtime outage
  // can never turn a scan that actually succeeded into a user-facing failure.
  const settleFromDb = async () => {
    if (done) return true;
    const { data: resp } = await sb.from('scan_responses')
      .select('*').eq('request_id', requestId).maybeSingle();
    if (resp) { finish(onResponse, resp); return true; }
    const { data: req } = await sb.from('scan_requests')
      .select('status, error_message').eq('id', requestId).maybeSingle();
    if (req?.status === 'error') {
      finish(onError, new Error(req.error_message || 'Scan failed.'));
      return true;
    }
    return false;
  };

  const channel = sb.channel(`scan-resp-${requestId}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'scan_responses', filter: `request_id=eq.${requestId}` },
      ({ new: row }) => finish(onResponse, row))
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'scan_requests', filter: `id=eq.${requestId}` },
      ({ new: row }) => { if (row.status === 'error') finish(onError, new Error(row.error_message || 'Scan failed.')); })
    .subscribe(async (status) => {
      // finish() unsubscribes, which itself emits CLOSED — without this guard
      // that would start a polling interval after we're already done.
      if (done) return;
      if (status === 'SUBSCRIBED') {
        if (poll) { clearInterval(poll); poll = null; }
        await settleFromDb();
        return;
      }
      // Channel is down and nothing here reconnects it, so poll the row until
      // it comes back or the timeout fires. Without this the caller waits the
      // full timeoutMs even though the answer may already be in the database.
      if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') && !poll) {
        poll = setInterval(() => { settleFromDb().catch(() => { /* retry next tick */ }); }, SCAN_POLL_MS);
      }
    });

  timer = setTimeout(async () => {
    if (await settleFromDb()) return;
    const span = timeoutMs >= 60_000
      ? `${Math.round(timeoutMs / 60_000)} min`
      : `${Math.round(timeoutMs / 1_000)}s`;
    finish(onError, new Error(`Timed out after ${span} — dismiss and rescan.`));
  }, timeoutMs);

  return () => finish(null, null);
}

// One-shot Promise wrapper: resolve with response row, reject on error/timeout.
// Used by the pour flow which still blocks the user on a single scan. The
// timeout lives in subscribeForResponse now, so this no longer runs its own.
export function waitForScanResponse(requestId, { timeoutMs = 5 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    subscribeForResponse(requestId, { onResponse: resolve, onError: reject, timeoutMs });
  });
}

// Get a short-lived signed URL for a private Storage object. Used by the
// bottle detail view to display label photos.
export async function signedUrlForImage(path, ttlSeconds = 3600) {
  if (!path) return null;
  const { data, error } = await sb.storage.from(STORAGE_BUCKET).createSignedUrl(path, ttlSeconds);
  if (error) throw error;
  return data.signedUrl;
}

// Convenience for the manual-entry "Get details" button: fire an enrichment
// request for an existing bottle (no images, just bottle_id in context).
export async function requestEnrichment(bottleId) {
  const req = await submitScanRequest({
    intent: 'enrich',
    imagePaths: [],
    context: { bottle_id: bottleId },
  });
  return await waitForScanResponse(req.id);
}

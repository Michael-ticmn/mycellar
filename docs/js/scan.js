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

// Subscribe to scan_responses for this request_id; resolve with the response row,
// reject on error or timeout.
export function waitForScanResponse(requestId, { timeoutMs = 5 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, val) => {
      if (done) return; done = true;
      clearTimeout(timer); channel.unsubscribe(); fn(val);
    };
    const timer = setTimeout(() => finish(reject, new Error('Scan timed out (5 min).')), timeoutMs);
    const channel = sb.channel(`scan-resp-${requestId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'scan_responses', filter: `request_id=eq.${requestId}` },
        ({ new: row }) => finish(resolve, row))
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'scan_requests', filter: `id=eq.${requestId}` },
        ({ new: row }) => { if (row.status === 'error') finish(reject, new Error(row.error_message || 'Scan failed.')); })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          const { data: existing } = await sb.from('scan_responses').select('*').eq('request_id', requestId).maybeSingle();
          if (existing) finish(resolve, existing);
        }
      });
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

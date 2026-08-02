// Allowlist + per-user rate limit. Both gate the cost-bearing step
// (spawning `claude --print`). Defense-in-depth: the DB-layer trigger
// already caps pending requests at 5; this is the extra barrier in
// case sign-ups accidentally get re-enabled or an account is compromised.

import { CONFIG, intEnv } from './config.js';

// Sliding-window in-memory rate limit: max N requests per user per WINDOW_MS.
// Tunable via WATCHER_RATE_LIMIT_PER_HOUR env var. The DB also enforces
// its own check; this is the redundant backstop.
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_WINDOW = intEnv('WATCHER_RATE_LIMIT_PER_HOUR', 100, { min: 1, max: 100_000 });
const MAX_TRACKED_USERS = 10_000; // hard cap to bound memory
const hits = new Map(); // user_id → number[] of timestamps (insertion-ordered)

export function isAllowed(userId) {
  if (!CONFIG.allowedUserIds.size) return true; // empty allowlist = open mode
  return CONFIG.allowedUserIds.has(userId);
}

// `record: false` checks the window without consuming a slot. Used by the
// stale-claim retry path: a retry is the same user request being processed a
// second time, so charging it again would let two timeouts eat three slots.
export function checkRateLimit(userId, { record = true } = {}) {
  const now = Date.now();
  const arr = (hits.get(userId) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) {
    return { ok: false, reason: `rate limit: ${arr.length}/${MAX_PER_WINDOW} requests in last hour` };
  }
  if (!record) return { ok: true };
  arr.push(now);
  // Re-insert to refresh insertion order so LRU eviction sees this as recent.
  hits.delete(userId);
  hits.set(userId, arr);
  // Bound the map: drop oldest insertion-ordered entries if past the cap.
  if (hits.size > MAX_TRACKED_USERS) {
    const toEvict = hits.size - MAX_TRACKED_USERS;
    let evicted = 0;
    for (const k of hits.keys()) {
      hits.delete(k);
      if (++evicted >= toEvict) break;
    }
  }
  return { ok: true };
}

// Test hook: exposes the current map size without leaking the map itself.
export function _trackedUserCount() { return hits.size; }

// Evaluates both gates; returns null if request can proceed, or an error
// message if it should be rejected.
//
// `subject` is who the rate limit is charged to, which is not always the row's
// user_id. A guest request created through a share link is inserted with
// user_id = the owner, so charging it to the owner let a guest spend half the
// host's hourly budget — the opposite of the "guests are on a separate budget"
// intent in migration 0009. Callers pass the share link as the subject for
// those, which keeps the backstop per-link. The allowlist check stays on the
// real user_id: the owner is the one who has to be authorized.
// Storage objects live under "<user_id>/<filename>" (see uploadCapture in
// docs/js/scan.js). scan_requests.image_paths is client-written and the watcher
// fetches it with the service-role key, which is not subject to the bucket's
// per-user folder policies — so this predicate is the only thing between a
// client-chosen string and a cross-tenant read of someone's label photo.
//
// Deliberately strict: exactly one leading segment equal to the requester's
// uuid, at least one segment after it, no traversal, no backslashes (Supabase
// keys use forward slashes; a backslash is a Windows-path smell, not a real
// object name), and no empty or "." segments.
export function isOwnedStoragePath(storagePath, userId) {
  if (typeof storagePath !== 'string' || !userId) return false;
  if (storagePath.includes('\\') || storagePath.includes('..')) return false;
  const segments = storagePath.split('/');
  if (segments.length < 2) return false;
  if (segments.some((s) => s === '' || s === '.')) return false;
  return segments[0].toLowerCase() === String(userId).toLowerCase();
}

export function denyReason(userId, { subject = userId, record = true } = {}) {
  if (!isAllowed(userId)) return `user ${userId} not on allowlist`;
  const rl = checkRateLimit(subject, { record });
  if (!rl.ok) return rl.reason;
  return null;
}

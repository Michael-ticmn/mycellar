// Allowlist + per-user rate limit. Both gate the cost-bearing step
// (spawning `claude --print`). Defense-in-depth: the DB-layer trigger
// already caps pending requests at 5; this is the extra barrier in
// case sign-ups accidentally get re-enabled or an account is compromised.

import { CONFIG } from './config.js';

// Sliding-window in-memory rate limit: max N requests per user per WINDOW_MS.
// Tunable via WATCHER_RATE_LIMIT_PER_HOUR env var. The DB also enforces
// its own check; this is the redundant backstop.
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_WINDOW = parseInt(process.env.WATCHER_RATE_LIMIT_PER_HOUR || '100', 10);
const hits = new Map(); // user_id → number[] of timestamps

export function isAllowed(userId) {
  if (!CONFIG.allowedUserIds.size) return true; // empty allowlist = open mode
  return CONFIG.allowedUserIds.has(userId);
}

export function checkRateLimit(userId) {
  const now = Date.now();
  const arr = (hits.get(userId) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) {
    return { ok: false, reason: `rate limit: ${arr.length}/${MAX_PER_WINDOW} requests in last hour` };
  }
  arr.push(now);
  hits.set(userId, arr);
  return { ok: true };
}

// Evaluates both gates; returns null if request can proceed,
// or an error message if it should be rejected.
export function denyReason(userId) {
  if (!isAllowed(userId)) return `user ${userId} not on allowlist`;
  const rl = checkRateLimit(userId);
  if (!rl.ok) return rl.reason;
  return null;
}

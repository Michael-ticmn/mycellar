#!/usr/bin/env node
// cellar27 — post-migration verification
//
// Run after applying 0016-0019 to confirm they took, and that no data went
// missing. Read-only: it calls each new/changed function with deliberately
// invalid arguments and checks how it fails, so it never writes a row.
//
// Usage:
//   node scripts/verify-migrations.mjs
//
// Env (read from watcher/.env, override with shell env):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const envPath = join(repoRoot, 'watcher', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('\n  Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.\n');
  process.exit(1);
}

const require = createRequire(pathToFileURL(join(repoRoot, 'watcher', 'package.json')));
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

const ZERO = '00000000-0000-0000-0000-000000000000';
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const missing = (e) => e?.code === 'PGRST202' || /Could not find the function/i.test(e?.message || '');

console.log('\ncellar27 — verifying migrations 0016-0019\n');

// 0018: the pour RPCs exist. Calling with a uuid that matches nothing returns
// zero rows rather than erroring, so "no error" means the function is there.
for (const fn of ['cellar27_pour_bottle', 'cellar27_unpour_bottle']) {
  const { error } = await sb.rpc(fn, { p_bottle_id: ZERO });
  check(`0018  ${fn}`, !error,
    missing(error) ? 'NOT APPLIED — client is using the read-then-write fallback'
                   : error?.message?.slice(0, 60) || '');
}

// 0019: the guest-label rate limiter. Absent means the endpoint fails open and
// has no limit at all — see SECURITY.md Layer 8 for why it can't live in the
// Edge Function's memory.
{
  const { error } = await sb.rpc('cellar27_guest_label_allow', { p_token: 'verify-probe', p_max: 60 });
  check('0019  cellar27_guest_label_allow', !error,
    missing(error) ? 'NOT APPLIED — guest-label has no rate limit' : (error?.message?.slice(0, 50) || ''));
}

// 0016 / 0017: each function still runs and rejects an invalid token cleanly
// (P0001 is the app's own raise; anything else means a broken definition).
const rpcs = [
  ['0016  cellar27_share_get_response',       'cellar27_share_get_response',       { p_token: 'nope', p_request_id: ZERO }, true],
  ['0016  cellar27_share_create_message',     'cellar27_share_create_message',     { p_token: 'nope', p_guest_name: null, p_kind: 'pour_note', p_payload: { note: 'verify' } }, false],
  ['0017  cellar27_share_get_planned_flight', 'cellar27_share_get_planned_flight', { p_token: 'nope' }, false],
];
for (const [label, fn, args, allowEmpty] of rpcs) {
  const { error } = await sb.rpc(fn, args);
  const ok = allowEmpty ? !error : (error?.code === 'P0001' || !error);
  check(label, ok, missing(error) ? 'NOT APPLIED' : (error?.message?.slice(0, 50) || ''));
}

// Data sanity. Counts are a floor, not an equality: the app is live and rows
// legitimately arrive while this runs. Set BASELINE_* to your latest snapshot's
// manifest.json numbers to make this meaningful.
const baseline = {
  bottles:          Number(process.env.BASELINE_BOTTLES          ?? 34),
  pairing_requests: Number(process.env.BASELINE_PAIRING_REQUESTS ?? 111),
  planned_flights:  Number(process.env.BASELINE_PLANNED_FLIGHTS  ?? 2),
  share_links:      Number(process.env.BASELINE_SHARE_LINKS      ?? 18),
};
console.log('');
for (const [table, floor] of Object.entries(baseline)) {
  const { count, error } = await sb.from(table).select('id', { count: 'exact', head: true });
  check(`data  ${table} >= ${floor}`, !error && count >= floor,
    error ? error.message : `${count} rows`);
}

console.log(`\n${fail ? `${fail} check(s) FAILED` : 'All checks passed'} (${pass} passed)\n`);
process.exit(fail ? 1 : 0);

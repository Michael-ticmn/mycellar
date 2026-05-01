#!/usr/bin/env node
// cellar27 — security smoke test
//
// Exercises the four gates that keep `claude --print` spawns bounded,
// without actually spawning Claude. See docs/SECURITY.md for the full
// description of what each gate enforces.
//
//   1. Allowlist       — predicate on cellar27_allowed_users
//   2. DB rate limit   — cellar27_check_rate_limit RPC
//   3. In-flight cap   — enforce_pending_scan_cap trigger
//   4. Daily ceiling   — cellar27_try_record_spawn RPC
//
// Run with the watcher STOPPED. The in-flight test seeds rows with
// status='picked_up' (which the watcher's realtime + startup pull both
// skip), but stopping the watcher removes any race risk entirely.
//
// Usage:
//   node scripts/security-smoke-test.mjs
//
// Env (read from watcher/.env, override with shell env if you want):
//   SUPABASE_URL                — required
//   SUPABASE_SERVICE_ROLE_KEY   — required
//   SMOKE_TEST_USER_ID          — required, a real auth.users uuid
//                                 (need not be on the allowlist; we use
//                                 service_role so RLS is bypassed for
//                                 setup, and the cap trigger fires for
//                                 any user_id with a valid FK)

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const watcherPkg = join(repoRoot, 'watcher', 'package.json');

if (!existsSync(watcherPkg)) {
  fail('watcher/package.json not found — run from the repo root with watcher deps installed (cd watcher && npm install).');
}

// Load watcher/.env into process.env without overwriting shell vars.
const envPath = join(repoRoot, 'watcher', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_USER    = process.env.SMOKE_TEST_USER_ID;

if (!SUPABASE_URL || !SERVICE_KEY) {
  fail('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (in shell or watcher/.env).');
}
if (!TEST_USER || !/^[0-9a-f-]{36}$/i.test(TEST_USER)) {
  fail('SMOKE_TEST_USER_ID must be set to a real auth.users uuid (find one with: select id, email from auth.users;).');
}

// Resolve @supabase/supabase-js from watcher/node_modules so this script
// has no install of its own.
const req = createRequire(watcherPkg);
let createClient;
try {
  ({ createClient } = await import(pathToFileURL(req.resolve('@supabase/supabase-js')).href));
} catch (e) {
  fail(`could not load @supabase/supabase-js from watcher/node_modules: ${e.message}\nRun: cd watcher && npm install`);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const FAKE_UUID = '00000000-0000-0000-0000-0000deadbeef';
const SMOKE_TAG = 'cellar27-smoke-test';

let pass = 0, total = 0;
const seededIds = []; // { table, id }

try {
  await testAllowlist();
  await testDbRateLimit();
  await testInFlightCap();
  await testDailyCeiling();
} finally {
  await cleanup();
}

console.log(`\n${pass}/${total} passed.`);
process.exit(pass === total ? 0 : 1);

// ─────────────────────────── tests ───────────────────────────

async function testAllowlist() {
  await check('allowlist rejects fake user', async () => {
    const { data, error } = await sb
      .from('cellar27_allowed_users')
      .select('user_id')
      .eq('user_id', FAKE_UUID);
    if (error) throw error;
    expect(data.length === 0, `expected fake uuid ${FAKE_UUID} not in allowlist, got ${data.length} rows`);
  });

  await check('test user can be checked against allowlist', async () => {
    const { data, error } = await sb
      .from('cellar27_allowed_users')
      .select('user_id')
      .eq('user_id', TEST_USER);
    if (error) throw error;
    // Either result is fine — we're verifying the predicate runs.
    console.log(`     test user is${data.length ? '' : ' NOT'} on allowlist (informational)`);
  });
}

async function testDbRateLimit() {
  // Seed one completed row (counts toward the rate-limit window but
  // watcher ignores status='completed', so no spawn risk) and ask the
  // function with p_max=1 — expect false.
  await check('db rate limit refuses past N', async () => {
    const { data: ins, error: insErr } = await sb
      .from('scan_requests')
      .insert({
        user_id: TEST_USER,
        intent: 'enrich',
        status: 'completed',
        context: { smoke: SMOKE_TAG },
        image_paths: [],
      })
      .select('id')
      .single();
    if (insErr) throw new Error(`seed insert failed: ${insErr.message}`);
    seededIds.push({ table: 'scan_requests', id: ins.id });

    const { data: ok, error: rpcErr } = await sb.rpc('cellar27_check_rate_limit', {
      p_user_id: TEST_USER,
      p_max: 1,
      p_window_minutes: 60,
    });
    if (rpcErr) throw rpcErr;
    expect(ok === false, `expected rate limit to refuse (false) with p_max=1, got ${ok}`);
  });
}

async function testInFlightCap() {
  // Seed 5 rows in status='picked_up' (watcher startup pull and
  // realtime both filter on status='pending', so these are inert)
  // and attempt a 6th in status='pending' — trigger should reject.
  await check('in-flight cap rejects 6th pending', async () => {
    for (let i = 0; i < 5; i++) {
      const { data, error } = await sb
        .from('scan_requests')
        .insert({
          user_id: TEST_USER,
          intent: 'enrich',
          status: 'picked_up',
          picked_up_at: new Date().toISOString(),
          claimed_by: SMOKE_TAG,
          context: { smoke: SMOKE_TAG },
          image_paths: [],
        })
        .select('id')
        .single();
      if (error) throw new Error(`seed row ${i + 1}/5 failed: ${error.message}`);
      seededIds.push({ table: 'scan_requests', id: data.id });
    }

    const { error: capErr } = await sb
      .from('scan_requests')
      .insert({
        user_id: TEST_USER,
        intent: 'enrich',
        status: 'pending',
        context: { smoke: SMOKE_TAG },
        image_paths: [],
      });
    expect(
      capErr && /too many pending/i.test(capErr.message),
      `expected "Too many pending" error from trigger, got: ${capErr ? capErr.message : 'no error (insert succeeded!)'}`,
    );
  });
}

async function testDailyCeiling() {
  // Read today's spawn_count, then ask try_record_spawn to allow only
  // up to that count — should refuse without incrementing. This is
  // non-destructive: no new spawn is recorded.
  await check('daily ceiling refuses past max (non-destructive)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { data: row, error: selErr } = await sb
      .from('cellar27_watcher_metrics')
      .select('spawn_count')
      .eq('metric_date', today)
      .maybeSingle();
    if (selErr) throw selErr;
    const current = row?.spawn_count ?? 0;

    const { data: granted, error: rpcErr } = await sb.rpc('cellar27_try_record_spawn', {
      p_max: current,
    });
    if (rpcErr) throw rpcErr;
    expect(granted === false, `expected refusal with p_max=${current} (current count), got granted=${granted}`);

    // Verify no increment happened.
    const { data: after, error: selErr2 } = await sb
      .from('cellar27_watcher_metrics')
      .select('spawn_count')
      .eq('metric_date', today)
      .maybeSingle();
    if (selErr2) throw selErr2;
    const post = after?.spawn_count ?? 0;
    expect(post === current, `spawn_count changed from ${current} to ${post} — test should be non-destructive`);
  });
}

// ─────────────────────────── helpers ───────────────────────────

async function check(name, fn) {
  total++;
  process.stdout.write(`  • ${name} … `);
  try {
    await fn();
    pass++;
    console.log('PASS');
  } catch (e) {
    console.log(`FAIL\n     ${e.message}`);
  }
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function cleanup() {
  if (!seededIds.length) return;
  const byTable = {};
  for (const { table, id } of seededIds) (byTable[table] ||= []).push(id);
  for (const [table, ids] of Object.entries(byTable)) {
    const { error } = await sb.from(table).delete().in('id', ids);
    if (error) console.error(`  cleanup of ${table} failed: ${error.message} (ids: ${ids.join(', ')})`);
  }
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

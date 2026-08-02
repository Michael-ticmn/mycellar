#!/usr/bin/env node
// cellar27 — data snapshot
//
// Dumps every application table to JSON, plus the label photos from Storage,
// into a timestamped folder OUTSIDE the repo. Point-in-time safety net for
// schema or app changes: if something goes wrong you still have the rows.
//
// This is a logical export, not a Postgres backup. It captures your data, not
// the schema, policies, functions, or auth.users. It is the thing you want when
// a change ate some rows; it is not a substitute for Supabase's own backups if
// the whole project is lost. Restoring means inserting the JSON back with the
// service key — there's no restore script here, deliberately: a blind restore
// over live rows is more dangerous than a careful hand-crafted one.
//
// Uses the service key, so it bypasses RLS and sees everything.
//
// Usage:
//   node scripts/backup-data.mjs                  # default output dir
//   node scripts/backup-data.mjs --out D:\somewhere
//   node scripts/backup-data.mjs --no-photos      # skip Storage (much faster)
//
// Env (read from watcher/.env, override with shell env):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const fail = (msg) => { console.error(`\n  ${msg}\n`); process.exit(1); };

// Same env-loading convention as scripts/security-smoke-test.mjs: read
// watcher/.env but let real shell vars win.
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
if (!SUPABASE_URL || !SERVICE_KEY) {
  fail('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (looked in watcher/.env and the shell).');
}

// Re-use the watcher's supabase-js rather than having deps of our own.
const require = createRequire(pathToFileURL(join(repoRoot, 'watcher', 'package.json')));
let createClient;
try {
  ({ createClient } = require('@supabase/supabase-js'));
} catch {
  fail('@supabase/supabase-js not found — run `npm install` inside watcher/ first.');
}

const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const withPhotos = !args.includes('--no-photos');

// Timestamp is local, filename-safe, and sorts correctly.
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
// Default lives outside the repo on purpose — this file contains personal data
// (prices, notes, guest names) and mycellar is a public repository.
const outDir = outFlag >= 0 && args[outFlag + 1]
  ? resolve(args[outFlag + 1], stamp)
  : join(homedir(), 'cellar27-backups', stamp);

// Ordered parents-first, which is the order you'd re-insert them in.
const TABLES = [
  'cellar27_allowed_users',
  'bottles',
  'share_links',
  'planned_flights',
  'pairing_requests',
  'pairing_responses',
  'scan_requests',
  'scan_responses',
  'guest_messages',
  'cellar27_watcher_metrics',
];

const PAGE = 1000;

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function dumpTable(table) {
  const rows = [];
  // Page explicitly: PostgREST caps a plain select at 1000 rows, so a bigger
  // table would silently truncate — the exact failure a backup must not have.
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select('*').range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  writeFileSync(join(outDir, `${table}.json`), JSON.stringify(rows, null, 2), 'utf8');
  return rows.length;
}

async function dumpPhotos() {
  const bucket = 'bottle-labels';
  const photoDir = join(outDir, 'storage', bucket);
  mkdirSync(photoDir, { recursive: true });

  // Objects live under {user_id}/, so enumerate folders then their contents.
  const { data: top, error: topErr } = await sb.storage.from(bucket).list('', { limit: 1000 });
  if (topErr) throw new Error(`storage list: ${topErr.message}`);

  let count = 0, bytes = 0;
  for (const entry of top || []) {
    if (entry.id) continue;  // a file at the root; the layout puts none here
    const prefix = entry.name;
    for (let offset = 0; ; offset += 100) {
      const { data: files, error } = await sb.storage
        .from(bucket).list(prefix, { limit: 100, offset });
      if (error) throw new Error(`storage list ${prefix}: ${error.message}`);
      if (!files?.length) break;
      for (const f of files) {
        const path = `${prefix}/${f.name}`;
        const { data: blob, error: dlErr } = await sb.storage.from(bucket).download(path);
        if (dlErr) { console.warn(`  ! skipped ${path}: ${dlErr.message}`); continue; }
        const buf = Buffer.from(await blob.arrayBuffer());
        mkdirSync(join(photoDir, prefix), { recursive: true });
        writeFileSync(join(photoDir, prefix, f.name), buf);
        count++; bytes += buf.length;
      }
      if (files.length < 100) break;
    }
  }
  return { count, bytes };
}

(async () => {
  mkdirSync(outDir, { recursive: true });
  console.log(`\ncellar27 backup → ${outDir}\n`);

  const manifest = {
    taken_at: new Date().toISOString(),
    supabase_url: SUPABASE_URL,   // the project URL is public; the key is not
    tables: {},
    storage: null,
  };

  for (const table of TABLES) {
    try {
      const n = await dumpTable(table);
      manifest.tables[table] = n;
      console.log(`  ${String(n).padStart(6)}  ${table}`);
    } catch (e) {
      manifest.tables[table] = `ERROR: ${e.message}`;
      console.error(`  FAILED  ${table} — ${e.message}`);
    }
  }

  if (withPhotos) {
    try {
      const { count, bytes } = await dumpPhotos();
      manifest.storage = { bucket: 'bottle-labels', files: count, bytes };
      console.log(`  ${String(count).padStart(6)}  label photos (${(bytes / 1e6).toFixed(1)} MB)`);
    } catch (e) {
      manifest.storage = `ERROR: ${e.message}`;
      console.error(`  FAILED  storage — ${e.message}`);
    }
  } else {
    console.log('         (photos skipped: --no-photos)');
  }

  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const failed = Object.values(manifest.tables).filter((v) => typeof v === 'string').length;
  console.log(`\n${failed ? `${failed} table(s) FAILED — check above.` : 'All tables captured.'}`);
  console.log(`Manifest: ${join(outDir, 'manifest.json')}\n`);
  process.exit(failed ? 1 : 0);
})();

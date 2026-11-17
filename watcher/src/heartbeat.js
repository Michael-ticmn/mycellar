// Liveness file for an outside monitor (on the home server, a host timer that
// checks every 15 minutes). A process can be up and useless — channels dropped,
// Supabase unreachable — so "the unit is active" isn't enough on its own.
//
// Written atomically (temp file + rename) to HEARTBEAT_FILE on every channel
// status change and after every stale-claim sweep (every 2 min). Unset, it's a
// no-op, which is the laptop's case. Nothing secret goes in it.
//
// Reading it: `ok` is true when both Realtime channels are SUBSCRIBED and the
// last sweep reached Supabase. `at` older than ~5 minutes means the process is
// hung or gone, whatever `ok` last said.

import { writeFile, rename } from 'node:fs/promises';

const FILE = process.env.HEARTBEAT_FILE || '';
let warned = false;

export async function beat({ channels, sweepOk }) {
  if (!FILE) return;
  const states = Object.values(channels);
  const ok = sweepOk === true && states.length === 2 && states.every((s) => s === 'SUBSCRIBED');
  const body = JSON.stringify({ at: new Date().toISOString(), ok, sweep_ok: sweepOk, channels }) + '\n';
  try {
    await writeFile(`${FILE}.tmp`, body, 'utf8');
    await rename(`${FILE}.tmp`, FILE);
    warned = false;
  } catch (e) {
    // Log once per streak: a missing or read-only directory would otherwise
    // write a line every two minutes forever.
    if (!warned) console.error(new Date().toISOString(), `[heartbeat] cannot write ${FILE}: ${e.message}`);
    warned = true;
  }
}

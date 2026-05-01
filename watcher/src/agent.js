// Spawn a fresh `claude --print` session per request.
//
// Why a new process per request rather than a long-lived session: simpler
// failure model, no session-state drift between requests, and concurrent
// requests get parallel agents for free. Trade-off is per-call startup
// cost (a couple of seconds) — acceptable since reasoning takes 10–30s.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { CONFIG } from './config.js';

const ts = () => new Date().toISOString();
const log = (...a) => console.log(ts(), '[agent]', ...a);
const err = (...a) => console.error(ts(), '[agent]', ...a);

// Don't hand watcher secrets (SUPABASE_SERVICE_ROLE_KEY, SMTP_PASS, etc.)
// to the spawned Claude. Only pass vars Claude actually needs: PATH for
// resolving the binary, HOME / USERPROFILE for the OAuth keychain, plus
// the Windows shell essentials so .cmd shims work.
const ENV_ALLOW = [
  'PATH', 'HOME', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA',
  'USERNAME', 'USER', 'LOGNAME',
  'TEMP', 'TMP', 'TMPDIR',
  'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'ComSpec', 'PATHEXT',
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'COLORTERM',
];

function filteredEnv() {
  const out = {};
  for (const k of ENV_ALLOW) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  return out;
}

// Resolve CONFIG.claudeBin to an absolute path. On Windows, npm-installed
// CLIs are .cmd shims (e.g. claude.cmd); spawning by bare name without
// shell:true fails. We previously worked around this by passing
// shell:true, but Node's DEP0190 deprecates that combo (shell-injection
// risk on the concatenated arg string). Resolve the .cmd path explicitly
// once, then spawn it directly with shell:false. No string concat = no
// deprecation, no escaping concerns.
let _resolvedBin = null;
function resolveBin() {
  if (_resolvedBin) return _resolvedBin;
  const bin = CONFIG.claudeBin;
  if (isAbsolute(bin) && existsSync(bin)) return (_resolvedBin = bin);
  const isWin = process.platform === 'win32';
  const exts = isWin ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const sep  = isWin ? ';' : ':';
  for (const dir of (process.env.PATH || '').split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      if (existsSync(candidate)) return (_resolvedBin = candidate);
    }
  }
  // Fall back to the bare name; spawn will surface ENOENT if it can't
  // find it. This keeps the failure mode visible rather than silent.
  return (_resolvedBin = bin);
}

export function invokeBridgeAgent(requestFilePath) {
  if (!CONFIG.autoInvoke) {
    log(`auto-invoke disabled; leaving ${requestFilePath} for manual bridge agent`);
    return;
  }

  const prompt = `A cellar27 bridge request file is at:
${requestFilePath}

Read that file. It contains frontmatter (with a respond_to path you must write the response to) plus Task and Response format sections that describe what to produce. Write your response file at the path given in the respond_to frontmatter field, using the exact response format described in the request. Do not move or delete the request file — the watcher handles archival. If you can't fulfill the request for any reason, still write a response file: include the request_id from the request's frontmatter, explain the problem in the Narrative section, and use an empty Recommendations list (or null fields for scan).`;

  // Note: do NOT pass --bare — it disables keychain reads, which means the
  // spawned claude has no auth and exits with "Please run /login". Without
  // --bare, claude inherits the user's normal OAuth session.
  const args = [
    '--print',
    '--permission-mode', 'acceptEdits',
    '--no-session-persistence',
  ];

  const bin = resolveBin();
  log(`spawning ${bin} for ${requestFilePath}`);
  // Why shell:true on Windows despite DEP0190:
  //   Node 24 refuses to spawn .cmd / .bat files directly (CVE-2024-27980
  //   hardening) — without shell:true the call fails with EINVAL. npm
  //   installs the `claude` CLI as a .cmd shim on Windows, so we have to
  //   route through cmd.exe.
  //   DEP0190 warns because shell:true with args concatenates them into
  //   the shell command line without escaping, which is a shell-injection
  //   risk *if any arg comes from user input*. In our case `args` is the
  //   four hard-coded strings below (no dynamic content reaches it ever),
  //   so the deprecation's reasoning doesn't apply. The warning is noise
  //   for our usage pattern.
  const proc = spawn(bin, args, {
    cwd: CONFIG.bridgeDir,
    shell: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: filteredEnv(),
  });

  proc.stdin.write(prompt);
  proc.stdin.end();

  // Mirror agent output into watcher logs (prefixed) so it's all in one place.
  proc.stdout.on('data', (d) => process.stdout.write(d.toString().replace(/^/gm, '[claude] ')));
  proc.stderr.on('data', (d) => process.stderr.write(d.toString().replace(/^/gm, '[claude] ')));
  proc.on('exit', (code) => log(`claude exited code=${code} for ${requestFilePath}`));
  proc.on('error', (e) => err(`spawn error: ${e.message}`));
}

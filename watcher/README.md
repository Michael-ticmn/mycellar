# cellar27-watcher

Node service that bridges Supabase Realtime ↔ a file-drop folder that Claude Code monitors.

## Where it runs

A detached background `node.exe` process on Windows — no PM2, no Windows service, no Scheduled Task. Started via PowerShell `Start-Process` so it survives any terminal closing. Logs go to `watcher/watcher.out.log` and `watcher/watcher.err.log` (gitignored).

Bridge dir defaults to `~/cellar27-bridge/` (override with `BRIDGE_DIR` in `.env`).

### Find / restart it

```powershell
# Find the running watcher
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*src/index.js*' } |
  Select-Object ProcessId, CommandLine

# Restart in place (kill + start detached)
$watcherDir = "$PWD\watcher"   # adjust if cwd isn't repo root
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*src/index.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Start-Process -FilePath "node.exe" -ArgumentList "src/index.js" `
  -WorkingDirectory $watcherDir -WindowStyle Hidden `
  -RedirectStandardOutput "$watcherDir\watcher.out.log" `
  -RedirectStandardError  "$watcherDir\watcher.err.log"

# Tail logs
Get-Content "$watcherDir\watcher.out.log" -Tail 40 -Wait
```

See [`BUILD_SPEC.md` §2](../BUILD_SPEC.md) for the architecture overview.

## What it does

- Subscribes to `pairing_requests` and `scan_requests` rows where `status='pending'`
- Atomically claims each row (`status='picked_up'`), then renders a markdown file into `~/cellar27-bridge/requests/`
- For scan requests, downloads the label image from Supabase Storage to `~/cellar27-bridge/images/<uuid>.<ext>` and references that local path in the markdown
- Watches `~/cellar27-bridge/responses/` for files Claude Code writes back; parses them, inserts into `pairing_responses` / `scan_responses`, marks the request `completed`, archives both files into `~/cellar27-bridge/processed/`
- Every 2 min calls the Postgres function `cellar27_sweep_stale_claims` to recover rows stuck in `picked_up` (resets to `pending` for up to 2 retries, then `error`)
- Before each `claude --print` spawn, calls `cellar27_try_record_spawn(MAX_CLAUDE_CALLS_PER_DAY)` — atomic global daily ceiling; refuses to spawn at cap and marks the request `error`
- On startup, sweeps any rows left `pending` while the watcher was down, and runs the stale-claim sweep once

## Setup

```bash
cd watcher
npm install

cp .env.example .env
# fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
# (Service role key — Settings → API in Supabase. NEVER ship to the frontend.)

# Optional override; defaults to ~/cellar27-bridge
# On Windows: BRIDGE_DIR=C:/Users/<your-username>/cellar27-bridge

npm start
```

Folders under `BRIDGE_DIR` (`requests/`, `responses/`, `processed/`, `images/`) are auto-created at startup.

## Reasoning agent — auto-spawned by default

By default (`AUTO_INVOKE=true` in `.env`), the watcher spawns a fresh `claude --print` session per request and pipes the prompt over stdin. The agent reads the request file, writes the response file at the path in `respond_to`, exits. No long-running session, no manual nudging. See [`src/agent.js`](src/agent.js).

Flags used: `--print` (non-interactive), `--permission-mode acceptEdits` (auto-accept Read/Write), `--no-session-persistence` (don't accumulate session history). `cwd` is `BRIDGE_DIR`. `claude` resolves via PATH (override with `CLAUDE_BIN` in `.env`).

Note: do NOT pass `--bare`. It disables keychain reads, so the spawned `claude` would have no auth and fail with "Please run /login". Without `--bare`, `claude` uses the host user's existing OAuth session.

### Manual fallback

Set `AUTO_INVOKE=false` if you'd rather drive a long-running interactive session yourself (useful for debugging request/response formatting). Then in a separate terminal:

```bash
cd <BRIDGE_DIR>
claude
```

Paste this prompt verbatim:

> You are the cellar27 reasoning agent. New request files appear in `requests/` named `req-<uuid>.md` (pairing/flight/drink-now) or `scan-<uuid>.md` (label scan). For each new file: read it, follow the Task and Response format sections, write the response file at the path in the `respond_to` frontmatter field. Do not move or delete the request file — the watcher handles archival. If you can't fulfill a request, write a response file that explains why in the Narrative section and uses an empty Recommendations list (or null Extracted/Match for scan).

You'll need to nudge it ("check requests/ for new files") each time something arrives.

In both modes the watcher detects the response file via chokidar, ingests it, and archives both files into `processed/`.

## Bridge contract

See [BUILD_SPEC.md §2.2 / §2.2b](../BUILD_SPEC.md) for the exact markdown formats. The renderer in [`src/render.js`](src/render.js) produces them; the parser in [`src/parse.js`](src/parse.js) tolerates minor formatting drift (extra whitespace, optional fields).

## Layout

```
watcher/
├── package.json
├── .env.example
├── .env             (gitignored)
└── src/
    ├── index.js     main loop: subscribe, watch, timeout, lifecycle
    ├── config.js    loads env, derives bridge dir layout
    ├── render.js    Supabase row → markdown request file
    ├── parse.js     markdown response file → Supabase row
    └── agent.js     spawns `claude --print` per request
```

## Troubleshooting

- **"Missing required env var"** at startup → fill in `.env`
- **Realtime channel stuck on "CONNECTING"** → confirm Realtime is enabled on the relevant tables in Supabase (Database → Replication → enable `pairing_requests`, `scan_requests`, `pairing_responses`, `scan_responses` for the `supabase_realtime` publication)
- **Storage download fails** → the service role key bypasses RLS, but the bucket must exist (`bottle-labels`, created by `supabase/migrations/0001_init.sql`)
- **Response files aren't being picked up** → check filename prefix. `req-<uuid>.md` for pairing, `scan-<uuid>.md` for scan. Anything else is ignored.
- **Request stuck in `picked_up`** → `cellar27_sweep_stale_claims` (called every 2 min) resets it to `pending` for up to 2 retries, then sets `error`. Check `error_message` and `retry_count`. `claimed_by` should be the host's hostname; if NULL on a fresh row, the watcher is running pre-P0 code — restart it (see "Where it runs" above).
- **Insert from phone fails with "row violates row-level security policy"** → user_id isn't in `cellar27_allowed_users`, or `cellar27_check_rate_limit` returned false (>20 requests in the last hour). Seed the allowlist via service_role.
- **Request errors with "Daily AI capacity reached"** → `MAX_CLAUDE_CALLS_PER_DAY` ceiling hit. See `cellar27_watcher_metrics` for today's count; bump the env var and restart if needed.

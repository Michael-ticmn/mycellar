# cellar27-watcher

Node service that bridges Supabase Realtime ↔ a file-drop folder that Claude Code monitors.

## Where it runs

A background `node.exe` process on Windows — no PM2, no Windows service. Logs go to `watcher/watcher.out.log` and `watcher/watcher.err.log` (gitignored).

Started at logon by the **`cellar27-watcher`** Scheduled Task (added 2026-09-19, after a reboot left it down for four days). The task runs [`start-watcher.ps1`](start-watcher.ps1), which skips starting if a watcher is already up, rotates the previous run's logs to `.bak` (keeping the last 10), then runs node in the foreground so the task tracks it. Mirrors the existing `vault27-watcher` task: user `MRJ`, interactive logon, limited privileges, no execution time limit.

**It only starts at logon.** The task's "restart on failure" (3 attempts, 1 minute apart) does not cover the wrapper being killed after it launched. On 2026-09-20 the wrapper exited `0xC000013A` (killed from outside, cause unknown) and the watcher stayed down until a manual restart on 09-25, with requests going unanswered. A repeating trigger that re-runs the launcher was considered and declined (2026-09-26), so a dead watcher stays dead until the next logon or a manual start. If requests sit pending, check here first.

```powershell
Get-ScheduledTask -TaskName 'cellar27-watcher'          # State: Running when healthy, Ready = watcher is down
Start-ScheduledTask -TaskName 'cellar27-watcher'        # start it (preferred way to restart)
Stop-ScheduledTask  -TaskName 'cellar27-watcher'        # stop it (also kills node)
```

The guard matches this repo's `src\index.js` by **full path**. myvinyl and mycabinet also run watchers as `node src/index.js`, and the original relative match mistook either one for cellar27's (fixed 2026-09-26). Anything that finds or kills this watcher must match the full path too.

Starting it by hand with `Start-Process` (below) still works and survives any terminal closing; the task's guard means a later logon won't start a second copy. Do NOT append to the logs with PowerShell `>>` — Windows PowerShell 5.1 writes UTF-16 and mangles the file.

Bridge dir defaults to `~/cellar27-bridge/` (override with `BRIDGE_DIR` in `.env`).

### Find / restart it

```powershell
# Find the running watcher. Full path only: a bare '*src/index.js*' also matches
# (and the kill below would also stop) the myvinyl and mycabinet watchers.
$watcherDir = "$PWD\watcher"   # adjust if cwd isn't repo root
$script = "$watcherDir\src\index.js"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*$script*" } |
  Select-Object ProcessId, CommandLine

# Restart in place (kill + start detached)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*$script*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Start-Process -FilePath "node.exe" -ArgumentList "`"$script`"" `
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

Flags used: `--print` (non-interactive), **`--tools Read,Write`** (see below), `--permission-mode acceptEdits` (auto-accept the response-file write), `--no-session-persistence` (don't accumulate session history). `cwd` is `BRIDGE_DIR`. `claude` resolves via PATH (override with `CLAUDE_BIN` in `.env`).

Note: do NOT pass `--bare`. It disables keychain reads, so the spawned `claude` would have no auth and fail with "Please run /login". Without `--bare`, `claude` uses the host user's existing OAuth session.

**`--tools Read,Write` is a security boundary, not a tidiness measure.** The request file contains free text typed by whoever made the request — including an anonymous share-link guest, since `cellar27_share_create_pairing_request` is granted to `anon`. `src/render.js` delimits and neutralizes that text, but prompt injection isn't solved by escaping alone, so the agent also gets no other tools: no Bash, no WebFetch/WebSearch, no MCP. No command execution, no network egress. Combined with `cwd` = `BRIDGE_DIR` (reads outside it prompt, and `--print` auto-denies prompts), `.env` is out of reach even though this process holds those secrets.

Note it must be `--tools`, which limits the available set — **not** `--allowedTools`, which only pre-approves tools and would leave Bash available. Before widening this, read Layer 9 in [`docs/SECURITY.md`](../docs/SECURITY.md); it includes a one-line regression check.

### Concurrency and hung agents

`MAX_CONCURRENT_AGENTS` (default 3) caps how many `claude` processes run at once; the rest queue FIFO. Five in-flight requests per user across a few users is otherwise a lot of simultaneous sessions on one laptop.

A process that hangs is killed at `TIMEOUT_MINUTES + 2`, deliberately just after the DB-side stale-claim sweep gives up, so the row is recovered first and the process follows. Before this, the sweep freed the row but left the process alive indefinitely, holding memory and an API session.

The queue is memory-only. If the watcher dies with items in it, those rows stay `picked_up` and the stale-claim sweep returns them to `pending` on restart — the recovery path that already exists.

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
- **Insert from phone fails with "row violates row-level security policy"** → user_id isn't in `cellar27_allowed_users`, or `cellar27_check_rate_limit` returned false (default 100 requests/hour as of v0.8). Seed the allowlist via service_role.
- **Request errors with "Daily AI capacity reached"** → `MAX_CLAUDE_CALLS_PER_DAY` ceiling hit (default 250). See `cellar27_watcher_metrics` for today's count; bump the env var and restart if needed.
- **Request errors with "policy: rate limit: N/100 requests in last hour"** → watcher-side in-memory rate limit (cleared on restart, tunable via `WATCHER_RATE_LIMIT_PER_HOUR`).
- **`<channel> dropped; reconnect attempt N in 60s` repeating** → genuine loss of connectivity to Supabase, not a bug. Expect roughly one line per channel per minute once backoff reaches its 60s cap; `attempts` resets to 0 on a successful re-subscribe, and a `reconnected after N attempt(s); sweeping stale pending` line follows. If you instead see *several* interleaved attempt counters for the same channel, or `CLOSED` alternating rapidly with `SUBSCRIBED`, that's the pre-v0.13.3 self-teardown loop — update the watcher.
- **`network unreachable (...) — suppressing repeats until it recovers`** → the sweep hit a DNS/connect failure. Only the first is logged; a `network recovered after N failed attempt(s)` line reports the outage length once it clears. Non-network errors are never suppressed, so anything else in `watcher.err.log` is real.
- **Insert fails with `violates check constraint "pairing_requests_context_size"`** → something is shipping more than 4 KB inline in `context`. Don't raise the cap; fetch the data watcher-side from its row instead, as `flight_plan` / `flight_guest` do via `hydratePlanContext()`. See "Planned-flight requests" in [`ARCHITECTURE.md`](../ARCHITECTURE.md).

## Email notifications

The watcher emails you when something needs a person, so you are not reading logs to find out. Set the SMTP env vars in `.env`:

```ini
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=<16-char Gmail App Password>
NOTIFY_FROM=you@gmail.com
NOTIFY_TO=you@gmail.com
```

Leave any one blank to disable silently. `NOTIFY_COOLDOWN_MS` (default 30 min) suppresses repeated sends of the same limit-key so a runaway loop can't flood your inbox.

The emails are informational — no inline approval.

### What sends mail

| Trigger | Cooldown key | What it means |
| --- | --- | --- |
| Policy denial | `policy:<user_id>` | A user hit a watcher-side limit. Body names the limit and the SQL/env tweak to grant more. |
| Daily ceiling | `daily-ceiling` | `MAX_CLAUDE_CALLS_PER_DAY` reached. Resets midnight UTC. |
| Fatal error | `watcher-fatal:<reason>` | The process is exiting on an uncaught error / rejection / chokidar failure. |
| **pickUp failure** | `pickup-failure` | **The watcher is running but failing the requests it claims.** |

That last one exists because it is the failure with no other symptom. Both sweeps catch per-row throws so one bad row cannot abort the batch, and the realtime path only writes the message onto the row — so a watcher failing *every* request still has a live process, `SUBSCRIBED` channels and a quiet `watcher.out.log`. Without this email the first sign is the app refusing new work, once the stranded rows fill the 5-in-flight cap. That is exactly how a startup-sweep bug went unnoticed for days in August 2026.

Network errors are excluded — this runs on a laptop that sleeps, and those clear on their own (same rule the sweep logging uses). Failures are reported per batch, not per row, so the count in the subject is the real one rather than the first of five with the rest swallowed by the cooldown.

Note what is still silent: a watcher that is *gone* sends nothing, because nothing is left running to send it. A reboot never reaches the fatal path. Detecting that needs something outside this process.

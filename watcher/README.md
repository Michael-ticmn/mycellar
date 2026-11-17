# cellar27-watcher

Node service that turns `pairing_requests` / `scan_requests` rows into Claude API calls and writes the answers back to Supabase.

## Where it runs

A background `node.exe` process on Windows — no PM2, no Windows service. Logs go to `watcher/watcher.out.log` and `watcher/watcher.err.log` (gitignored).

Started at logon by the **`cellar27-watcher`** Scheduled Task (added 2026-09-19, after a reboot left it down for four days). The task runs [`start-watcher.ps1`](start-watcher.ps1), which skips starting if a watcher is already up, rotates the previous run's logs to `.bak` (keeping the last 10), then runs node in the foreground so the task tracks it. Mirrors the existing `vault27-watcher` task: runs as the owner's own account, interactive logon, limited privileges, no execution time limit.

**It only starts at logon.** The task's "restart on failure" (3 attempts, 1 minute apart) does not cover the wrapper being killed after it launched. On 2026-09-20 the wrapper exited `0xC000013A` (killed from outside, cause unknown) and the watcher stayed down until a manual restart on 09-25, with requests going unanswered. A repeating trigger that re-runs the launcher was considered and declined (2026-09-26), so a dead watcher stays dead until the next logon or a manual start. If requests sit pending, check here first.

```powershell
Get-ScheduledTask -TaskName 'cellar27-watcher'          # State: Running when healthy, Ready = watcher is down
Start-ScheduledTask -TaskName 'cellar27-watcher'        # start it (preferred way to restart)
Stop-ScheduledTask  -TaskName 'cellar27-watcher'        # stops the wrapper only, NOT node
```

`Stop-ScheduledTask` does not stop the watcher. On 2026-10-03 it ended the PowerShell wrapper and left node running, so the following `Start-ScheduledTask` hit the already-running guard and exited, and the old code stayed live. To restart onto new code, kill node by full path (recipe below), then `Start-ScheduledTask`.

The guard matches this repo's `src\index.js` by **full path**. myvinyl and mycabinet also run watchers as `node src/index.js`, and the original relative match mistook either one for cellar27's (fixed 2026-09-26). Anything that finds or kills this watcher must match the full path too.

Starting it by hand with `Start-Process` (below) still works and survives any terminal closing; the task's guard means a later logon won't start a second copy. Do NOT append to the logs with PowerShell `>>` — Windows PowerShell 5.1 writes UTF-16 and mangles the file.

Don't start it from inside a Claude Code session's shell either: dotenv never overrides a variable that is already set, and Claude Code exports its own variables to the processes it starts. The watcher's own settings are prefixed `CELLAR27_` for that reason. `ANTHROPIC_API_KEY` keeps its standard name, so the launching environment must not export one.

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
- Atomically claims each row (`status='picked_up'`), then renders the request into a markdown prompt
- For scan requests, downloads the label photos from Supabase Storage (owner-scoped, see Layer 10 in [`docs/SECURITY.md`](../docs/SECURITY.md)) and attaches them to the call as images. They never touch this disk.
- Before each call, `cellar27_try_record_spawn(MAX_CLAUDE_CALLS_PER_DAY)` enforces the atomic global daily ceiling; at cap the request is marked `error`
- Calls the Claude Messages API once per request, parses the reply, inserts into `pairing_responses` / `scan_responses` and marks the request `completed`. On failure the request is marked `error` with a message the app shows.
- Every 2 min calls the Postgres function `cellar27_sweep_stale_claims` to recover rows stuck in `picked_up` (resets to `pending` for up to 2 retries, then `error`)
- On startup, sweeps any rows left `pending` while the watcher was down, and runs the stale-claim sweep once

Only outbound connections: Supabase (REST, Realtime, Storage), `api.anthropic.com`, `api.open-meteo.com` (weather, optional) and the SMTP host (alerts, optional). It listens on no port.

## Setup

```bash
cd watcher
npm install

cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and ANTHROPIC_API_KEY
# (Service role key — Settings → API in Supabase. NEVER ship to the frontend.)

npm start
```

## Claude API calls

Until 2026-11-17 the watcher spawned `claude --print` per request and passed the prompt and the answer through files (`~/cellar27-bridge/`). It now makes one Messages API call per request from [`src/claude.js`](src/claude.js), paid from the Max plan's monthly API credits ($100, which cover the API but not Claude Code; unused credit expires each billing cycle; when it runs out, calls fail until the next cycle and the owner gets an email).

- **Model:** `claude-opus-5-5` at `medium` effort, overridable with `CELLAR27_MODEL` / `CELLAR27_EFFORT`. Adaptive thinking is always on for this model. If a safety classifier declines a request, the API re-runs it on its chosen fallback model inside the same call (`fallbacks: "default"`).
- **No tools.** The request carries no `tools`, so the model can only return text. This replaced the `--tools Read,Write` boundary; see Layer 9 in [`docs/SECURITY.md`](../docs/SECURITY.md) before adding any.
- **Reply format:** the same markdown sections the file bridge used, now as the reply text. [`src/render.js`](src/render.js) describes them per request type; [`src/parse.js`](src/parse.js) reads them and tolerates minor drift. A reply wrapped in one outer code fence is unwrapped first.
- **Cost:** each call logs model, stop reason, input/output tokens and an estimated cost (Opus 5.5 at $4 / $20 per million tokens). Thinking is billed as output.
- **Timeouts and retries:** the SDK retries network errors, 429 and 5xx twice. Each attempt's timeout is sized so a call and its retries end inside `TIMEOUT_MINUTES`, before the stale-claim sweep would hand the row to a second call.
- **Concurrency:** `MAX_CONCURRENT_AGENTS` (default 3) caps simultaneous calls; the rest queue FIFO. The queue is memory-only: if the watcher dies with items in it, those rows stay `picked_up` and the stale-claim sweep returns them to `pending` on restart.

## Layout

```
watcher/
├── package.json
├── .env.example
├── .env             (gitignored)
└── src/
    ├── index.js     main loop: subscribe, claim, call, record, sweep, lifecycle
    ├── config.js    loads and validates env
    ├── render.js    Supabase row → markdown prompt
    ├── claude.js    one Messages API call per request; failure classification
    ├── parse.js     markdown reply → Supabase row
    ├── policy.js    allowlist, watcher-side rate limit, storage path ownership
    ├── weather.js   current conditions for the prompt (Open-Meteo)
    └── notify.js    SMTP alerts
```

## Troubleshooting

- **"Missing required env var"** at startup → fill in `.env`
- **Realtime channel stuck on "CONNECTING"** → confirm Realtime is enabled on the relevant tables in Supabase (Database → Replication → enable `pairing_requests`, `scan_requests`, `pairing_responses`, `scan_responses` for the `supabase_realtime` publication)
- **Storage download fails** → the service role key bypasses RLS, but the bucket must exist (`bottle-labels`, created by `supabase/migrations/0001_init.sql`)
- **Every request errors with "The sommelier is unavailable right now."** → the API rejected the call in a way retrying won't fix, and a `cellar27 — Claude API calls are failing` email went out. Usual causes: the month's credits are used up (Console → Billing → Promotional credits), `ANTHROPIC_API_KEY` is wrong or revoked, or `CELLAR27_MODEL` names a model the org can't use. The full error is in the watcher log.
- **"The sommelier is busy right now." / "Couldn't reach the sommelier."** → 429/5xx or a network failure that outlasted the SDK's two retries. Transient; no email.
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
| Fatal error | `watcher-fatal:<reason>` | The process is exiting on an uncaught error or rejection. |
| **pickUp failure** | `pickup-failure` | **The watcher is running but failing the requests it claims.** |
| API failure | `claude-api` | A Claude API call failed in a way retrying won't fix: credits used up, bad key, unavailable model. |

That last one exists because it is the failure with no other symptom. Both sweeps catch per-row throws so one bad row cannot abort the batch, and the realtime path only writes the message onto the row — so a watcher failing *every* request still has a live process, `SUBSCRIBED` channels and a quiet `watcher.out.log`. Without this email the first sign is the app refusing new work, once the stranded rows fill the 5-in-flight cap. That is exactly how a startup-sweep bug went unnoticed for days in August 2026.

Network errors are excluded — this runs on a laptop that sleeps, and those clear on their own (same rule the sweep logging uses). Failures are reported per batch, not per row, so the count in the subject is the real one rather than the first of five with the rest swallowed by the cooldown.

Note what is still silent: a watcher that is *gone* sends nothing, because nothing is left running to send it. A reboot never reaches the fatal path. Detecting that needs something outside this process.

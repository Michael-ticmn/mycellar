# cellar27-watcher

Node service that bridges Supabase Realtime ↔ a file-drop folder that Claude Code monitors. Runs on the home-lab Win11 VM under PM2 (or a Windows Scheduled Task).

See [`BUILD_SPEC.md` §2](../BUILD_SPEC.md) for the architecture overview.

## What it does

- Subscribes to `pairing_requests` and `scan_requests` rows where `status='pending'`
- Atomically claims each row (`status='picked_up'`), then renders a markdown file into `~/cellar27-bridge/requests/`
- For scan requests, downloads the label image from Supabase Storage to `~/cellar27-bridge/images/<uuid>.<ext>` and references that local path in the markdown
- Watches `~/cellar27-bridge/responses/` for files Claude Code writes back; parses them, inserts into `pairing_responses` / `scan_responses`, marks the request `completed`, archives both files into `~/cellar27-bridge/processed/`
- Times out anything stuck in `picked_up` longer than `TIMEOUT_MINUTES` (default 10) by setting `status='error'`
- On startup, sweeps any rows that were left `pending` while the watcher was down

## Setup

```bash
cd watcher
npm install

cp .env.example .env
# fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
# (Service role key — Settings → API in Supabase. NEVER ship to the frontend.)

# Optional override; defaults to ~/cellar27-bridge
# On Windows: BRIDGE_DIR=C:/Users/michael/cellar27-bridge

npm start
```

Folders under `BRIDGE_DIR` (`requests/`, `responses/`, `processed/`, `images/`) are auto-created at startup.

## Running unattended (PM2)

```bash
npm install -g pm2
pm2 start src/index.js --name cellar27-watcher --update-env
pm2 logs cellar27-watcher          # follow logs
pm2 save                            # persist across reboots
pm2 startup                         # generate startup script (Linux/macOS)
```

On Windows, use `pm2-windows-startup` or wrap `pm2 resurrect` in a Scheduled Task triggered at logon.

## Running Claude Code on the same VM

The watcher only handles the Supabase ↔ filesystem half. Claude Code itself reads `~/cellar27-bridge/requests/<file>` and writes `~/cellar27-bridge/responses/<file>`. Launch a long-running session in the bridge directory:

```bash
cd ~/cellar27-bridge
claude   # or however you invoke Claude Code on the VM
```

Give the session this prompt (paste verbatim):

> You are the cellar27 reasoning agent. New request files appear in `requests/` named `req-<uuid>.md` (pairing/flight/drink-now) or `scan-<uuid>.md` (label scan). For each new file: read it, follow the Task and Response format sections, write the response file at the path in the `respond_to` frontmatter field. Do not move or delete the request file — the watcher handles archival. If you can't fulfill a request, write a response file that explains why in the Narrative section and uses an empty Recommendations list (or null Extracted/Match for scan).

The watcher detects the response file via chokidar, ingests it, and archives both files into `processed/`.

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
    └── parse.js     markdown response file → Supabase row
```

## Troubleshooting

- **"Missing required env var"** at startup → fill in `.env`
- **Realtime channel stuck on "CONNECTING"** → confirm Realtime is enabled on the relevant tables in Supabase (Database → Replication → enable `pairing_requests`, `scan_requests`, `pairing_responses`, `scan_responses` for the `supabase_realtime` publication)
- **Storage download fails** → the service role key bypasses RLS, but the bucket must exist (`bottle-labels`, created by `supabase/migrations/0001_init.sql`)
- **Response files aren't being picked up** → check filename prefix. `req-<uuid>.md` for pairing, `scan-<uuid>.md` for scan. Anything else is ignored.
- **Request stuck in `picked_up`** → after `TIMEOUT_MINUTES` it auto-flips to `error`. Check `error_message` column for context.

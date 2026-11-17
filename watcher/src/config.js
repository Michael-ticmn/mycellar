import 'dotenv/config';

// ANTHROPIC_API_KEY belongs in watcher/.env and nowhere else. In particular not
// in a Windows user or system environment variable: Claude Code reads that
// variable too, and on a machine where the key's org holds only the Max plan's
// API credits (which don't cover Claude Code) the owner's own sessions would
// start failing with "Credit balance too low".
const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY'];
for (const k of required) {
  if (!process.env[k]) {
    console.error(`Missing required env var: ${k}. See .env.example.`);
    process.exit(1);
  }
}

// Every numeric setting used to go through a bare parseInt, so a typo became
// NaN and propagated silently into control flow that fails totally and without
// a log line. TIMEOUT_MINUTES=1o made AGENT_TIMEOUT_MS NaN, which setTimeout
// treats as 0 — every agent killed the instant it spawned. An empty
// MAX_CONCURRENT_AGENTS made `running < NaN` false, so the queue grew forever
// and nothing ever ran. .env is hand-edited on a box with no supervisor
// watching, so refuse to start instead of misbehaving quietly.
export function intEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(
      `Invalid ${name}=${JSON.stringify(raw)} — expected an integer between ${min} and ${max}. See .env.example.`);
    process.exit(1);
  }
  return n;
}

// Prefixed on purpose. Claude Code exports CLAUDE_EFFORT to the processes it
// starts, so an unprefixed name would let a watcher launched from a Claude
// session silently inherit that session's effort; and dotenv never overrides a
// variable that is already set, so .env couldn't correct it.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const effort = (process.env.CELLAR27_EFFORT || 'medium').toLowerCase();
if (!EFFORTS.includes(effort)) {
  console.error(`Invalid CELLAR27_EFFORT=${JSON.stringify(process.env.CELLAR27_EFFORT)}: expected one of ${EFFORTS.join(', ')}. See .env.example.`);
  process.exit(1);
}

export const CONFIG = {
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.CELLAR27_MODEL || 'claude-opus-5-5',
    effort,
  },
  timeoutMinutes: intEnv('TIMEOUT_MINUTES', 10, { min: 1, max: 24 * 60 }),
  maxClaudeCallsPerDay: intEnv('MAX_CLAUDE_CALLS_PER_DAY', 250, { min: 1, max: 100_000 }),
  notify: {
    // SMTP (Gmail with an App Password works fine; Resend SMTP also fine).
    // Leave any one of these unset to disable notifications silently.
    host: process.env.SMTP_HOST,
    port: intEnv('SMTP_PORT', 587, { min: 1, max: 65535 }),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.NOTIFY_FROM || process.env.SMTP_USER,
    to:   process.env.NOTIFY_TO,
    cooldownMs: intEnv('NOTIFY_COOLDOWN_MS', 30 * 60_000, { min: 0 }),
  },
  storageBucket: 'bottle-labels',
  // Comma-separated user UUIDs allowed to consume bridge compute.
  // Empty/unset = open mode (every signed-in user allowed) — only safe
  // if Supabase "Allow new users to sign up" is OFF.
  allowedUserIds: new Set(
    (process.env.ALLOWED_USER_IDS || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
  ),
};

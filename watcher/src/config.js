import 'dotenv/config';
import { homedir } from 'node:os';
import { join } from 'node:path';

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
for (const k of required) {
  if (!process.env[k]) {
    console.error(`Missing required env var: ${k}. See .env.example.`);
    process.exit(1);
  }
}

const bridgeDir = process.env.BRIDGE_DIR || join(homedir(), 'cellar27-bridge');

export const CONFIG = {
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  bridgeDir,
  dirs: {
    requests:  join(bridgeDir, 'requests'),
    responses: join(bridgeDir, 'responses'),
    processed: join(bridgeDir, 'processed'),
    images:    join(bridgeDir, 'images'),
  },
  timeoutMinutes: parseInt(process.env.TIMEOUT_MINUTES || '10', 10),
  maxClaudeCallsPerDay: parseInt(process.env.MAX_CLAUDE_CALLS_PER_DAY || '250', 10),
  notify: {
    // SMTP (Gmail with an App Password works fine; Resend SMTP also fine).
    // Leave any one of these unset to disable notifications silently.
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.NOTIFY_FROM || process.env.SMTP_USER,
    to:   process.env.NOTIFY_TO,
    cooldownMs: parseInt(process.env.NOTIFY_COOLDOWN_MS || `${30 * 60_000}`, 10),
  },
  storageBucket: 'bottle-labels',
  autoInvoke: (process.env.AUTO_INVOKE || 'true').toLowerCase() !== 'false',
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  // Comma-separated user UUIDs allowed to consume bridge compute.
  // Empty/unset = open mode (every signed-in user allowed) — only safe
  // if Supabase "Allow new users to sign up" is OFF.
  allowedUserIds: new Set(
    (process.env.ALLOWED_USER_IDS || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
  ),
};

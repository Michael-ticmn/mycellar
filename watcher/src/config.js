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
  storageBucket: 'bottle-labels',
  autoInvoke: (process.env.AUTO_INVOKE || 'true').toLowerCase() !== 'false',
  claudeBin: process.env.CLAUDE_BIN || 'claude',
};

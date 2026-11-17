// One Messages API call per request. No tools, no files, no child process.
//
// Until 2026-11-17 the watcher spawned `claude --print` per request: it wrote
// the prompt to a file, the agent read it with the Read tool and wrote its
// answer with the Write tool, and chokidar picked the answer up. The tools only
// ever moved the prompt and the answer through the disk. The Max plan's
// included API credits cover the Claude API but not Claude Code, so the work
// moved here, and the file round-trip went with it.
//
// Containment (docs/SECURITY.md Layer 9) is now structural. The request has no
// `tools`, so the model can only return text: it cannot read a file, run a
// command or reach the network, and the prompt holds nothing secret to repeat.
// What injected guest text can still do is steer the wording of the answer,
// which is what render.js's input framing is for.

import Anthropic from '@anthropic-ai/sdk';
import { CONFIG, intEnv } from './config.js';

const ts = () => new Date().toISOString();
const log = (...a) => console.log(ts(), '[claude]', ...a);

// The stale-claim sweep hands a row back to 'pending' once it has been
// picked_up for TIMEOUT_MINUTES, and the retry would call the API a second
// time. So the SDK's worst case (three attempts, two retries) has to fit inside
// that window with a minute to spare: 3 min per attempt at the default 10.
const MAX_RETRIES = 2;
const ATTEMPT_TIMEOUT_MS = Math.max(
  60_000, Math.floor((CONFIG.timeoutMinutes * 60_000 - 60_000) / (MAX_RETRIES + 1)));

const client = new Anthropic({
  apiKey: CONFIG.anthropic.apiKey,   // explicit: never fall back to another credential source
  timeout: ATTEMPT_TIMEOUT_MS,
  maxRetries: MAX_RETRIES,
});

// Concurrency cap, as before: several users with 5 in flight each would
// otherwise open that many simultaneous calls. Queued work is FIFO and
// memory-only; if the watcher dies with items queued, those rows stay
// 'picked_up' and the stale-claim sweep returns them to 'pending' on restart.
const MAX_CONCURRENT = intEnv('MAX_CONCURRENT_AGENTS', 3, { min: 1, max: 32 });
let running = 0;
const queue = [];

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    running++;
    job().finally(() => { running--; pump(); });
  }
}

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject));
    if (queue.length > 1 || running >= MAX_CONCURRENT) {
      log(`queued (${running} running, ${queue.length} waiting)`);
    }
    pump();
  });
}

// A completed call whose answer can't be used. Carries the message the user
// sees on the request row.
export class UnusableAnswer extends Error {
  constructor(message, userMessage) {
    super(message);
    this.userMessage = userMessage;
  }
}

// Published Claude API prices per million tokens, for the log line only. A
// model not listed here logs tokens without an estimate.
const PRICE_PER_MTOK = { 'claude-opus-5-5': { input: 4, output: 20 } };

function usageLine(requestId, res, ms) {
  const u = res.usage || {};
  const p = PRICE_PER_MTOK[res.model];
  const cost = p
    ? ` est $${(((u.input_tokens || 0) * p.input + (u.output_tokens || 0) * p.output) / 1e6).toFixed(4)}`
    : '';
  const fellBack = (u.iterations || []).some((i) => i.type === 'fallback_message') ? ' (fallback model)' : '';
  return `${requestId}: ${res.model}${fellBack} stop=${res.stop_reason} in=${u.input_tokens ?? '?'} out=${u.output_tokens ?? '?'}${cost} ${(ms / 1000).toFixed(1)}s`;
}

// content: Messages API content blocks for the single user turn (label photos,
// then the rendered request). Resolves with the answer's text.
export function askClaude(requestId, content) {
  return enqueue(async () => {
    const started = Date.now();
    const res = await client.beta.messages.create({
      model: CONFIG.anthropic.model,
      max_tokens: 16000,
      output_config: { effort: CONFIG.anthropic.effort },
      // If a safety classifier declines, the API re-runs the request on the
      // fallback model it picks for that refusal category, inside this call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content }],
    });
    log(usageLine(requestId, res, Date.now() - started));

    if (res.stop_reason === 'refusal') {
      throw new UnusableAnswer(
        `refused (${res.stop_details?.category ?? 'no category'})`,
        'The sommelier declined this request.');
    }
    if (res.stop_reason === 'max_tokens') {
      throw new UnusableAnswer('hit max_tokens', 'The sommelier ran out of room. Try again.');
    }
    const text = unwrapFence(res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim());
    if (!text) throw new UnusableAnswer('empty answer', 'The sommelier returned nothing. Try again.');
    return text;
  });
}

// The response format is markdown with ## sections. A model will sometimes wrap
// the whole reply in one ```markdown fence; parse.js reads sections by heading,
// so the stray closing fence would end up in the last section. Unwrap that one
// case and leave everything else alone.
export function unwrapFence(text) {
  const m = text.match(/^```(?:markdown|md)?[ \t]*\n([\s\S]*)\n```[ \t]*$/i);
  return m ? m[1].trim() : text;
}

// What to tell the user, and whether the owner needs to hear about it.
// Transient trouble (network, 429, 5xx) has already been retried by the SDK;
// the user can simply try again. Anything else means the watcher can't do its
// job until someone acts: a bad or revoked key, the month's credits used up,
// a model this org can't use, or a request shape the API rejects.
export function describeFailure(e) {
  if (e instanceof UnusableAnswer) return { userMessage: e.userMessage, ownerShouldKnow: false };
  if (e instanceof Anthropic.APIConnectionError) {
    return { userMessage: "Couldn't reach the sommelier. Try again in a minute.", ownerShouldKnow: false };
  }
  if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError) {
    return { userMessage: 'The sommelier is busy right now. Try again in a minute.', ownerShouldKnow: false };
  }
  return { userMessage: 'The sommelier is unavailable right now.', ownerShouldKnow: true };
}

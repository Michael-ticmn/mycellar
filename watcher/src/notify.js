// Email notifier for limit hits. Uses nodemailer + SMTP.
//
// All four SMTP fields (host/user/pass/to) must be set or notify becomes
// a no-op (logs to stdout instead). Each (key) gets a cooldown so we
// don't spam — useful when a runaway loop trips the same limit over and
// over.

import nodemailer from 'nodemailer';
import { CONFIG } from './config.js';

const ts = () => new Date().toISOString();
const log = (...a) => console.log(ts(), '[notify]', ...a);
const err = (...a) => console.error(ts(), '[notify]', ...a);

const lastSent = new Map(); // key → timestamp
let _transport = null;

function transport() {
  if (_transport) return _transport;
  const { host, port, user, pass } = CONFIG.notify;
  if (!host || !user || !pass) return null;
  _transport = nodemailer.createTransport({
    host, port,
    secure: port === 465,
    auth: { user, pass },
  });
  return _transport;
}

export function isNotifyConfigured() {
  const { host, user, pass, to } = CONFIG.notify;
  return Boolean(host && user && pass && to);
}

// notify({ key, subject, body }) — key is the cooldown bucket; subject/body are the email.
export async function notify({ key, subject, body }) {
  if (!isNotifyConfigured()) {
    log(`(no SMTP config) would have notified: ${subject}`);
    return;
  }
  const now = Date.now();
  const last = lastSent.get(key) || 0;
  if (now - last < CONFIG.notify.cooldownMs) {
    log(`cooldown: skipping ${key} (last sent ${Math.round((now - last) / 1000)}s ago)`);
    return;
  }
  try {
    const t = transport();
    await t.sendMail({
      from: CONFIG.notify.from,
      to:   CONFIG.notify.to,
      subject,
      text: body,
    });
    lastSent.set(key, now);
    log(`sent: ${subject}`);
  } catch (e) {
    err(`send failed for ${key}: ${e.message}`);
  }
}

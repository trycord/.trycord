// Mail subsystem: the single place outgoing email is configured and sent.
//
//   MAIL_MODE=log   (default) capture messages to the server log. Safe for
//                   development; nothing is actually delivered.
//   MAIL_MODE=smtp  deliver through the configured SMTP relay.
//
// SMTP configuration (never committed, never sent to clients, never logged):
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, MAIL_FROM,
//   SMTP_SECURE=true for port 465.
//
// Application code calls sendMail({ to, subject, text, html, kind }) and
// never touches transport details. Content comes from emailTemplates.js.
function mode() {
  return (process.env.MAIL_MODE || 'log').toLowerCase();
}

function fromAddress() {
  return process.env.MAIL_FROM || 'Trycord <no-reply@localhost>';
}

// Authoritative config load + validation. Throws plain-English errors that
// never include secret values. Unknown modes fall back to log (safe).
function mailConfig() {
  const m = mode();
  if (m !== 'smtp') return { mode: 'log', from: fromAddress() };
  const host = (process.env.SMTP_HOST || '').trim();
  if (!host) {
    throw new Error('MAIL_MODE=smtp but SMTP_HOST is not configured');
  }
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error('SMTP_PORT is not a valid port number');
  }
  return {
    mode: 'smtp',
    from: fromAddress(),
    smtp: {
      host,
      port,
      secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465,
      user: (process.env.SMTP_USER || '').trim() || null,
      hasPassword: !!(process.env.SMTP_PASSWORD || ''),
    },
  };
}

// Safe public description for diagnostics (/api/instance features) and
// tests. Never includes passwords, usernames, or hostnames beyond the
// boolean readiness the instance endpoint already exposes.
function describe() {
  const m = mode();
  if (m !== 'smtp') return { mode: 'log', ready: true };
  try {
    mailConfig();
    return { mode: 'smtp', ready: true };
  } catch {
    return { mode: 'smtp', ready: false };
  }
}

let smtpTransport = null;
function smtp() {
  if (smtpTransport) return smtpTransport;
  const cfg = mailConfig();
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const nodemailer = require('nodemailer');
  // The mailer stays lazily loaded so installs without nodemailer still
  // boot in log mode; smtp mode is the only path that requires it.
  smtpTransport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: process.env.SMTP_PASSWORD || '' } : undefined,
  });
  return smtpTransport;
}

async function sendMail({ to, subject, text, html, kind }) {
  if (!to) throw new Error('mail recipient required');
  const label = kind || 'transactional';
  if (mode() !== 'smtp') {
    // Log mode intentionally shows development content (never used in
    // production). No transport, no credentials involved.
    console.log(`[mail] captured (MAIL_MODE=log, not delivered) kind=${label} to=${to} subject=${subject}`);
    console.log(`[mail] body: ${text}`);
    return { delivered: false, captured: true };
  }
  const cfg = mailConfig();
  try {
    await smtp().sendMail({ from: cfg.from, to, subject, text, html });
  } catch (e) {
    // Safe failure record: category + host only. Passwords, usernames,
    // tokens and message bodies never reach production logs.
    const code = (e && (e.code || e.responseCode)) || 'transport_error';
    console.log(`[mail] failed kind=${label} to=${to} host=${cfg.smtp.host} error=${code}`);
    throw new Error('email delivery failed');
  }
  console.log(`[mail] sent kind=${label} to=${to}`);
  return { delivered: true, captured: false };
}

// Base URL of the Trycord CLIENT APP, used for links inside emails
// (verification, password reset). The client uses hash routing, so links
// are built as `${clientUrl}/#/path/<token>` with the `#` kept literal —
// never encode the whole URL (that turns `#` into `%23` and breaks the
// fragment). Only the token itself is component-encoded.
//
// Precedence: explicit CLIENT_URL first (production points it at the
// hosted app, e.g. https://trycord.dev/trycord-client/index.html), then
// the legacy PUBLIC_URL/TRYCORD_PUBLIC_URL (self-hosted setups where the
// server root serves the client), then localhost.
function clientUrl() {
  const raw = (process.env.CLIENT_URL || process.env.PUBLIC_URL || process.env.TRYCORD_PUBLIC_URL || 'http://localhost:9971').trim();
  return raw.replace(/\/+$/, '');
}

// Email deep link into the client. The fragment MUST stay a literal `#`
// so the client's hash router receives the route; only the token is
// encoded (hex tokens pass through unchanged). A base ending in a file
// (…/index.html) joins directly; a bare host gets the `/` separator.
function clientLink(path, token) {
  const base = clientUrl();
  const frag = '#/' + String(path).replace(/^\/+/, '') + '/' + encodeURIComponent(String(token));
  const sep = /\.(html?|php|aspx?)$/i.test(base) ? '' : '/';
  return base + sep + frag;
}

module.exports = { sendMail, clientUrl, clientLink, mode, mailConfig, describe };

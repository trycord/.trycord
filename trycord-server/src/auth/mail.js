// Mail abstraction: one interface, swappable delivery.
//   MAIL_MODE=log   (default) capture messages to the server log. Safe for
//                   development; nothing is actually delivered.
//   MAIL_MODE=smtp  deliver through the configured SMTP relay.
//
// SMTP configuration (never committed, never sent to clients):
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, MAIL_FROM,
//   SMTP_SECURE=true for port 465.
// The mailer is loaded lazily so installs without nodemailer still boot
// in log mode.
function mode() {
  return (process.env.MAIL_MODE || 'log').toLowerCase();
}

function fromAddress() {
  return process.env.MAIL_FROM || 'Trycord <no-reply@localhost>';
}

let smtpTransport = null;
function smtp() {
  if (smtpTransport) return smtpTransport;
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const nodemailer = require('nodemailer');
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  smtpTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' } : undefined,
  });
  return smtpTransport;
}

async function sendMail({ to, subject, text }) {
  if (!to) throw new Error('mail recipient required');
  if (mode() !== 'smtp') {
    console.log(`[mail] captured (MAIL_MODE=log, not delivered) to=${to} subject=${subject}`);
    console.log(`[mail] body: ${text}`);
    return { delivered: false, captured: true };
  }
  if (!process.env.SMTP_HOST) {
    throw new Error('SMTP_HOST is not configured');
  }
  await smtp().sendMail({ from: fromAddress(), to, subject, text });
  return { delivered: true, captured: false };
}

function publicUrl() {
  const raw = (process.env.PUBLIC_URL || process.env.TRYCORD_PUBLIC_URL || 'http://localhost:9971').trim();
  return raw.replace(/\/+$/, '');
}

module.exports = { sendMail, publicUrl, mode };

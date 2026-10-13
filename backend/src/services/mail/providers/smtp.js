// SMTP delivery.
//
// The mode an installation used before the provider registry existed. It behaves
// as it always has, so an existing MAIL_MODE=smtp deployment keeps working
// unchanged: same host, port, credentials, STARTTLS handling and 465 implicit
// TLS, read from the settings store so the dashboard can change them live.
//
// What is new is that configuration reaches this file through the service
// rather than from process.env directly, which is what lets the dashboard supply
// values the environment does not and what lets the settings store own
// precedence. An environment value still wins, because that is the rule the rest
// of the configuration centre follows.
'use strict';

function normalizeHost(value) {
  return String(value || '').trim().replace(/^smtp:\/\//i, '').replace(/\/+$/, '');
}

module.exports = {
  id: 'smtp',
  label: 'SMTP relay',
  summary: 'Deliver through a mail relay over SMTP. Works with any provider that offers SMTP access.',

  settings: [
    { key: 'mail.smtpHost', env: 'SMTP_HOST', label: 'Host', placeholder: 'smtp.example.com' },
    { key: 'mail.smtpPort', env: 'SMTP_PORT', label: 'Port', placeholder: '587' },
    { key: 'mail.smtpUser', env: 'SMTP_USER', label: 'Username', placeholder: 'apikey' },
    { key: 'mail.smtpPassword', env: 'SMTP_PASSWORD', label: 'Password', secret: true, placeholder: 'the relay password or API key' },
    { key: 'mail.smtpSecure', env: 'SMTP_SECURE', label: 'Implicit TLS', type: 'boolean' },
    { key: 'mail.smtpRejectUnauthorized', env: 'SMTP_REJECT_UNAUTHORIZED', label: 'Verify the relay certificate', type: 'boolean' },
  ],

  secrets: ['mail.smtpPassword'],

  defaults: { 'mail.smtpPort': 587, 'mail.smtpSecure': false, 'mail.smtpRejectUnauthorized': true },

  // No network here. A misconfigured relay is refused at save time with a
  // readable message, and checkConnection() is where it is actually reached.
  validateConfig(cfg) {
    const problems = [];
    const host = normalizeHost(cfg.get('mail.smtpHost'));
    if (!host) problems.push('an SMTP host is required');

    const port = Number(cfg.get('mail.smtpPort'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('the SMTP port must be between 1 and 65535');

    const user = String(cfg.get('mail.smtpUser') || '').trim();
    if (user && !cfg.getSecret('mail.smtpPassword')) {
      problems.push('a username was given but no password is set');
    }
    return { ok: problems.length === 0, problems };
  },

  async sendMessage(cfg, message) {
    const host = normalizeHost(cfg.get('mail.smtpHost'));
    const port = Number(cfg.get('mail.smtpPort'));
    const user = String(cfg.get('mail.smtpUser') || '').trim();
    const password = cfg.getSecret('mail.smtpPassword');
    const secure = cfg.get('mail.smtpSecure') === true || port === 465;
    // Verifying the relay certificate is the default. Turning it off is allowed
    // for a self-signed relay on a private network and has to be a decision an
    // administrator makes explicitly, because it is the one setting here that
    // removes a protection against interception.
    const rejectUnauthorized = cfg.get('mail.smtpRejectUnauthorized') !== false;

    let nodemailer;
    try {
      // eslint-disable-next-line global-require
      nodemailer = require('nodemailer');
    } catch {
      throw new Error('SMTP delivery needs the nodemailer package, which is not installed');
    }

    const transport = nodemailer.createTransport({
      host,
      port,
      secure,
      tls: { rejectUnauthorized },
      auth: user ? { user, pass: password || '' } : undefined,
    });

    const info = await transport.sendMail({
      from: cfg.from(),
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });

    return { delivered: true, id: (info && info.messageId) || null };
  },

  // Reaches the relay for real. A transport check only proves the socket opens
  // and the credentials are accepted, which is as much as SMTP lets us verify
  // without sending.
  async checkConnection(cfg) {
    const v = this.validateConfig(cfg);
    if (!v.ok) return { ok: false, detail: v.problems.join('; ') };

    const host = normalizeHost(cfg.get('mail.smtpHost'));
    const port = Number(cfg.get('mail.smtpPort'));
    const user = String(cfg.get('mail.smtpUser') || '').trim();

    const nodemailer = require('nodemailer');
    const secure = cfg.get('mail.smtpSecure') === true || port === 465;
    const transport = nodemailer.createTransport({
      host,
      port,
      secure,
      tls: { rejectUnauthorized: cfg.get('mail.smtpRejectUnauthorized') !== false },
      auth: user ? { user, pass: cfg.getSecret('mail.smtpPassword') || '' } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });

    try {
      await transport.verify();
      return { ok: true, detail: 'The relay answered and the credentials were accepted' };
    } catch (e) {
      const code = (e && (e.code || e.responseCode)) || 'transport_error';
      return { ok: false, detail: 'The relay refused the connection (' + code + ')' };
    }
  },
};

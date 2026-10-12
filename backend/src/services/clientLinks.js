// Links that go inside email.
//
// Split out of the mail module because they are about where the client lives,
// not about how a message is delivered: a password reset link is built the same
// way whether it travels over SMTP or an HTTP API.
//
// Base URL of the Trycord client application, used for the verification and
// recovery links. Precedence: CLIENT_URL first, because that is what a hosted
// app sets, then the public URL, then localhost for a development instance.
//
// A deep link is an ordinary path, not a hash route. The client has a path
// router, so `#/verify-email/<token>` only worked because a translation step on
// arrival converted it - a step nothing documented on the sending side. A base
// ending in a file joins directly; a bare host gets the separator.
'use strict';

function clientUrl() {
  const raw = String(
    process.env.CLIENT_URL || process.env.PUBLIC_URL || process.env.TRYCORD_PUBLIC_URL || 'http://localhost:9971'
  ).trim();
  return raw.replace(/\/+$/, '');
}

function clientLink(path, token) {
  const base = clientUrl();
  const route = String(path).replace(/^\/+/, '') + '/' + encodeURIComponent(String(token));
  const separator = /\.(html?|php|aspx?)$/i.test(base) ? '' : '/';
  return base + separator + route;
}

module.exports = { clientUrl, clientLink };

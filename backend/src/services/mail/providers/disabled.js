// Mail delivery turned off.
//
// An operator picks this when the instance should not send mail at all: a
// development install, an air-gapped network, or a deployment where mail is
// handled by something outside the application.
//
// The one thing this mode must never do is report success. A password reset or a
// verification mail that returns ok while nothing was delivered leaves somebody
// locked out of their account believing a message is on its way. So send()
// throws, and the caller records the failure. Recovery flows already treat a
// failed send as a generic response rather than telling the requester whether
// their account exists, so a disabled instance degrades to "the request was
// accepted but nothing was sent", which is accurate.
//
// It also never writes the message to the log. The previous log mode did, which
// put password reset links in the server log in cleartext; on an instance that
// has explicitly chosen not to deliver mail there is no reason to retain them.
'use strict';

module.exports = {
  id: 'disabled',
  label: 'Disabled',
  summary: 'Send nothing. Email-dependent flows refuse rather than pretending to work.',

  settings: [],

  secrets: [],

  defaults: {},

  validateConfig() {
    return { ok: true, problems: [] };
  },

  async sendMessage() {
    throw new Error('mail delivery is disabled on this instance');
  },

  async checkConnection() {
    // Nothing to check, and saying "ok" here would be a claim about a transport
    // that does not exist.
    return { ok: true, detail: 'mail delivery is disabled, so there is nothing to reach', delivers: false };
  },
};

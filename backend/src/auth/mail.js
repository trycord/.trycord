// Kept so the four existing call sites do not all have to move at once.
//
// The implementation is services/mail, which resolves a provider through the
// registry. This file is a re-export and nothing else: it holds no configuration
// of its own, so there is one place where mail behaviour is decided.
//
// New code should require services/mail directly. When the last caller moves,
// this goes.
'use strict';

const mail = require('../services/mail');

module.exports = {
  sendMail: mail.send,
  clientUrl: mail.clientUrl,
  clientLink: mail.clientLink,
  mode: mail.mode,
  describe: mail.describe,
};

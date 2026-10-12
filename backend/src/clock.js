// Ids, timestamps, and the signing secret.
//
// These were in util.js, which put every module that stamps a row one require
// away from the module that signs a token. That produced a cycle: services/
// settings.js needs a timestamp, util.js needs the settings store to read a
// session lifetime, and one of the two was going to get a half-built exports
// object depending on which file Node happened to reach first. It happened to
// work because server.js loads settings before util, which is not a thing to
// leave to load order.
//
// secret() moved here for the same reason from the other side. It is three
// lines - read JWT_SECRET, refuse if it is absent, hand it back - and it needs
// no database, no settings store and no jwt, so every module that needs it can
// have it without an edge back into the tree.
//
// Node's built-ins are used rather than a clock of our own, so these are the
// same values the database would produce for itself.

const crypto = require('crypto');

const now = () => new Date().toISOString();

const uuid = () => crypto.randomUUID();

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is required. Set it in the environment or .env (see .env.example).');
  return s;
}

module.exports = { now, uuid, secret };

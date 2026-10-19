// Where this instance is allowed to reach out to.
//
// Continuum cannot become an SSRF vector: a remote instance URL is
// attacker-controlled (even when an administrator adds it, the value is
// copy-pasted and may be a stale or deceptive link), so every URL is
// revalidated at use time against the destination address that the HTTP
// client resolves.
//
// The rules themselves live in one place (services/netguard.js) so the
// federation probe, the delivery path and the discovery reader cannot drift
// apart. This module only decides when local addresses are permitted, and it
// is the only place that answers that.

const netguard = require('../netguard');

function allowLocalhost() {
  const value = String(process.env.CONTINUUM_ALLOW_LOCALHOST || '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

function forbiddenHost(host) {
  return netguard.forbiddenHost(host, { allowLocalhost: allowLocalhost() });
}

// Plain http is still accepted for a peer, because a self-hosted instance on
// a private network is a legitimate setup and refusing it would break one
// that works today; the private-range rules are unchanged.
async function validateOrigin(origin) {
  return netguard.validateOrigin(origin, {
    allowLocalhost: allowLocalhost(),
    allowInsecure: true,
  });
}

async function resolvesToPrivate(host) {
  return netguard.resolvesToPrivate(host, { allowLocalhost: allowLocalhost() });
}

module.exports = { allowLocalhost, forbiddenHost, validateOrigin, resolvesToPrivate };

// The address the voice relay is published at.
//
// One place, so the two that need it cannot disagree: the configuration
// that hands the ICE servers to a client, and the relay that answers the
// binding requests. A relay published at one address and a client given
// another is a call that cannot be made, and it looks like a network
// problem.
//
// The order is:
//
//   the voice address   TRYCORD_VOICE_PUBLIC_URL, or the instance's own
//                       setting, which is the address the operator gives
//                       the voice stack - a hostname that points straight
//                       at this instance, DNS only and not proxied;
//   the named address   TRYCORD_TURN_HOST, when the operator named one;
//   the instance        TRYCORD_PUBLIC_URL, which is usually the address
//                       of a proxy that terminates TLS.
//
// The last one is last on purpose. A proxy carries HTTP and not the
// arbitrary UDP a TURN service needs, so a relay published at the site's
// address is a relay nobody can reach - and the instance says so in its
// diagnostics rather than handing out an address that cannot work.

'use strict';

const WILDCARDS = ['0.0.0.0', '::', '[::]'];

/**
 * The address the relay is published at.
 *
 * `family` is 4 or 6. An instance that has an IPv6 address and an IPv4 one
 * publishes both, because a client on one network cannot reach the other's
 * address: a relay published at an IPv6 address is not reachable by a client
 * that has no IPv6 route, and the other way round.
 *
 * @param {number} [family]
 * @returns {string}
 */
function publicHost(family) {
  // No family asked for means the primary address, whatever its family is.
  const wanted = family === 4 || family === 6 ? family : 0;
  //
  // The saved value comes first and the environment second, which is the
  // order every other setting follows: once a value is saved, a restart
  // cannot quietly undo it. The environment is the fallback for a process
  // that has not read the database, and it is the seed for a setting that
  // has never been saved.
  const voiceUrl = String(
    readSetting('voice.mesh.publicUrl', process.env.TRYCORD_VOICE_PUBLIC_URL || '')
    || readSetting('voice.publicUrl', '')
    || '',
  ).trim();
  const voiceHost = voiceUrl ? hostOf(voiceUrl) : '';
  if (voiceHost) {
    if (!wanted || familyOf(voiceHost) === wanted) return voiceHost;
    // The voice address is of the other family, so the address of this one
    // is looked for.
    const other = String(
      process.env.TRYCORD_VOICE_PUBLIC_URL_V4 || process.env.TRYCORD_VOICE_PUBLIC_URL_V6 || '',
    ).trim();
    if (other) {
      const host = hostOf(other);
      if (host && familyOf(host) === wanted) return host;
    }
    // Nothing of this family is published, and an address of the other family
    // is worse than none: a client given an address it cannot route to
    // waits for it to time out, where a client given none says so at once.
    return '';
  }

  const named = String(process.env.TRYCORD_TURN_HOST || '').trim();
  if (named && WILDCARDS.indexOf(named) === -1) return named;

  const publicUrl = String(process.env.TRYCORD_PUBLIC_URL || '').trim();
  if (publicUrl) {
    const host = hostOf(publicUrl);
    if (host) return host;
  }
  return named || '127.0.0.1';
}

// Whether an address is of the IPv4 family or the IPv6 one.
function familyOf(address) {
  const text = String(address || '').trim();
  if (!text) return 0;
  return text.indexOf(':') === -1 ? 4 : 6;
}

/**
 * Whether an address a client is given can be reached from outside this
 * instance.
 *
 * The loopback is the address that cannot: a browser resolves it to the
 * reader's own machine, so a call can never be relayed through it. A
 * wildcard is not an address at all, and a private address is one that only
 * a machine on the same network can reach.
 *
 * @param {string} address
 * @returns {boolean}
 */
function addressIsReachable(address) {
  const text = String(address || '').trim().toLowerCase();
  if (!text) return false;
  if (WILDCARDS.indexOf(text) !== -1) return false;
  if (text === '127.0.0.1' || text === 'localhost' || text === '[::1]') return false;
  if (text.startsWith('127.')) return false;
  if (text.startsWith('10.') || text.startsWith('192.168.')) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(text)) return false;
  if (text.startsWith('fe80:')) return false;
  if (text.startsWith('fd') && text.includes(':')) return false;
  return true;
}

// The hostname of an address, or nothing when it is not one.
function hostOf(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    // A bare address is not a URL, so it is given a scheme to be read.
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text).hostname;
  } catch {
    return '';
  }
}

// The instance's own saved address, read lazily.
//
// The settings are read inside the function and not at the top, because the
// settings service and the voice configuration require each other in places
// and a cycle at load time is a failure to start.
//
// The path is the settings service in the parent directory. It used to ask for
// './settings', which is this directory, where there is no such file - and
// the catch swallowed the error, so the saved address was never read and the
// relay was published at an address nobody had chosen. A wrong path that fails
// quietly is worse than no path at all: the setting was in the console, it
// saved, and it did nothing.
function readSetting(key, fallback) {
  try {
    const settings = require('../settings');
    const value = settings.read(key, fallback);
    return value === undefined || value === null ? fallback : value;
  } catch (e) {
    console.warn('[voice] the saved address could not be read: ' + (e && e.message ? e.message : e));
    return fallback;
  }
}

module.exports = { publicHost, addressIsReachable, familyOf };

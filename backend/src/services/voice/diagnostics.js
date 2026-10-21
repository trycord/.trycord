// The voice diagnostics.
//
// One answer for every provider: what state it is in, what is missing, and
// whether the other end answered. The console renders this and nothing else,
// so the operator is never told a provider is working because its form was
// filled in.
//
// The state of a provider is decided in one place, and the runtime asks the
// same place for its refusal. A provider that is selected but incomplete is
// refused with the list of what is missing, and the diagnostics show that same
// list - an operator is told one thing in both places.

'use strict';

const config = require('./config');
const registry = require('./registry');
const settings = require('../settings');

// How long a check is trusted. A check reaches out to another machine, so it
// is not repeated on every read of the console, but it is repeated often
// enough that a provider which has come back is noticed.
const CACHE_MS = 30000;

const checks = new Map();

function cachedCheck(providerId) {
  const entry = checks.get(providerId);
  if (!entry) return null;
  return entry;
}

function isStale(entry) {
  return !entry || Date.now() - entry.at > CACHE_MS;
}

// Run a provider's check, and remember the answer.
//
// A check that is asked for again within the cache window returns what was
// found, unless the caller insists on a fresh one - which is what the
// console's Test connection button does.
async function runCheck(providerId, options) {
  const opts = options || {};
  const provider = String(providerId || '').trim().toLowerCase();
  const entry = cachedCheck(provider);
  if (!opts.force && entry && !isStale(entry)) return entry;

  const result = await registry.check(provider, opts.overlay);
  const stored = {
    at: Date.now(),
    ok: !!result.ok,
    detail: result.detail || '',
    results: result.results || null,
  };
  checks.set(provider, stored);
  return stored;
}

// The refusal a provider that cannot carry a session is given.
//
// It names what is missing, in the same words the diagnostics use, so an
// administrator sees one answer wherever they look.
function refusalOf(providerId, overlay) {
  const missing = config.missing(providerId, overlay);
  if (!missing.length) return null;
  return {
    code: 'VOICE_NOT_CONFIGURED',
    message: 'Voice and video cannot start on the ' + labelOf(providerId) + ' provider: '
      + missing.join('; ') + '.',
    problems: missing,
    status: 503,
  };
}

function labelOf(providerId) {
  const provider = registry.find(providerId);
  return provider ? provider.label : String(providerId || '');
}

// The state of one provider.
function stateOf(providerId, check) {
  const enabled = !!settings.read('voice.enabled', false);
  if (!enabled) return 'disabled';

  const inForce = config.selected() === providerId;
  if (!inForce) return 'configured';

  if (config.missing(providerId).length) return 'failed';
  if (!check) return 'configured';
  return check.ok ? 'active' : 'degraded';
}

// The whole picture: the provider in force, the shared controls, and every
// provider with its own state.
//
// The provider in force is checked afresh when its last answer has gone cold;
// the others keep the answer they have, because checking a provider that is
// not in force reaches out to a server nobody is using.
async function report(options) {
  const opts = options || {};
  const enabled = !!settings.read('voice.enabled', false);
  const active = config.selected();

  const providers = [];
  for (const provider of registry.PROVIDERS) {
    const described = registry.describe(provider.id);
    let check = cachedCheck(provider.id);
    if (enabled && provider.id === active && (opts.force || isStale(check))) {
      check = await runCheck(provider.id, { force: true });
    }

    providers.push({
      id: provider.id,
      label: provider.label,
      summary: provider.summary,
      note: provider.note,
      inForce: provider.id === active,
      state: stateOf(provider.id, check),
      missing: described.missing,
      problems: described.missing,
      fields: described.fields,
      secrets: described.secrets,
      maxParticipants: described.maxParticipants,
      check: check ? { ok: check.ok, detail: check.detail, at: check.at } : null,
    });
  }

  const inForce = providers.find((provider) => provider.id === active) || null;

  return {
    enabled,
    active,
    screenSharing: !!settings.read('voice.screenSharing', true),
    stageChannels: !!settings.read('voice.stageChannels', true),
    // The instance's own STUN and TURN stack.
    //
    // It is in the report because the console has to report reality: an
    // operator looking at the mesh needs to see where the relay is published
    // and whether a client can reach it there, and a report that left that
    // out made a working relay look like a broken one - and a relay published
    // at the loopback look like a working one.
    stack: registry.stackState(),
    // The participant limit is shared in meaning and per-provider in value:
    // the number here is the one the provider in force enforces.
    maxParticipants: inForce ? inForce.maxParticipants : config.limit(active),
    providers,
  };
}

// Forget what a check found, so the next read asks again.
//
// A save changes what a provider is made of, so the answer that was true
// before it is not true after it.
function invalidate() {
  checks.clear();
}

module.exports = { report, runCheck, refusalOf, invalidate, CACHE_MS };

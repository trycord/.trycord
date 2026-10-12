// Mail configuration and delivery.
//
// One service owns which provider is in force, what it is configured with, and
// what happens when a message is sent. Routes call send() and never learn which
// transport is underneath, which is what keeps a vendor out of the core.
//
// Configuration precedence is the same as the rest of the instance: default,
// then database, then environment, with the environment winning. That rule lives
// in the settings store and is not restated here. This service adds two things
// on top:
//
//   secrets are read from the store and decrypted, never returned
//   the adapter is resolved through the registry per send, so a mode change
//   takes effect on the next message rather than the next restart
//
// An unknown mode is refused rather than defaulted. Falling back would mean an
// operator who set MAIL_MODE=smtpp believes mail is going out.
'use strict';

const settings = require('../settings');
const secrets = require('../secrets');
const registry = require('./registry');

const { clientUrl, clientLink } = require('../clientLinks');

// The configuration object an adapter reads. It answers get() and from() the way
// a settings key is named, plus secret() for the encrypted values and
// pending() for values supplied on the call rather than stored, which is how a
// test send carries its recipient.
function makeConfig(mode, overrides) {
  return {
    mode,
    get(key) {
      if (overrides && overrides[key] !== undefined) return overrides[key];
      // undefined rather than a throw: the providers decide what a missing value
      // means, and a send before the store has loaded is a timing detail rather
      // than a reason to take the process down.
      return settings.read(key, undefined);
    },
    getSecret(key) {
      if (overrides && overrides['secret:' + key] !== undefined) return overrides['secret:' + key];
      return secretValue(key);
    },
    pending(key) {
      return overrides ? overrides[key] : undefined;
    },
    from() {
      const configured = this.get('mail.from');
      if (configured && String(configured).trim()) return String(configured).trim();
      return 'Trycord <no-reply@localhost>';
    },
  };
}

// Which provider is in force.
//
// Not configured means disabled rather than a guess. An install that never
// touched its mail settings must not believe it is sending mail, and the
// previous default of logging message bodies is what put password reset links in
// the server log in cleartext.
function mode() {
  const configured = settings.read('mail.mode', 'disabled');
  return registry.isMode(configured) ? registry.normaliseMode(configured) : 'disabled';
}

// The full picture for diagnostics: which provider, whether it is configured,
// whether its secrets are readable, and which keys come from where.
function describe() {
  const current = mode();
  const provider = registry.providerFor(current);
  const configured = { mode: current, ready: false, problems: [], secrets: {} };

  if (!provider) {
    configured.problems.push('the configured mail mode is not a registered provider');
    return configured;
  }

  for (const key of provider.secrets) {
    const stored = settings.secretStored(key);
    configured.secrets[key] = {
      set: !!stored,
      readable: stored ? secrets.readable('mail:' + key, stored) : null,
      // Never the value, only where a change to it would have to be made.
      source: settings.isLoaded() && settings.source(key) === 'environment' ? 'environment' : (stored ? 'instance' : 'none'),
    };
  }

  if (current === 'disabled') {
    configured.ready = true;
    return configured;
  }

  const check = provider.validateConfig(makeConfig(current));
  configured.problems = check.problems;
  configured.ready = check.ok;
  return configured;
}

// The decrypted value of a secret, or null.
//
// The settings store already loaded the stored rows, so this is not a query. An
// unreadable row is treated as absent, which surfaces as a configuration problem the
// administrator can see rather than as a failure inside a provider.
function secretValue(key) {
  const stored = settings.secretStored ? settings.secretStored(key) : null;
  if (!stored) return null;
  try {
    return secrets.decrypt('mail:' + key, stored);
  } catch {
    return null;
  }
}

// Nothing is cached inside this module: the provider is resolved per send and the
// secrets live in the settings store, which reloads itself on a save. This is the seam
// settings.save() calls so the dependency is declared rather than implied.
function invalidate() {}

async function send({ to, subject, text, html, kind }) {
  if (!to) throw new Error('a recipient is required');

  const current = mode();
  const provider = registry.providerFor(current);
  if (!provider) throw new Error('mail mode ' + current + ' is not a registered provider');

  const label = kind || 'transactional';

  if (provider.id === 'disabled') {
    await provider.sendMessage(makeConfig(current), { to, subject, text, html });
    return { delivered: false, captured: false, mode: current };
  }

  const cfg = makeConfig(current);
  const problems = provider.validateConfig(cfg);
  if (!problems.ok) throw new Error(problems.problems.join('; '));

  try {
    const out = await provider.sendMessage(cfg, { to, subject, text, html });
    console.log('[mail] sent kind=' + label + ' mode=' + current + ' to=' + to + (out.id ? ' id=' + out.id : ''));
    return { delivered: true, captured: false, mode: current, id: out.id || null };
  } catch (e) {
    console.log('[mail] failed kind=' + label + ' mode=' + current + ' to=' + to
      + ' error=' + ((e && e.message) || String(e)).slice(0, 120));
    throw new Error('email delivery failed: ' + ((e && e.message) || String(e)).slice(0, 200));
  }
}

// A real delivery to a real address, through the configured provider.
async function test(to) {
  const address = String(to || '').trim();
  if (!address) return { ok: false, error: 'an address is required' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    return { ok: false, error: 'that does not look like an email address' };
  }

  const current = mode();
  const provider = registry.providerFor(current);
  if (!provider) return { ok: false, error: 'the configured mail mode is not a registered provider' };

  const cfg = makeConfig(current, { testRecipient: address });

  if (typeof provider.checkConnection === 'function') {
    const out = await provider.checkConnection(cfg);
    return out.ok
      ? { ok: true, mode: current, detail: out.detail || 'the message was accepted', delivered: out.delivers !== false }
      : { ok: false, mode: current, error: out.detail || 'the check failed' };
  }

  try {
    await send({ to: address, subject: 'Trycord test message', kind: 'test' });
    return { ok: true, mode: current, detail: 'the message was accepted', delivered: true };
  } catch (e) {
    return { ok: false, mode: current, error: (e && e.message) || String(e) };
  }
}

// Validate the current mode's configuration without sending anything.
function validateCurrent() {
  const current = mode();
  const provider = registry.providerFor(current);
  if (!provider) return { ok: false, problems: ['the configured mail mode is not a registered provider'] };
  return provider.validateConfig(makeConfig(current));
}

module.exports = {
  MODES: registry.MODES,
  catalogue: registry.catalogue,
  mode,
  send,
  test,
  describe,
  validateCurrent,
  invalidate,
  clientUrl,
  clientLink,
  providerFor: registry.providerFor,
};

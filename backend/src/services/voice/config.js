// The effective voice configuration.
//
// Each provider keeps its own settings. Only a few older values still migrate;
// the Mesh now always uses the relay this instance runs.
//
// Three rules make that work:
//
//   1. A provider's own key wins. An older key is a fallback, never a second
//      source of truth.
//   2. A fallback is read only while the newer key has never been saved. The
//      first save of a provider's configuration writes the new key, and the
//      fallback stops applying from that moment on.
//   3. A secret never leaves this module in a form a client could use. The
//      configuration says whether a secret is set; the value itself is read
//      only by the code that has to authenticate with it.
//
// The remaining fallbacks keep Cloudflare credentials and the old room limit
// working without making one setting a second source of truth.

'use strict';

const settings = require('../settings');
const turn = require('../turn');

// The providers, and the settings each one owns.
//
// `settings` and `secrets` are the names inside the provider's own group;
// `legacy` names the setting each of them replaces.
const GROUPS = {
  mesh: {
    prefix: 'voice.mesh.',
    // The relay's own settings: the port it listens on, the address it
    // binds, the realm its credentials are issued in, and the key they are
    // minted under. They belong to the mesh and to nothing else, because the
    // mesh is the only provider that runs a relay of its own.
    settings: ['maxParticipants', 'publicUrl', 'turnPort', 'turnHost', 'turnRealm'],
    secrets: ['stunkey'],
    legacy: {
      maxParticipants: 'voice.maxParticipants',
      publicUrl: 'voice.publicUrl',
    },
  },
  cloudflare: {
    prefix: 'voice.cloudflare.',
    settings: ['appId', 'endpoint', 'maxParticipants'],
    secrets: ['appSecret'],
    legacy: {
      appId: 'voice.sfuAppId',
      appSecret: 'voice.sfuAppSecret',
    },
  },
  sfu: {
    prefix: 'voice.sfu.',
    settings: ['endpoint', 'stunUrls', 'turnUrl', 'turnUsername', 'maxParticipants'],
    secrets: ['token', 'turnCredential'],
    legacy: {},
  },
};

// How many people a provider's room holds when nothing says otherwise.
//
// The mesh is small on purpose: the media travels between every participant,
// so the traffic a room produces grows with the square of its size.
const DEFAULT_LIMITS = {
  mesh: 6,
  cloudflare: 25,
  sfu: 25,
};

const PROVIDERS = Object.keys(GROUPS);

function isProvider(id) {
  return PROVIDERS.indexOf(String(id || '').trim().toLowerCase()) !== -1;
}

function groupOf(providerId) {
  return GROUPS[String(providerId || '').trim().toLowerCase()] || null;
}

// The provider this instance is configured to use.
function selected() {
  const raw = String(settings.read('voice.provider', 'mesh')).trim().toLowerCase();
  return isProvider(raw) ? raw : 'mesh';
}

// The setting key a name in a provider's group has.
function keyOf(providerId, name) {
  const group = groupOf(providerId);
  return group ? group.prefix + name : null;
}

// Whether a setting has ever been set, as opposed to carrying its default.
//
// The store knows this: a value that came from the database or the
// environment has a source, and a value that was never set has the source
// 'default'.
function wasSet(key) {
  if (!settings.isLoaded()) return false;
  return settings.source(key) !== 'default';
}

function has(overlay, key) {
  return !!overlay && Object.prototype.hasOwnProperty.call(overlay, key);
}

// One setting of one provider, with the place its value came from.
//
// The source is what the console shows next to the field: 'instance' for a
// value an administrator saved, 'environment' for one the deployment set, and
// 'legacy:<key>' for one that is still coming from the setting it replaced.
function value(providerId, name, overlay) {
  const key = keyOf(providerId, name);
  const group = groupOf(providerId);
  if (!key || !group) return { key: null, value: null, source: 'unknown' };

  if (has(overlay, key)) {
    const pending = overlay[key];
    return {
      key,
      value: pending === null ? null : pending,
      source: 'pending',
      legacy: null,
    };
  }

  if (wasSet(key)) {
    return { key, value: settings.read(key, null), source: settings.source(key), legacy: null };
  }

  const legacyKey = group.legacy[name];
  if (legacyKey && wasSet(legacyKey)) {
    return {
      key,
      value: settings.read(legacyKey, null),
      source: 'legacy',
      legacy: legacyKey,
    };
  }

  return { key, value: settings.read(key, null), source: 'default', legacy: null };
}

// One secret of one provider.
//
// The value is here because the runtime has to authenticate with it, but it is
// never returned from the console-facing functions: `secretState` says only
// whether one is set.
function secret(providerId, name, overlay) {
  const key = keyOf(providerId, name);
  const group = groupOf(providerId);
  if (!key || !group) return { key: null, value: '', set: false, source: 'unknown', legacy: null };

  if (has(overlay, key)) {
    const pending = overlay[key];
    const text = pending === null || pending === undefined ? '' : String(pending).trim();
    return { key, value: text, set: !!text, source: 'pending', legacy: null };
  }

  if (wasSet(key)) {
    const stored = settings.secretValue(key);
    return { key, value: stored || '', set: !!stored, source: settings.source(key), legacy: null };
  }

  const legacyKey = group.legacy[name];
  if (legacyKey && wasSet(legacyKey)) {
    const stored = settings.secretValue(legacyKey);
    return {
      key,
      value: stored || '',
      set: !!stored,
      source: 'legacy',
      legacy: legacyKey,
    };
  }

  return { key, value: '', set: false, source: 'default', legacy: null };
}

// The in-house STUN and TURN server.
//
// The instance runs one itself (services/turn.js), so an operator should not
// have to write down the address of a server the instance already has. The
// address is the one the deployment configured; the realm and the secret come
// from the same place and never leave the process.
function inHouseRelay() {
  // The relay's own configuration.
  //
  // Read through the settings service, so a port an administrator saved is
  // the port the relay binds. Reading the environment directly, as this
  // used to, meant the console changed a number nobody read.
  const host = String(settings.read('voice.mesh.turnHost', process.env.TRYCORD_TURN_HOST || '::')).trim();
  const port = Number(settings.read('voice.mesh.turnPort', process.env.TRYCORD_TURN_PORT || 3478));
  const realm = String(settings.read('voice.mesh.turnRealm', process.env.TRYCORD_TURN_REALM || 'trycord-turn')).trim();
  const listenPort = Number.isFinite(port) && port > 0 ? port : 3478;

  // The addresses the clients are given.
  //
  // Both families, when the instance has both: a client with no IPv6 route
  // cannot reach an IPv6 address, and a client on an IPv6-only network
  // cannot reach an IPv4 one. The browser tries the list, so one list
  // carries both.
  const advertised = advertisedHost(host);
  const address = require('./address');
  const addresses = [];
  // The family the relay listens on comes first, so a client that can reach
  // it does not try the other one first.
  const listenFamily = host.indexOf(':') === -1 ? 4 : 6;
  for (const family of [listenFamily, listenFamily === 4 ? 6 : 4]) {
    const text = String(address.publicHost(family) || '').trim();
    if (!text || addresses.indexOf(text) !== -1) continue;
    addresses.push(text);
  }
  if (!addresses.length) addresses.push(advertised);
  const urls = addresses.map((address) => 'stun:' + address + ':' + listenPort);
  const turnUrls = addresses.map((address) => 'turn:' + address + ':' + listenPort);

  return {
    host,
    port: listenPort,
    realm,
    // The address a browser can reach. A wildcard listen address is not one,
    // so the instance's own public address is used when it knows one.
    advertised,
    // Every published address, and the family of each.
    addresses: addresses.map((address) => ({
      address,
      family: require('./address').familyOf(address),
    })),
    listenFamily,
    stunUrls: urls,
    turnUrls,
    stunUrl: urls[0] || '',
    turnUrl: turnUrls[0] || '',
  };
}

// The address the voice stack is published at.
//
// It is not always the address the site is published at.
//
// A site is usually served through a proxy, and a proxy that terminates TLS
// carries HTTP - not the arbitrary UDP a STUN or TURN service needs. An
// instance whose site is behind one is therefore publishing its relay at an
// address nobody can reach it on: the requests go to the proxy, and the
// proxy does not carry them to the instance.
//
// So the voice stack has an address of its own, and it is the one the relay
// is published at. The operator gives it a hostname that points straight at
// the instance - DNS only, not proxied - and the relay is reachable there.
//
// The order is the voice address, then the instance's own public address,
// then whatever the operator named.
function advertisedHost(host) {
  const plain = String(host || '').trim();
  if (plain && plain !== '0.0.0.0' && plain !== '::' && plain !== '[::]') return plain;

  // The shared address, so the relay and the ICE configuration a client is
  // given cannot disagree about it.
  //
  // When nothing is named the address is the loopback, which a browser
  // resolves to the reader's own machine - so the instance says so, plainly,
  // wherever the address is published, rather than handing out an address
  // that cannot work.
  return require('./address').publicHost();
}

// Whether an address a client is given can be reached from outside this
// instance.
//
// The loopback is the address that cannot: a browser resolves it to the
// reader's own machine. A wildcard is not an address at all.
function addressIsReachable(address) {
  return require('./address').addressIsReachable(address);
}

// The ICE servers one provider hands to a client.
//
// `credentials` decides whether the TURN credential travels with the list.
// The capability answer never carries it - that answer is fetched by every
// client, including ones that are not signed in - while the answer to a
// session that belongs to the caller does.
function iceServers(providerId, options) {
  const opts = options || {};
  const provider = String(providerId || selected()).trim().toLowerCase();
  const out = [];

  if (provider === 'mesh') {
    const relay = inHouseRelay();
    out.push({ urls: relay.stunUrls.length ? relay.stunUrls : relay.stunUrl });
    if (opts.credentials && opts.userId) {
      const minted = turn.issueCredentials(String(opts.userId));
      out.push({
        urls: relay.turnUrls.length ? relay.turnUrls : relay.turnUrl,
        username: minted.username,
        credential: minted.password,
      });
    } else {
      out.push({ urls: relay.turnUrls.length ? relay.turnUrls : relay.turnUrl });
    }
    return out;
  }

  if (provider === 'sfu') {
    const stun = value('sfu', 'stunUrls');
    for (const url of (Array.isArray(stun.value) ? stun.value : [])) out.push({ urls: url });
    const turnUrl = String(value('sfu', 'turnUrl').value || '');
    if (turnUrl) {
      const entry = { urls: turnUrl };
      if (opts.credentials) {
        const username = String(value('sfu', 'turnUsername').value || '');
        const credential = secret('sfu', 'turnCredential');
        if (username) entry.username = username;
        if (credential.set) entry.credential = credential.value;
      }
      out.push(entry);
    }
  }

  // The Cloudflare SFU carries the media itself and tells the browser which
  // candidates to use in its answer, so it has no ICE list of its own.
  return out;
}

// How many people a provider's room holds.
function limit(providerId, overlay) {
  const own = value(providerId, 'maxParticipants', overlay);
  const chosen = Number(own.value);
  if (Number.isFinite(chosen) && chosen > 0) return chosen;
  return DEFAULT_LIMITS[providerId] || 25;
}

// Everything one provider needs at runtime, resolved.
function configuration(providerId, overlay) {
  const provider = String(providerId || selected()).trim().toLowerCase();
  const group = groupOf(provider);
  if (!group) return null;

  const resolved = {};
  for (const name of group.settings) resolved[name] = value(provider, name, overlay);
  for (const name of group.secrets) resolved[name] = secret(provider, name, overlay);

  return {
    provider,
    maxParticipants: limit(provider, overlay),
    // The plain settings, by name, for the callers that read them.
    appId: resolved.appId ? String(resolved.appId.value || '') : '',
    endpoint: resolved.endpoint ? String(resolved.endpoint.value || '') : '',
    token: resolved.token ? resolved.token.value : '',
    stunUrls: resolved.stunUrls && Array.isArray(resolved.stunUrls.value) ? resolved.stunUrls.value : [],
    turnUrl: resolved.turnUrl ? String(resolved.turnUrl.value || '') : '',
    turnUsername: resolved.turnUsername ? String(resolved.turnUsername.value || '') : '',
    resolved,
  };
}

// The configuration of one provider, without any secret in it.
//
// This is what the capability answer and the console carry. A credential is
// reported as set or not set, and where it came from; its value is never
// here.
function publicConfiguration(providerId, overlay) {
  const provider = String(providerId || selected()).trim().toLowerCase();
  const group = groupOf(provider);
  const cfg = configuration(provider, overlay);
  if (!group || !cfg) return null;

  const secrets = group.secrets.map((name) => {
    const resolved = cfg.resolved[name];
    return {
      name,
      set: !!(resolved && resolved.set),
      source: resolved ? resolved.source : 'default',
    };
  });

  return {
    id: provider,
    maxParticipants: cfg.maxParticipants,
    appId: cfg.appId,
    endpoint: cfg.endpoint,
    stunUrls: cfg.stunUrls,
    turnUrl: cfg.turnUrl,
    turnUsername: cfg.turnUsername,
    // Whether a token is set, without the token.
    hasToken: !!(cfg.resolved.token && cfg.resolved.token.set),
    secrets,
  };
}

// What a provider is missing before it can carry a session.
//
// The list is the same list the diagnostics give and the same list a refusal
// names, so an operator is told one thing in three places.
function missing(providerId, overlay) {
  const provider = String(providerId || selected()).trim().toLowerCase();
  const config = configuration(provider, overlay);
  if (!config) return ['unknown provider'];

  const problems = [];

  if (provider === 'mesh') {
    // The mesh asks for no credentials and is never half-configured: with
    // nothing set it falls back to the STUN and TURN server this instance runs
    // itself, so there is always a way for the peers to find each other.
  }

  if (provider === 'cloudflare') {
    if (!config.appId) problems.push('the Cloudflare application id is not set');
    if (!config.resolved.appSecret.set) problems.push('the Cloudflare application secret is not set');
    if (!/^https?:\/\//i.test(config.endpoint)) problems.push('the Cloudflare endpoint is not a URL');
  }

  if (provider === 'sfu') {
    if (!config.endpoint) {
      problems.push('the media server endpoint is not set');
    } else if (!/^https?:\/\//i.test(config.endpoint)) {
      problems.push('the media server endpoint is not a URL');
    }
  }

  return problems;
}

// The console's view of one provider: its fields, where each value came from,
// and whether each secret is set. No secret value is included.
//
// The labels come from the settings catalogue, so the console shows the same
// words the configuration page would show for the same setting.
function describe(providerId, overlay) {
  const provider = String(providerId || '').trim().toLowerCase();
  const group = groupOf(provider);
  if (!group) return null;

  const fields = [];
  for (const name of group.settings) {
    const resolved = value(provider, name, overlay);
    fields.push(Object.assign(descriptor(resolved.key), {
      name,
      type: typeOf(name),
      value: resolved.value === null || resolved.value === undefined ? null : resolved.value,
      source: resolved.source,
      legacy: resolved.legacy,
    }));
  }

  const secrets = [];
  for (const name of group.secrets) {
    const resolved = secret(provider, name, overlay);
    secrets.push(Object.assign(descriptor(resolved.key), {
      name,
      type: 'secret',
      set: resolved.set,
      source: resolved.source,
      legacy: resolved.legacy,
    }));
  }

  return {
    id: provider,
    fields,
    secrets,
    maxParticipants: limit(provider, overlay),
    missing: missing(provider, overlay),
  };
}

// The label and the description of a setting, from the catalogue.
function descriptor(key) {
  const entry = settings.SCHEMA.find((item) => item.key === key);
  return {
    key,
    label: entry ? entry.label : key,
    description: entry ? entry.description : '',
  };
}

function typeOf(name) {
  if (name === 'maxParticipants' || name === 'turnPort') return 'integer';
  if (name === 'stunUrls') return 'list';
  return 'string';
}

// Whether a secret belongs to a provider, and is one it cannot do without.
function isRequiredSecret(providerId, key) {
  const provider = String(providerId || '').trim().toLowerCase();
  if (provider === 'cloudflare') return key === 'voice.cloudflare.appSecret';
  return false;
}

module.exports = {
  PROVIDERS,
  GROUPS,
  DEFAULT_LIMITS,
  isProvider,
  selected,
  keyOf,
  groupOf,
  value,
  secret,
  configuration,
  publicConfiguration,
  describe,
  missing,
  limit,
  iceServers,
  inHouseRelay,
  addressIsReachable,
  isRequiredSecret,
  typeOf,
};

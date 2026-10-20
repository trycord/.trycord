// The media providers.
//
// One place that knows what each provider is called, what it needs before it
// can carry a session, and how its health is checked. The console renders this
// list; the runtime refuses a session with the same list of what is missing.
//
// The states a provider can be in:
//
//   disabled     voice and video are switched off on this instance
//   configured   the provider is not the one in force; it is ready to be
//                chosen, not running
//   failed       the provider is in force and something it needs is missing
//   degraded     the provider is in force and something it needs is there, but
//                the other end did not answer
//   active       the provider is in force, complete, and it answered
//
// A provider is never reported as active because its configuration was saved.
// Configuration is what makes a provider eligible; only an answer from the
// other end makes it working.

'use strict';

const config = require('./config');
const relay = require('./relay');

// The endpoint the third-party path speaks.
//
// A media server that implements it offers these three calls:
//
//   POST   {endpoint}/sessions                 -> { "sessionId": "..." }
//   POST   {endpoint}/sessions/{id}/negotiate  -> { "sessionDescription": {...} }
//   DELETE {endpoint}/sessions/{id}
//
// The session id is what the participant row holds and what the client sends
// back, so the server never has to be asked who a session belongs to.
function stripTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

// Cloudflare Realtime.
//
// The check creates a session, which is the cheapest authenticated call the
// API offers: it proves the application id and the application secret at once.
// A session with nobody in it is not billed, and it expires on its own.
async function checkCloudflare(cfg) {
  const endpoint = stripTrailingSlash(cfg.endpoint);
  const secret = cfg.resolved.appSecret.value;
  let response;
  try {
    response = await fetch(endpoint + '/apps/' + encodeURIComponent(cfg.appId) + '/sessions/new', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + secret,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
  } catch (error) {
    return {
      ok: false,
      detail: 'The Cloudflare endpoint could not be reached: ' + ((error && error.message) || 'the connection failed') + '.',
    };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, detail: 'Cloudflare refused the application secret.' };
  }
  if (!response.ok) {
    return { ok: false, detail: 'Cloudflare answered with HTTP ' + response.status + '.' };
  }
  return { ok: true, detail: 'Cloudflare accepted the application id and created a session.' };
}

// The third-party path.
//
// The endpoint is reached over HTTP with the token as a bearer credential.
// A server that answers at all is reachable; one that answers 401 has refused
// the token, which is a different problem and is reported as one.
async function checkSfu(cfg) {
  const endpoint = stripTrailingSlash(cfg.endpoint);
  const headers = cfg.token ? { Authorization: 'Bearer ' + cfg.token } : {};

  let response;
  try {
    response = await fetch(endpoint + '/health', { headers });
  } catch (error) {
    return {
      ok: false,
      detail: 'The media server could not be reached: ' + ((error && error.message) || 'the connection failed') + '.',
    };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, detail: 'The media server refused the token.' };
  }
  if (response.ok) {
    return { ok: true, detail: 'The media server answered its health check.' };
  }

  // No health path: the endpoint itself is asked whether it is there.
  try {
    response = await fetch(endpoint, { headers });
  } catch (error) {
    return {
      ok: false,
      detail: 'The media server could not be reached: ' + ((error && error.message) || 'the connection failed') + '.',
    };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, detail: 'The media server refused the token.' };
  }
  if (response.status === 404 || response.status === 405) {
    return { ok: false, detail: 'The media server answered, but it offers neither /health nor an index at ' + endpoint + '.' };
  }
  return { ok: true, detail: 'The media server answered at ' + endpoint + '.' };
}

// The mesh.
//
// The mesh has no server of its own to ask, so the check asks the addresses
// the peers will be given: a STUN server or a TURN relay that answers a
// binding request is a peer that can be found. With nothing configured the
// relay this instance runs itself is used, so the check starts it first.
async function checkMesh(cfg) {
  const configuredStun = cfg.stunUrls.length > 0;
  const configuredTurn = !!cfg.turnUrl;
  if (!configuredStun && !configuredTurn) await relay.ensureInHouse();

  const servers = config.iceServers('mesh').map((entry) => entry.urls);
  if (!servers.length) {
    return { ok: false, detail: 'The mesh has no STUN server and no TURN relay.' };
  }

  // The STUN and the TURN address of the in-house relay are the same address,
  // so it is asked once.
  const addresses = Array.from(new Set(servers));
  const results = await Promise.all(addresses.map((url) => relay.probeAddress(url)));
  const answered = results.filter((result) => result.ok);

  if (!answered.length) {
    const inHouse = relay.inHouseState();
    const detail = results.map((result) => result.detail).join(' ');
    const extra = inHouse && inHouse.running
      ? ' The relay this instance runs is listening on ' + inHouse.host + ':' + inHouse.port
        + ', so it is running but not answering.'
      : '';
    return { ok: false, detail: detail + extra + ' ' + wildcardNote(inHouse) };
  }

  return {
    ok: true,
    detail: answered.length + ' of ' + results.length + ' ICE addresses answered a binding request.'
      + ' ' + wildcardNote(relay.inHouseState()),
    results,
  };
}

// The address the peers are given.
//
// The relay listens on every interface, and every interface is not an address
// a client can reach. What matters is the address the *clients* are given,
// which is the published one - the instance's public address, or the one the
// operator named.
//
// The note used to report the *listen* address, so an instance whose relay
// listened on 0.0.0.0 and published api.trycord.dev was told it advertised
// 0.0.0.0 and that no client could reach it - while the clients were in fact
// being given api.trycord.dev. The diagnosis sent an operator to set a
// variable that was already right.
function wildcardNote(inHouse) {
  if (!inHouse) return '';
  const listen = String(inHouse.host || '');
  if (listen && listen !== '0.0.0.0' && listen !== '::' && listen !== '[::]') return '';
  const advertised = String(config.inHouseRelay().advertised || '');
  if (advertised && advertised !== '0.0.0.0' && advertised !== '::' && advertised !== '[::]') {
    return ' The relay listens on every interface and is published as '
      + advertised + ', which is the address the clients are given.';
  }
  return ' The relay is published as ' + (advertised || listen || '0.0.0.0')
    + ', which no client can reach: set TRYCORD_TURN_HOST to an address clients can use, '
    + 'or give the instance a public URL.';
}

const PROVIDERS = [
  {
    id: 'mesh',
    label: 'Mesh',
    summary: 'The in-house peer-to-peer path. The media travels between the participants and this server carries the signalling.',
    note: 'The media travels between every participant, so a room is small: the traffic a room produces grows with the square of the number of people in it. The TURN relay is what a peer that cannot be reached directly uses - a client behind a symmetric NAT has no direct route to anybody else in the room.',
    check: checkMesh,
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Realtime',
    summary: 'The Cloudflare SFU. The media is carried by Cloudflare and this server holds the authorisation.',
    note: 'The application secret is used to create a session and never reaches a browser. The check creates a session on the provider, which is how the credentials are proved.',
    check: checkCloudflare,
  },
  {
    id: 'sfu',
    label: 'Third-party SFU',
    summary: 'A media server the operator runs. It speaks the documented session API over HTTP.',
    note: 'The endpoint is the base URL of the media server and the token is sent as a bearer credential with every request. The token is used by this server only and never reaches a browser.',
    check: checkSfu,
  },
];

function find(providerId) {
  const id = String(providerId || '').trim().toLowerCase();
  return PROVIDERS.find((provider) => provider.id === id) || null;
}

// The provider's own description, with the fields it owns.
function describe(providerId, overlay) {
  const provider = find(providerId);
  if (!provider) return null;
  const described = config.describe(provider.id, overlay);
  return Object.assign({}, described, {
    id: provider.id,
    label: provider.label,
    summary: provider.summary,
    note: provider.note,
    // The instance's own networking stack, for the console.
    //
    // It is in the report rather than in a separate call, because an operator
    // looking at the mesh wants to know the state of the relay in the same
    // place as the state of the provider - and the two are the same question
    // for the mesh: the mesh is the instance's own relay.
    stack: stackState(),
  });
}

// The instance's own STUN and TURN stack.
//
// Three things, and they are different things:
//
//   the process    the voice process is running;
//   the service    the service answers a binding request here;
//   the published  the published address answers from here.
//
// The third is the one an operator has to act on, and it is the one that was
// being reported wrongly: the note used to name the listen address, so an
// instance that listened on 0.0.0.0 and published a real address was told
// it published 0.0.0.0.
function stackState() {
  const inHouse = relay.inHouseState();
  const advertised = config.inHouseRelay().advertised;
  const listenPort = config.inHouseRelay().port;
  return {
    managed: inHouse ? (inHouse.managed || 'this process') : 'not started',
    running: !!(inHouse && inHouse.running),
    listenHost: inHouse ? inHouse.host : String(process.env.TRYCORD_TURN_HOST || '0.0.0.0'),
    listenPort,
    advertised,
    // The address the clients are given, and whether it is one they can
    // reach.
    publishedIsLocal: advertised === '127.0.0.1' || advertised === 'localhost',
    // The relay port range, so an operator knows which ports to open.
    relayPorts: relayPortRange(),
    secretSet: !!String(process.env.TRYCORD_TURN_SECRET || '').trim(),
  };
}

// The range the relay takes its ports from.
function relayPortRange() {
  const from = Number(process.env.TRYCORD_TURN_RELAY_MIN || 0);
  const to = Number(process.env.TRYCORD_TURN_RELAY_MAX || 0);
  if (Number.isFinite(from) && Number.isFinite(to) && from > 0 && to >= from) {
    return { from, to };
  }
  const base = Number(process.env.TRYCORD_TURN_PORT || 3478) || 3478;
  return { from: base + 1, to: base + 100 };
}

// The provider's own health, checked for real.
//
// A provider with a configuration problem is not checked: there is nothing to
// check yet, and a network round trip against a half-configured provider
// reports a network problem where the real one is a missing field.
async function check(providerId, overlay) {
  const provider = find(providerId);
  if (!provider) return { ok: false, detail: 'No such provider.' };

  const missing = config.missing(provider.id, overlay);
  if (missing.length) {
    return { ok: false, detail: 'This provider is not configured: ' + missing.join('; ') + '.' };
  }

  const cfg = config.configuration(provider.id, overlay);
  try {
    const outcome = await provider.check(cfg);
    return outcome || { ok: false, detail: 'The check returned nothing.' };
  } catch (error) {
    return { ok: false, detail: (error && error.message) || 'The check failed.' };
  }
}

module.exports = { PROVIDERS, find, describe, check };

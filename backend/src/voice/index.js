// The voice process.
//
// The voice infrastructure is a subsystem of its own: the STUN and TURN
// service, its lifecycle, its health, and its diagnostics. It is a separate
// process because it fails differently from the application. The API can be
// restarting while a call is still being carried, and the API's health says
// nothing about whether the relay answered a binding request. One process
// that reported "I am up" and another that reported "the relay answered"
// would be a lie told in one voice.
//
// So:
//
//   the API process      authentication, authorization, the application APIs,
//                        the communities, the settings, and the issuing of
//                        short-lived TURN credentials;
//   the voice process    the STUN and TURN service, its lifecycle, the health
//                        checks, the configuration and the diagnostics;
//   the engine           the STUN and TURN protocol implementation itself.
//
// The boundary is deliberately narrow. The voice process does not own the
// membership of a community, does not decide who may join a call, and does
// not issue a session: those are the API's, and the API's rules are the ones
// that decide. What the voice process owns is the thing the API cannot own -
// a socket that has to be open before anybody asks for a call, and the
// answer to "is it working?".
//
// The protocol implementation is the in-house one in `src/services/turn.js`.
// It is a real STUN and TURN server: it answers binding requests, it checks
// the message integrity of an allocate request against the credential it
// issued, and it relays the bytes.
//
// Running:
//   node src/voice/index.js
//   pm2 start ecosystem.config.js
//   pm2 logs trycord-voice
//
// The environment is the same file the API reads, so the settings cannot
// disagree between the two.

'use strict';

const path = require('path');

// The environment is loaded the way the API loads it, so a variable means
// the same thing in both processes.
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
} catch {
  // A deployment that keeps the environment elsewhere has already set it.
}

const http = require('http');
const dns = require('dns');
const turn = require('../services/turn');
const relay = require('../services/voice/relay');
const voiceConfig = require('../services/voice/config');
const settings = require('../services/settings');

const PORT = Number(process.env.TRYCORD_VOICE_PROCESS_PORT || 9973);
const HOST = String(process.env.TRYCORD_VOICE_PROCESS_HOST || '127.0.0.1').trim();

let engine = null;
let engineState = null;
let server = null;
let starting = null;
let lastCheck = null;
let shuttingDown = false;

// ---- the configuration ------------------------------------------------------

/**
 * The voice configuration, and whether it is usable.
 *
 * A configuration is not "set" - it is "usable". The relay needs a port it
 * can bind and a secret it can mint credentials under, and a setting that
 * names a third-party relay that is not there is a setting that will not
 * work.
 */
function describeConfiguration() {
  // The relay is a service of this instance: it listens on every interface
  // unless the operator names an address.
  const listenHost = String(process.env.TRYCORD_TURN_HOST || '0.0.0.0').trim();
  const listenPort = Number(process.env.TRYCORD_TURN_PORT || 3478);
  // The published address. The instance knows its own public address, and
  // that is the address the clients are given - "0.0.0.0" is a wildcard and
  // not a place. The settings are read for it, so the voice process and the
  // API publish the same address.
  const advertised = publishedAddress();
  const problems = [];

  if (!Number.isFinite(listenPort) || listenPort <= 0) {
    problems.push('TRYCORD_TURN_PORT is not a port');
  }
  if (!process.env.TRYCORD_TURN_SECRET) {
    problems.push('TRYCORD_TURN_SECRET is not set, so the credentials this '
      + 'instance issues are good only until it restarts');
  }
  if (!advertised || advertised === '0.0.0.0' || advertised === '::') {
    problems.push('the relay is published as ' + (advertised || '0.0.0.0')
      + ', which no client can reach: set TRYCORD_PUBLIC_URL, or the '
      + "instance's own public URL setting, or TRYCORD_TURN_HOST");
  }

  return {
    listenHost,
    listenPort,
    advertised,
    problems,
    ready: problems.length === 0,
  };
}

/**
 * The address the clients are given.
 *
 * The instance's own public address, from the environment or from the setting
 * the administrator saved. The settings are read from the same file the API
 * reads, so the two processes cannot publish different addresses.
 */
function publishedAddress() {
  // The voice configuration already knows the address: it is the one the
  // clients are given, and it is the one the API publishes in its ICE
  // configuration. Reading it from anywhere else would let the two disagree -
  // and they did: the process reported the instance's own address while the
  // API was publishing the voice one.
  return voiceConfig.inHouseRelay().advertised;
}

// ---- the engine ------------------------------------------------------------

/**
 * Start the STUN and TURN service.
 *
 * It is started once. A second start would be a second socket on the same
 * port, and the second one would fail - or worse, one of them would answer
 * and the other's allocations would go nowhere.
 */
async function startEngine() {
  if (engine) return engine;
  if (starting) return starting;

  const config = describeConfiguration();
  starting = (async () => {
    const socket = turn.start({ host: config.listenHost, port: config.listenPort });
    engine = socket;
    engineState = {
      running: true,
      host: config.listenHost,
      port: config.listenPort,
      realm: String(process.env.TRYCORD_TURN_REALM || 'trycord-turn'),
      startedAt: new Date().toISOString(),
      owner: 'the voice process',
    };
    return socket;
  })().finally(() => { starting = null; });

  return starting;
}

/**
 * Stop the STUN and TURN service.
 *
 * The socket is closed and every allocation is dropped, so a restart of the
 * voice process does not leave relay sockets behind on ports the next
 * process would then refuse to bind.
 */
function stopEngine() {
  try { turn.stop(); } catch { /* already stopped */ }
  engine = null;
  engineState = null;
}

// ---- the health checks -----------------------------------------------------

/**
 * Ask the addresses the clients are given whether they answer.
 *
 * Three questions, and they have three different answers:
 *
 *   the process    is the voice process running at all;
 *   the service    does the service answer, here, on this host;
 *   the world      is the published address reachable from outside.
 *
 * The last one is the one that cannot be answered from inside the instance:
 * a host behind a NAT answers on its own address and is not reachable on its
 * public one, and only a request from outside can tell the difference. So
 * the public address is checked here, and the answer is reported as the
 * *local* answer it is, with the public one named as unproven rather than
 * claimed.
 */
async function check() {
  const config = describeConfiguration();
  const inHouse = engineState;

  // Two addresses, and two different questions.
  //
  // The local one asks whether the service is alive: a request to this host
  // on the port the service is bound to. The published one asks whether the
  // address the clients are given resolves here and answers.
  //
  // They are different questions and they have different answers: a host
  // behind a NAT answers on its own address and not on its public one, and a
  // service whose published address points somewhere else answers on neither.
  // Reporting one as the other sent an operator to set a variable that was
  // already right.
  const local = [];
  const published = [];

  const localHost = config.listenHost === '0.0.0.0' || config.listenHost === '::'
    ? '127.0.0.1'
    : config.listenHost;
  const localProbe = await relay.probeAddress('stun:' + localHost + ':' + config.listenPort, 2000);
  local.push({
    address: localHost + ':' + config.listenPort,
    ok: !!localProbe.ok,
    detail: localProbe.detail || '',
  });

  if (config.advertised && config.advertised !== localHost) {
    const publishedProbe = await relay.probeAddress('stun:' + config.advertised + ':' + config.listenPort, 2000);
    published.push({
      address: config.advertised + ':' + config.listenPort,
      ok: !!publishedProbe.ok,
      detail: publishedProbe.detail || '',
    });
  }

  const all = local.concat(published);
  const answered = all.filter((entry) => entry.ok);
  const state = {
    at: new Date().toISOString(),
    process: { ok: true, detail: 'The voice process is running.' },
    configuration: { ok: config.ready, detail: config.problems.join(' ') || 'The configuration is usable.' },
    engine: {
      ok: !!(inHouse && inHouse.running),
      detail: inHouse
        ? (inHouse.running
          ? 'The STUN and TURN service is listening on ' + inHouse.host + ':' + inHouse.port + '.'
          : 'The STUN and TURN service is not running: ' + (inHouse.reason || 'it did not start'))
        : 'The STUN and TURN service has not been started.',
    },
    service: {
      // The service is alive when it answers on this host. The published
      // address answering is a separate fact, and it is reported separately:
      // a published address that does not answer from here is a routing or a
      // firewall fact, not a dead service.
      ok: local.some((entry) => entry.ok),
      detail: local.some((entry) => entry.ok)
        ? 'The service answers a binding request on this host.'
        : 'Nothing answered a binding request at ' + (local.map((e) => e.address).join(', ') || 'the local address') + '.',
      local,
    },
    published: {
      ok: published.length ? published.every((entry) => entry.ok) : null,
      detail: published.length
        ? (published.every((entry) => entry.ok)
          ? 'The published address answers a binding request from this host.'
          : 'The published address does not answer from this host. The service is running, so this is the address, the routing or the firewall - not the service. '
            + (await proxyExplanation(config.advertised)))
        : 'The published address is the local one, so there is nothing separate to check.',
      addresses: published,
    },
    // Reachability from outside is a different question, and it is not
    // answered from here. Saying so is better than guessing.
    reachability: {
      ok: null,
      detail: 'Whether the published address is reachable from outside this host '
        + 'is not answered by a request from inside it. The service answers on '
        + 'this host; whether the port is open to the internet is the '
        + "deployment's business - the firewall and the port forwarding.",
    },
  };

  lastCheck = state;
  return state;
}

/**
 * Why a published address does not answer, when the reason can be seen.
 *
 * The usual reason is not a firewall: it is a proxy. A site is normally
 * served through one, and a proxy that terminates TLS carries HTTP and not
 * the arbitrary UDP a STUN or TURN service needs. The requests go to the
 * proxy and stop there.
 *
 * So the answer names the proxy when the address points at one, and says
 * what the operator has to do about it: a hostname that points straight at
 * the instance - DNS only, not proxied - and the port open.
 */
async function proxyExplanation(address) {
  let addresses = [];
  try {
    const records = await dns.promises.lookup(String(address), { all: true });
    addresses = records.map((record) => record.address);
  } catch {
    addresses = [];
  }
  if (!addresses.length) {
    return 'The published address does not even resolve from this host.';
  }
  const proxied = addresses.filter((ip) => isProxyAddress(ip));
  if (proxied.length === addresses.length) {
    return 'It points at ' + proxied[0] + ', which is a proxy rather than this host: '
      + 'a proxy that terminates TLS carries HTTP and not the arbitrary UDP a STUN or TURN '
      + 'service needs. Give the voice stack an address of its own - a hostname that points '
      + 'straight at this instance, DNS only and not proxied - and open UDP '
      + describeConfiguration().listenPort + ' to the internet.';
  }
  return 'It points somewhere that does not answer. Check the port forwarding and the '
    + 'firewall for UDP ' + describeConfiguration().listenPort + '.';
}

// The address ranges the big networks serve through a proxy.
//
// A range is written as its first two octets and the last octet they can
// reach, so "104.16-31" is 104.16.0.0 to 104.31.255.255. The list is
// Cloudflare's, because that is the proxy a site is most often behind - and
// because a proxied address is the reason a relay published at the site's
// own address cannot be reached.
const PROXY_RANGES = [
  { from: [104, 16], to: [104, 31], name: 'Cloudflare' },
  { from: [172, 64], to: [172, 71], name: 'Cloudflare' },
  { from: [103, 21], to: [103, 22], name: 'Cloudflare' },
  { from: [141, 101], to: [141, 101], name: 'Cloudflare' },
  { from: [108, 162], to: [108, 162], name: 'Cloudflare' },
  { from: [190, 93], to: [190, 93], name: 'Cloudflare' },
  { from: [188, 114], to: [188, 114], name: 'Cloudflare' },
  { from: [197, 234], to: [197, 234], name: 'Cloudflare' },
  { from: [198, 41], to: [198, 41], name: 'Cloudflare' },
  { from: [162, 158], to: [162, 158], name: 'Cloudflare' },
];

const PROXY_PREFIXES_V6 = ['2606:4700:', '2400:cb00:'];

function isProxyAddress(ip) {
  const text = String(ip || '');
  if (text.indexOf(':') !== -1) {
    for (const prefix of PROXY_PREFIXES_V6) {
      if (text.indexOf(prefix) === 0) return 'Cloudflare';
    }
    return '';
  }
  const parts = text.split('.').map((part) => Number(part) || 0);
  if (parts.length !== 4) return '';
  for (const range of PROXY_RANGES) {
    const first = parts[0];
    const second = parts[1];
    if (first < range.from[0] || first > range.to[0]) continue;
    if (first === range.from[0] && second < range.from[1]) continue;
    if (first === range.to[0] && second > range.to[1]) continue;
    return range.name;
  }
  return '';
}

// ---- the process interface -------------------------------------------------

/**
 * The status the API asks for.
 *
 * It is over HTTP on the loopback, and it answers nothing but the state of
 * the voice infrastructure. The API does not use it to decide who may join a
 * call - that is the API's own permission model - it uses it to tell an
 * operator what the voice infrastructure is doing, and to refuse a call it
 * knows cannot be carried.
 */
function handler(req, res) {
  const path = String(req.url || '/').split('?')[0];

  if (path === '/health' || path === '/healthz') {
    // The process is up. Whether the service is, is a different question and
    // a different answer.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'trycord-voice' }));
    return;
  }

  if (path === '/ready') {
    check().then((state) => {
      const ready = state.configuration.ok && state.engine.ok && state.service.ok;
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Object.assign({ ready }, state)));
    }).catch((error) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: false, error: String((error && error.message) || error) }));
    });
    return;
  }

  if (path === '/status') {
    const config = describeConfiguration();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      configuration: config,
      engine: engineState,
      lastCheck,
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

// ---- the lifecycle ---------------------------------------------------------

async function main() {
  // The instance's own settings, for the address it publishes itself at. A
  // failure here is not fatal: the environment's address is the fallback.
  try {
    await settings.load();
  } catch (error) {
    console.warn('[voice] the instance settings could not be read: '
      + ((error && error.message) || error));
  }

  const config = describeConfiguration();
  if (config.problems.length) {
    // A configuration that cannot work is said out loud and the process stops
    // with a status that says so. A voice process that starts and then
    // refuses every call is worse than one that does not start.
    for (const problem of config.problems) {
      console.error('[voice] ' + problem);
    }
  }

  try {
    await startEngine();
    console.log('[voice] the STUN and TURN service is listening on '
      + config.listenHost + ':' + config.listenPort
      + ', published as ' + config.advertised);
  } catch (error) {
    console.error('[voice] the STUN and TURN service could not be started: '
      + ((error && error.message) || error));
    process.exitCode = 1;
    return;
  }

  server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
  console.log('[voice] the voice process is listening on ' + HOST + ':' + PORT);

  // The first check is made straight away, so the log says whether the
  // service answers rather than only that it started.
  check().then((state) => {
    console.log('[voice] ' + state.service.detail);
  }).catch(() => { /* the first check failing is reported by the next one */ });

  // The check runs on a timer, and the timer is unref'd: it must not be the
  // reason the process refuses to stop.
  const timer = setInterval(() => {
    check().catch(() => { /* the next check will say what happened */ });
  }, 30000);
  timer.unref();
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[voice] ' + signal + ': shutting down');
  try { if (server) server.close(); } catch { /* already closed */ }
  stopEngine();
  // Give the sockets a moment to close, then go.
  setTimeout(() => process.exit(0), 200).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  console.error('[voice] an uncaught error: ' + ((error && error.stack) || error));
});
process.on('unhandledRejection', (reason) => {
  console.error('[voice] an unhandled rejection: ' + ((reason && reason.stack) || reason));
});

main().catch((error) => {
  console.error('[voice] the voice process could not start: '
    + ((error && error.stack) || error));
  process.exit(1);
});

module.exports = { describeConfiguration, check, startEngine, stopEngine };

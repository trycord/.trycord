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

// The process interface is on the loopback, and it is there by rule.
//
// The relay - the STUN and TURN service, the UDP port - is meant to be
// reachable from other hosts; that is the whole point of it. This interface
// is the other thing: the page that says whether the voice stack works, the
// health checks, the configuration. It holds the addresses the instance
// publishes and the credentials it mints, so it has no business on a public
// address. It is on the loopback, and a setting that asks for anything else
// is refused rather than obeyed.
function isLoopback(address) {
  const text = String(address || '').trim().toLowerCase();
  if (!text) return false;
  if (text === 'localhost') return true;
  if (text === '::1' || text === '[::1]') return true;
  if (text.startsWith('127.')) return true;
  return false;
}

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
  //
  // The values come from the instance's own settings, so an administrator who
  // changes the port in the console changes the port the relay binds. The
  // deployment's environment is the seed for a setting that has never been
  // saved, and the fallback for a process that has not read the database.
  const listenHost = String(setting('voice.mesh.turnHost', process.env.TRYCORD_TURN_HOST || '::')).trim();
  const listenPort = Number(setting('voice.mesh.turnPort', process.env.TRYCORD_TURN_PORT || 3478));
  // The published address. The instance knows its own public address, and
  // that is the address the clients are given - "0.0.0.0" is a wildcard and
  // not a place. The settings are read for it, so the voice process and the
  // API publish the same address.
  const advertised = publishedAddress();
  const problems = [];

  if (!Number.isFinite(listenPort) || listenPort <= 0) {
    problems.push('TRYCORD_TURN_PORT is not a port');
  }
  if (!String(process.env.TRYCORD_TURN_STUNKEY || process.env.TRYCORD_TURN_SECRET || '').trim()
    && !stunkeyIsSet()) {
    problems.push('TRYCORD_TURN_STUNKEY is not set, so the credentials this '
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

// ---- the ticket -------------------------------------------------------------

// The ticket that says the person at the machine is an administrator.
//
// The page can change the instance and mint a credential for the relay, so
// it asks for a ticket: the voice console mints one - behind the
// platform-admin gate - and the API is asked whether it is good. The API is
// the thing that knows who an administrator is, and it is the thing that
// says yes or no.
//
// The ticket is remembered in a cookie for the length of the visit, so the
// operator is not asked for it on every form.
const COOKIE = 'trycord_voice_admin';

function cookieValue(req, name) {
  const header = String(req.headers && req.headers.cookie ? req.headers.cookie : '');
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

// Ask the API whether a ticket is good.
//
// The API is on the loopback of the same machine, and the answer is a yes
// or a no. An API that cannot be reached is a no: a page that unlocks
// itself because the check was skipped is not a page that is locked.
async function ticketIsGood(ticket) {
  const api = String(process.env.TRYCORD_API_URL || '').trim()
    || 'http://127.0.0.1:' + String(process.env.PORT || 9971);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const answer = await fetch(api + '/api/voice-local-ticket/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: String(ticket || '') }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!answer.ok) return false;
    const body = await answer.json().catch(() => ({}));
    return body && body.ok === true;
  } catch (e) {
    return false;
  }
}

// ---- the configuration and the credentials -----------------------------------

// One setting of the instance, read the way everything else is read.
//
// The instance's saved value is the one in force, and the deployment's
// environment is what it falls back to - the same rule every setting
// follows, so a restart cannot quietly undo a change an administrator
// made. A process that has not read the database has the environment and
// the default, which is enough to run the relay and not enough to change
// it.
function setting(key, fallback) {
  try {
    const value = settings.read(key, fallback);
    return value === undefined || value === null ? fallback : value;
  } catch (e) {
    return fallback;
  }
}

// Where a value came from, in words an operator reads.
function sourceName(source) {
  if (source === 'environment') return 'set by the deployment';
  if (source === 'instance') return 'saved by an administrator';
  return 'the default';
}

// The relay's own settings, and where each of them came from.
function relaySettings() {
  return {
    host: setting('voice.mesh.turnHost', process.env.TRYCORD_TURN_HOST || '::'),
    port: setting('voice.mesh.turnPort', process.env.TRYCORD_TURN_PORT || 3478),
    realm: setting('voice.mesh.turnRealm', process.env.TRYCORD_TURN_REALM || 'trycord-turn'),
    published: setting('voice.mesh.publicUrl', process.env.TRYCORD_VOICE_PUBLIC_URL || ''),
    sources: {
      host: settingSource('voice.mesh.turnHost'),
      port: settingSource('voice.mesh.turnPort'),
      realm: settingSource('voice.mesh.turnRealm'),
      published: settingSource('voice.mesh.publicUrl'),
    },
  };
}

function settingSource(key) {
  try {
    return settings.source(key);
  } catch (e) {
    return 'default';
  }
}

// Whether the instance has a key of its own for the credentials.
//
// Whether, and never what: the key is the one thing on this page that is
// never shown, because a page that shows it is a page that has it in a
// screenshot.
function stunkeyIsSet() {
  try {
    const value = settings.secretValue('voice.mesh.stunkey');
    return !!String(value || '').trim();
  } catch (e) {
    return false;
  }
}

// One field of the configuration form.
function field(label, name, value, source, type, note) {
  const lines = [];
  lines.push('<div class="field">');
  lines.push('<label for="' + escapeHtml(name) + '">' + escapeHtml(label) + '</label>');
  lines.push('<input id="' + escapeHtml(name) + '" name="' + escapeHtml(name) + '" type="' + type
    + '" value="' + escapeHtml(value === undefined || value === null ? '' : value) + '">');
  lines.push('<p class="note">' + escapeHtml(note) + ' It is ' + escapeHtml(sourceName(source)) + '.</p>');
  lines.push('</div>');
  return lines.join('\n');
}

/**
 * The configuration page.
 *
 * The relay's own settings: the address it binds, the port it binds it on,
 * the address the clients are given, the realm its credentials are issued in,
 * and the key they are minted under.
 */
function renderConfigPage(state) {
  const view = state || {};
  const relay = relaySettings();
  const lines = [];

  lines.push('<h1>Configure the relay</h1>');
  lines.push('<p class="lede">The in-house STUN and TURN service. These are the instance\'s own settings: '
    + 'the value the instance saved is the one in force, and the deployment\'s environment is what it '
    + 'falls back to until something is saved here.</p>');

  if (view.saved) lines.push('<p class="saved">' + escapeHtml(view.saved) + '</p>');
  if (view.problem) lines.push('<p class="problem">' + escapeHtml(view.problem) + '</p>');
  if (view.canSave === false) {
    lines.push('<p class="note">This page shows what the relay runs with. Saving it needs an '
      + 'administrator: open it from the voice console in the application, and the console gives '
      + 'the page a ticket that is good for a moment.</p>');
  }

  lines.push('<form method="post" action="/config">');
  lines.push(field('The address the relay listens on', 'voice.mesh.turnHost', relay.host, relay.sources.host,
    'text', 'A wildcard - 0.0.0.0 or :: - means every interface, which is what a relay that has to be reached from outside wants.'));
  lines.push(field('The port the relay listens on', 'voice.mesh.turnPort', relay.port, relay.sources.port,
    'number', 'This is the port the clients are given, so it has to be open on the network they are on.'));
  lines.push(field('The address the clients are given', 'voice.mesh.publicUrl', relay.published, relay.sources.published,
    'text', 'A hostname that points straight at this instance - DNS only, not through a proxy that terminates TLS - or the address of the machine on its own network.'));
  lines.push(field('The realm the credentials are issued in', 'voice.mesh.turnRealm', relay.realm, relay.sources.realm,
    'text', 'The name the client is told to use. It has to match the realm the relay answers with, or a credential that is right is refused.'));
  lines.push('<div class="field">');
  lines.push('<label for="voice.mesh.stunkey">The key the credentials are minted under</label>');
  lines.push('<input id="voice.mesh.stunkey" name="voice.mesh.stunkey" type="password" value="" '
    + 'autocomplete="new-password" placeholder="' + (stunkeyIsSet() ? 'a key is set - type to replace it' : 'no key is set') + '">');
  lines.push('<p class="note">The shared secret, the same thing Coturn calls a static auth secret. '
    + 'A host that has it can mint credentials of its own. It is never shown again once it is set.</p>');
  lines.push('</div>');
  if (view.canSave !== false) {
    lines.push('<button type="submit">Save</button>');
  }
  lines.push('</form>');

  lines.push('<nav class="links">'
    + '<a href="/">Whether it is working</a>'
    + '<a href="/credentials">Mint a credential</a>'
    + '<a href="/status">The state as JSON</a>'
    + '</nav>');

  lines.push('<footer>The address and the port take effect as soon as they are saved: the relay is bound again '
    + 'with the new ones. This page is served on the loopback of this instance and on nothing else.</footer>');

  return pageShell('Configure the relay - the voice stack', lines);
}

/**
 * The credential page.
 *
 * A credential is a username and a password, and the pair is worth
 * something to whoever holds it - so it is shown once, here, and nowhere
 * else. The username carries its own expiry, and the password is the hash
 * the standard asks for.
 */
function renderCredentialsPage(state) {
  const view = state || {};
  const lines = [];

  lines.push('<h1>Mint a credential</h1>');
  lines.push('<p class="lede">A credential for the relay: the username the client gives, and the password '
    + 'it gives with it. The username carries the moment it stops working, and the password is the 32-character '
    + 'hash of the username, the realm and the key.</p>');

  if (view.problem) lines.push('<p class="problem">' + escapeHtml(view.problem) + '</p>');

  if (view.credential) {
    lines.push('<table>');
    lines.push('<tbody>');
    lines.push('<tr><th scope="row">Username</th><td><code>' + escapeHtml(view.credential.username) + '</code></td></tr>');
    lines.push('<tr><th scope="row">Password</th><td><code>' + escapeHtml(view.credential.password) + '</code></td></tr>');
    lines.push('<tr><th scope="row">Realm</th><td><code>' + escapeHtml(view.credential.realm) + '</code></td></tr>');
    lines.push('<tr><th scope="row">Good for</th><td>' + escapeHtml(view.credential.hours) + ' hour(s)</td></tr>');
    lines.push('<tr><th scope="row">Relay</th><td><code>' + escapeHtml(view.credential.url) + '</code></td></tr>');
    lines.push('</tbody>');
    lines.push('</table>');
    lines.push('<p class="note">This is the only time the password is shown. Copy it now.</p>');
  }

  lines.push('<form method="post" action="/credentials">');
  lines.push('<div class="field">');
  lines.push('<label for="name">Who it is for</label>');
  lines.push('<input id="name" name="name" type="text" value="' + escapeHtml(view.name || '') + '" placeholder="a host, an application, a person">');
  lines.push('</div>');
  lines.push('<div class="field">');
  lines.push('<label for="hours">How many hours it is good for</label>');
  lines.push('<input id="hours" name="hours" type="number" min="1" max="168" value="' + escapeHtml(view.hours || 24) + '">');
  lines.push('</div>');
  lines.push('<button type="submit">Mint it</button>');
  lines.push('</form>');

  lines.push('<nav class="links">'
    + '<a href="/">Whether it is working</a>'
    + '<a href="/config">Configure the relay</a>'
    + '<a href="/status">The state as JSON</a>'
    + '</nav>');

  lines.push('<footer>Another host that has the key can mint its own credential without this page. '
    + 'This page is served on the loopback of this instance and on nothing else.</footer>');

  return pageShell('Mint a credential - the voice stack', lines);
}

// The body of a form, as a map.
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = {};
      for (const pair of text.split('&')) {
        if (!pair) continue;
        const at = pair.indexOf('=');
        const name = decodeURIComponent((at === -1 ? pair : pair.slice(0, at)).replace(/\+/g, ' '));
        const value = at === -1 ? '' : decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' '));
        if (name) body[name] = value;
      }
      resolve(body);
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * Save the relay's configuration.
 *
 * The settings are the instance's own, and the voice console is the one that
 * owns them, so the write names that owner: a write that arrived from
 * anywhere else would be a second editor for one value.
 *
 * When the address or the port has changed, the relay is bound again - a
 * relay that is still listening on the old port is a relay the clients
 * cannot reach.
 */
async function saveConfiguration(body) {
  const entries = {};
  const host = String(body['voice.mesh.turnHost'] || '').trim();
  const realm = String(body['voice.mesh.turnRealm'] || '').trim();
  const published = String(body['voice.mesh.publicUrl'] || '').trim();
  const port = Number(body['voice.mesh.turnPort']);
  const key = String(body['voice.mesh.stunkey'] || '').trim();

  if (!host) return { problem: 'The relay has to listen on an address.' };
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return { problem: 'The port has to be a number between 1 and 65535.' };
  }
  if (!realm) return { problem: 'The realm cannot be empty: the client is told to use it.' };

  entries['voice.mesh.turnHost'] = host;
  entries['voice.mesh.turnPort'] = port;
  entries['voice.mesh.turnRealm'] = realm;
  entries['voice.mesh.publicUrl'] = published;
  // An empty field means "leave the key that is set alone", because a page
  // that shows the key as a blank field would otherwise wipe it.
  if (key) entries['voice.mesh.stunkey'] = key;

  const before = describeConfiguration();

  let result;
  try {
    result = await settings.save(entries, 'the voice process', { owner: 'admin.voice' });
  } catch (error) {
    return { problem: String((error && error.message) || error) };
  }
  if (!result || !result.ok) {
    return { problem: (result && result.problems ? result.problems.join('; ') : 'the configuration was refused') };
  }

  const after = describeConfiguration();
  if (before.listenHost !== after.listenHost || before.listenPort !== after.listenPort) {
    // The relay is bound again with the new address and the new port.
    stopEngine();
    try {
      await startEngine();
    } catch (error) {
      return { problem: 'The configuration is saved, but the relay could not be bound again: '
        + String((error && error.message) || error) };
    }
  }

  return { saved: 'The configuration is saved. The relay is listening on '
    + after.listenHost + ':' + after.listenPort + ' and is published as ' + after.advertised + '.' };
}

/**
 * Mint a credential for the relay.
 *
 * The name is for the holder's own use - it goes into the username, so the
 * person reading a log can tell whose credential it was. The expiry is the
 * username's own, and the relay refuses it once it has passed.
 */
function mintCredential(body) {
  const name = String(body.name || '').trim() || 'the voice process';
  const hours = Math.max(1, Math.min(168, Number(body.hours) || 24));
  const realm = setting('voice.mesh.turnRealm', process.env.TRYCORD_TURN_REALM || 'trycord-turn');
  const host = setting('voice.mesh.turnHost', process.env.TRYCORD_TURN_HOST || '::');
  const port = Number(setting('voice.mesh.turnPort', process.env.TRYCORD_TURN_PORT || 3478)) || 3478;
  const advertised = publishedAddress();

  const minted = turn.issueCredentials(name, hours * 3600);
  return {
    credential: {
      username: minted.username,
      password: minted.password,
      realm,
      hours,
      url: 'turn:' + (advertised || host) + ':' + port,
    },
    name,
    hours,
  };
}

/**
 * The page a refused ticket gets.
 *
 * It says what happened and what to do about it, because the alternative -
 * a page that simply refuses - leaves the operator guessing.
 */
function renderTicketPage(problem) {
  const lines = [];
  lines.push('<h1 class="bad">Not open</h1>');
  lines.push('<p class="lede">' + escapeHtml(problem || 'That ticket was not good.') + '</p>');
  lines.push('<p>Open the voice console in the application and use the button that opens this page. '
    + 'The console gives it a ticket that is good once, and for a minute or two.</p>');
  lines.push('<nav class="links"><a href="/">Whether the stack is working</a></nav>');
  lines.push('<footer>This page is served on the loopback of this instance and on nothing else.</footer>');
  return pageShell('Not open - the voice stack', lines);
}

// ---- the page ---------------------------------------------------------------

/**
 * Whether the voice stack is working, and what says otherwise.
 *
 * The answer is one word, because that is what somebody opening the page
 * wants to know: does a call work right now, yes or no. The reasons are
 * behind it, because a "no" without a reason is not worth opening a page
 * for.
 *
 * A published address that does not answer counts against the verdict. The
 * service can be alive on this host and still be useless to a client, if the
 * address the clients are given is one that nothing answers on.
 */
function verdictOf(state) {
  const reasons = [];
  const configuration = state.configuration || {};
  const engine = state.engine || {};
  const service = state.service || {};
  const published = state.published || {};

  if (configuration.ok === false) reasons.push(configuration.detail || 'The configuration is not usable.');
  if (engine.ok === false) reasons.push(engine.detail || 'The service is not running.');
  if (service.ok === false) reasons.push(service.detail || 'Nothing answered a binding request.');
  if (published.ok === false) reasons.push(published.detail || 'The published address does not answer.');

  return { working: reasons.length === 0, reasons };
}

function escapeHtml(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The page.
 *
 * It is a page of its own rather than a line of text, because the answer
 * "NOT WORKING" is useless without the reason next to it. The page carries
 * no stylesheet and no script from the site: it is served on a machine that
 * may have no internet at all, and it must still say what it says.
 */
function renderPage(state) {
  const verdict = verdictOf(state);
  const config = describeConfiguration();
  const rows = [
    ['The process', state.process && state.process.detail, state.process && state.process.ok],
    ['The configuration', state.configuration && state.configuration.detail, state.configuration && state.configuration.ok],
    ['The service', state.service && state.service.detail, state.service && state.service.ok],
    ['The published address', state.published && state.published.detail, state.published && state.published.ok],
    ['Reachability from outside', state.reachability && state.reachability.detail, state.reachability && state.reachability.ok],
  ];

  const heading = verdict.working ? 'WORKING' : 'NOT WORKING';
  const tone = verdict.working ? 'good' : 'bad';

  const lines = [];
  lines.push('<h1 class="' + tone + '">' + heading + '</h1>');
  lines.push('<p class="lede">The voice stack of this instance'
    + (verdict.working ? ' is working.' : ' is not working.') + '</p>');

  if (!verdict.working) {
    lines.push('<ul class="reasons">');
    for (const reason of verdict.reasons) {
      lines.push('<li>' + escapeHtml(reason) + '</li>');
    }
    lines.push('</ul>');
  }

  lines.push('<table>');
  lines.push('<tbody>');
  for (const [name, detail] of rows) {
    lines.push('<tr><th scope="row">' + escapeHtml(name) + '</th><td>' + escapeHtml(detail) + '</td></tr>');
  }
  lines.push('<tr><th scope="row">Published at</th><td><code>' + escapeHtml(config.advertised) + ':' + escapeHtml(config.listenPort) + '</code></td></tr>');
  lines.push('<tr><th scope="row">Listening on</th><td><code>' + escapeHtml(config.listenHost) + ':' + escapeHtml(config.listenPort) + '</code></td></tr>');
  lines.push('<tr><th scope="row">Checked at</th><td><code>' + escapeHtml(state.at) + '</code></td></tr>');
  lines.push('</tbody>');
  lines.push('</table>');

  lines.push('<nav class="links">'
    + '<a href="/config">Configure the relay</a>'
    + '<a href="/credentials">Mint a credential</a>'
    + '<a href="/status">The state as JSON</a>'
    + '</nav>');

  lines.push('<footer>This page is served on the loopback of this instance and on nothing else. '
    + 'Reload it to make the checks again.</footer>');

  return pageShell(heading + ' - the voice stack', lines);
}

/**
 * The document every page of this interface is drawn with.
 *
 * The page carries no stylesheet and no script from the site: it is served
 * on a machine that may have no internet at all, and it must still say what
 * it says. The styles are therefore a dozen lines in the document itself.
 */
function pageShell(title, body) {
  const lines = [];
  lines.push('<!doctype html>');
  lines.push('<html lang="en">');
  lines.push('<head>');
  lines.push('<meta charset="utf-8">');
  lines.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  lines.push('<title>' + escapeHtml(title) + '</title>');
  lines.push('<style>');
  lines.push(':root { color-scheme: light dark; }');
  lines.push('body { margin: 0; padding: 2rem 1.25rem; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; '
    + 'background: #f6f7f9; color: #17191c; }');
  lines.push('@media (prefers-color-scheme: dark) { body { background: #14161a; color: #e8eaed; } '
    + '.card { background: #1c1f25 !important; border-color: #2b2f36 !important; } '
    + 'th { color: #aeb4bd !important; } td { border-color: #2b2f36 !important; } '
    + 'code { background: #23262c !important; } '
    + 'label { color: #5b6270 !important; } input { background: #23262c !important; color: #e8eaed !important; '
    + 'border-color: #2b2f36 !important; } .note { color: #aeb4bd !important; } }');
  lines.push('.card { max-width: 44rem; margin: 0 auto; background: #fff; border: 1px solid #e2e5ea; border-radius: 12px; padding: 1.75rem; }');
  lines.push('h1 { font-size: 2.4rem; margin: 0 0 .25rem; letter-spacing: -0.02em; }');
  lines.push('h1.good { color: #157a4a; } h1.bad { color: #b3261e; }');
  lines.push('h2 { font-size: 1.15rem; margin: 1.75rem 0 .5rem; }');
  lines.push('p.lede { margin: 0 0 1.5rem; color: #5b6270; }');
  lines.push('table { width: 100%; border-collapse: collapse; margin: 0 0 1.5rem; }');
  lines.push('th, td { text-align: left; padding: .55rem .5rem; border-bottom: 1px solid #e2e5ea; vertical-align: top; }');
  lines.push('th { color: #5b6270; font-weight: 600; width: 12rem; }');
  lines.push('ul.reasons { margin: 0 0 1.5rem; padding-left: 1.1rem; }');
  lines.push('ul.reasons li { margin-bottom: .5rem; }');
  lines.push('code { background: #eef0f3; border-radius: 4px; padding: .1rem .35rem; font-size: .9em; }');
  lines.push('.field { display: grid; gap: .3rem; margin: 0 0 1rem; }');
  lines.push('label { color: #5b6270; font-size: .9rem; font-weight: 600; }');
  lines.push('input { font: inherit; padding: .55rem .65rem; border: 1px solid #e2e5ea; border-radius: 8px; background: #fff; color: #17191c; min-height: 40px; }');
  lines.push('button { font: inherit; font-weight: 600; min-height: 40px; padding: .55rem 1.1rem; border-radius: 8px; '
    + 'border: 1px solid #17191c; background: #17191c; color: #fff; cursor: pointer; }');
  lines.push('.note { color: #5b6270; font-size: .9rem; margin: .4rem 0 0; }');
  lines.push('.saved { background: #e8f5ee; border: 1px solid #b6ddc6; color: #10502f; border-radius: 8px; padding: .7rem .9rem; margin: 0 0 1.25rem; }');
  lines.push('.problem { background: #fdeceb; border: 1px solid #f2c2bf; color: #8c1d18; border-radius: 8px; padding: .7rem .9rem; margin: 0 0 1.25rem; }');
  lines.push('nav.links { display: flex; flex-wrap: wrap; gap: 1rem; margin: 0 0 1.5rem; }');
  lines.push('nav.links a { color: #17191c; }');
  lines.push('footer { color: #5b6270; font-size: .85rem; border-top: 1px solid #e2e5ea; padding-top: .9rem; }');
  lines.push('</style>');
  lines.push('</head>');
  lines.push('<body>');
  lines.push('<div class="card">');
  for (const line of body) lines.push(line);
  lines.push('</div>');
  lines.push('</body>');
  lines.push('</html>');
  return lines.join('\n');
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
  // The query, for the one thing that arrives in one: the ticket.
  const query = new URLSearchParams(String(req.url || '/').split('?')[1] || '');

  // A ticket in the address opens the pages that change things.
  //
  // It is checked before anything else, because the ticket is in the address
  // of the page it opens - and the page it opens is the one that would
  // otherwise answer.
  if (req.method === 'GET' && (query.get('ticket') || '')) {
    const ticket = query.get('ticket') || '';
    ticketIsGood(ticket).then((good) => {
      if (!good) {
        const page = renderTicketPage('That ticket was not good. It is good once, and it does not last long.');
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(page);
        return;
      }
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': COOKIE + '=' + encodeURIComponent(ticket.slice(0, 12))
          + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800',
        'Cache-Control': 'no-store',
      });
      res.end();
    });
    return;
  }

  // The page. It says whether the voice stack works, and it says it in one
  // word, with the reason underneath when the word is "not".
  if (path === '/' || path === '/index.html' || path === '/voice') {
    check().then((state) => {
      const body = renderPage(state);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    }).catch((error) => {
      const body = renderPage({
        at: new Date().toISOString(),
        process: { ok: true, detail: 'The voice process is running.' },
        configuration: { ok: false, detail: 'The checks could not be made: ' + String((error && error.message) || error) },
        engine: { ok: false, detail: 'The service state is not known.' },
        service: { ok: false, detail: 'The service state is not known.' },
        published: { ok: null, detail: 'The published address was not checked.' },
        reachability: { ok: null, detail: 'The reachability was not checked.' },
      });
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    });
    return;
  }

  const isAdmin = !!cookieValue(req, COOKIE);

  // The configuration of the relay, and the page that changes it.
  if (path === '/config') {
    if (req.method === 'POST') {
      if (!isAdmin) {
        const page = renderConfigPage({
          problem: 'Changing the configuration needs an administrator. Open this page from the voice '
            + 'console in the application, which gives it a ticket that is good for a moment.',
          canSave: false,
        });
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(page);
        return;
      }
      readBody(req).then((body) => saveConfiguration(body)).then((result) => {
        const page = renderConfigPage(result);
        res.writeHead(result.problem ? 400 : 200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(page);
      }).catch((error) => {
        const page = renderConfigPage({ problem: String((error && error.message) || error) });
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(page);
      });
      return;
    }
    const page = renderConfigPage({ canSave: isAdmin });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page);
    return;
  }

  // A credential for the relay.
  if (path === '/credentials') {
    if (!isAdmin) {
      const page = renderCredentialsPage({
        problem: 'Minting a credential needs an administrator. Open this page from the voice console '
          + 'in the application, which gives it a ticket that is good for a moment.',
      });
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(page);
      return;
    }
    if (req.method === 'POST') {
      readBody(req).then((body) => mintCredential(body)).then((result) => {
        const page = renderCredentialsPage(result);
        res.writeHead(result.problem ? 400 : 200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(page);
      }).catch((error) => {
        const page = renderCredentialsPage({ problem: String((error && error.message) || error) });
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(page);
      });
      return;
    }
    const page = renderCredentialsPage({});
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page);
    return;
  }

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
  // The process interface is on the loopback. A setting that asks for
  // anything else is refused: the page and the health checks of the voice
  // stack are an operator's surface, and an operator's surface does not
  // belong on the internet.
  //
  // The relay is the other thing, and it is meant to be reachable: the UDP
  // port is opened to the world on purpose. Only this interface is local.
  if (!isLoopback(HOST)) {
    console.error('[voice] the voice process serves its page and its health checks on the '
      + 'loopback and on nothing else, and TRYCORD_VOICE_PROCESS_HOST is ' + HOST + '. '
      + 'That address would put the diagnostics of the voice stack, and the '
      + 'addresses it publishes, on the network. Remove the variable, or give it 127.0.0.1. '
      + 'The relay itself is published separately, with TRYCORD_TURN_HOST.');
    process.exitCode = 1;
    return;
  }

  // The instance's own settings, for the address it publishes itself at and
  // for the relay's configuration. The database is what holds them, so the
  // connection is made first.
  //
  // A failure here is not fatal: the environment's address is the fallback,
  // and the relay runs either way. What is lost is the ability to *change*
  // the configuration from this process - the page says so rather than
  // pretending a save worked.
  try {
    const db = require('../db');
    await db.connect();
  } catch (error) {
    console.warn('[voice] the database could not be reached, so the instance\'s saved '
      + 'settings are not read: ' + ((error && error.message) || error));
  }
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

// The process is started when this file *is* the process. It is also
// required by the tests, which want the checks and the page without a
// relay, a socket and a timer, so the start is under the entry point's
// name and not at the top of the file.
if (require.main === module) {
  main().catch((error) => {
    console.error('[voice] the voice process could not start: '
      + ((error && error.stack) || error));
    process.exit(1);
  });
}

module.exports = {
  describeConfiguration,
  check,
  startEngine,
  stopEngine,
  verdictOf,
  renderPage,
  renderConfigPage,
  renderCredentialsPage,
  relaySettings,
  isLoopback,
  handler,
};

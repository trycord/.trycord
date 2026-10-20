// The relay the mesh reaches a peer through.
//
// Two things live here. The first is the reachability probe: a STUN binding
// request sent to an address, and the answer that says the address is alive.
// It is the check behind "the mesh cannot start a session", so it has to be a
// real exchange rather than a setting that was saved.
//
// The second is the in-house relay's lifecycle. The instance ships a STUN and
// TURN server (services/turn.js) and nothing else starts it, so the voice
// subsystem does: an instance whose mesh has no other way to reach a peer needs
// the relay it already runs.
//
// The credential for that relay is minted from the in-house secret and handed
// only to a session that belongs to the caller. The secret itself never leaves
// the process.

'use strict';

const dgram = require('dgram');
const crypto = require('crypto');
const turn = require('../turn');

const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_RESPONSE = 0x0101;

// How long a reachability probe waits for an answer when the deployment has
// not said otherwise. A STUN binding request is one datagram to a host that
// may or may not answer; a couple of seconds is long enough for a working
// path and short enough that a dead one does not hold a join.
const DEFAULT_TIMEOUT_MS = 2000;

// How long a probe waits for an answer. A deployment with a slow path can
// give it longer; a test that is waiting on a closed port can give it less.
function probeTimeout() {
  const configured = Number(process.env.TRYCORD_VOICE_PROBE_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 100) return configured;
  return DEFAULT_TIMEOUT_MS;
}

// An ICE server address, split into the parts a probe needs.
//
// The forms in the wild are stun:host, stun:host:port, turn:host:port and
// turn:host:port?transport=udp. A turns: address is TLS, which this probe
// cannot speak, and is reported as such rather than as a failure to answer.
function parseIceUrl(url) {
  const raw = String(url || '').trim();
  const match = /^(stun|stuns|turn|turns):(.+)$/i.exec(raw);
  if (!match) return null;

  const scheme = match[1].toLowerCase();
  const rest = match[2].split('?')[0];
  const parts = rest.split(':');
  let host = parts[0] || '';
  let port = null;

  if (parts.length > 1) {
    const parsed = Number(parts[parts.length - 1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      port = parsed;
      host = parts.slice(0, -1).join(':');
    }
  }
  host = host.replace(/^\[|\]$/g, '');
  if (!host) return null;
  if (!port) port = scheme === 'stun' || scheme === 'stuns' ? 3478 : 3478;

  return { scheme, host, port, url: raw };
}

function bindingRequest(transactionId) {
  const message = Buffer.alloc(20);
  message.writeUInt16BE(BINDING_REQUEST, 0);
  message.writeUInt16BE(0, 2);
  message.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(message, 8);
  return message;
}

// Ask an address whether it is there.
//
// The answer is a binding response carrying the transaction id that was sent,
// so a stray packet cannot be mistaken for one. A timeout is a failure to
// answer, and is reported as such: an address that does not answer is not a
// relay, however well it is configured.
function probeAddress(url, timeoutMs) {
  const target = parseIceUrl(url);
  if (!target) {
    return Promise.resolve({ ok: false, url: String(url || ''), detail: 'That is not an ICE server address.' });
  }
  if (target.scheme === 'stuns' || target.scheme === 'turns') {
    return Promise.resolve({
      ok: false,
      url: target.url,
      detail: 'That address needs TLS, which this probe cannot speak.',
    });
  }

  const timeout = timeoutMs || probeTimeout();

  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const transactionId = crypto.randomBytes(12);
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(Object.assign({ url: target.url, host: target.host, port: target.port }, result));
    };

    const timer = setTimeout(() => finish({
      ok: false,
      detail: 'Nothing answered a binding request at ' + target.host + ':' + target.port + '.',
    }), timeout);

    socket.on('message', (message) => {
      if (message.length < 20) return;
      if (message.readUInt16BE(0) !== BINDING_RESPONSE) return;
      if (!message.slice(8, 20).equals(transactionId)) return;
      finish({ ok: true, detail: 'The address answered a binding request at ' + target.host + ':' + target.port + '.' });
    });

    socket.on('error', (error) => finish({
      ok: false,
      detail: (error && error.message) || 'The address could not be reached.',
    }));

    socket.send(bindingRequest(transactionId), target.port, target.host, (error) => {
      if (error) finish({ ok: false, detail: error.message });
    });
  });
}

// The in-house relay, and whether this process is running it.
//
// The socket is kept here rather than in the relay module, which starts a
// server and forgets its handle: without it the server could not be stopped
// again.
let inHouse = null;
let starting = null;

// The voice process, when one is running.
//
// The answer is a small description of the service it is already running:
// the address it listens on, the address it publishes, and the fact that it
// is somebody else's socket, so nobody here tries to close it.
async function managedElsewhere() {
  const port = Number(process.env.TRYCORD_VOICE_PROCESS_PORT || 9973);
  const host = String(process.env.TRYCORD_VOICE_PROCESS_HOST || '127.0.0.1').trim();
  if (!port || !host) return null;

  let answer;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    answer = await fetch(`http://${host}:${port}/status`, { signal: controller.signal });
    clearTimeout(timer);
  } catch {
    // No voice process, or it is not answering. The API starts its own.
    return null;
  }
  if (!answer.ok) return null;

  let state = null;
  try { state = await answer.json(); } catch { return null; }
  const engine = state && state.engine;
  if (!engine || !engine.running) return null;

  return {
    host: String(engine.host || '0.0.0.0'),
    port: Number(engine.port || 3478),
    realm: String(engine.realm || 'trycord-turn'),
    running: true,
    socket: null,
    startedAt: Date.now(),
    managed: 'the voice process',
    reason: '',
  };
}

// Whether the port is free.
//
// A port that is already taken belongs to something else - another instance on
// the machine, or a relay the operator runs - and starting a second server on
// it would fail and leave an error in the log.
function portIsFree(host, port) {
  return new Promise((resolve) => {
    const probe = dgram.createSocket('udp4');
    probe.once('error', () => resolve(false));
    try {
      probe.bind(port, host, () => {
        probe.close(() => resolve(true));
      });
    } catch {
      resolve(false);
    }
  });
}

async function ensureInHouse() {
  if (inHouse) return inHouse;
  if (starting) return starting;

  // The voice process owns the STUN and TURN service when it is running.
  //
  // The two used to compete: the API started a relay of its own and the
  // voice process started one too, and the second one to bind the port
  // failed - so the process that reported the relay as "running" was the one
  // that had lost it. The API asks the voice process first, and only starts
  // a relay of its own when there is no voice process to ask. A deployment
  // that runs the API on its own - a test, a development machine - still
  // works exactly as it did.
  const managed = await managedElsewhere();
  if (managed) {
    inHouse = managed;
    return inHouse;
  }

  starting = (async () => {
    // The relay listens on the loopback unless the operator names an address.
  // It is a service of this instance, and it does not need to be on every
  // interface.
  const host = String(process.env.TRYCORD_TURN_HOST || '127.0.0.1').trim();
    const port = Number(process.env.TRYCORD_TURN_PORT || 3478);
    const realm = String(process.env.TRYCORD_TURN_REALM || 'trycord-turn');
    const listenPort = Number.isFinite(port) && port > 0 ? port : 3478;

    const free = await portIsFree(host === '0.0.0.0' ? '0.0.0.0' : host, listenPort);
    if (!free) {
      // Something else is on the port. The address is still the one to
      // advertise; the probe is what decides whether anything answers there.
      inHouse = {
        host,
        port: listenPort,
        realm,
        running: false,
        socket: null,
        startedAt: null,
        reason: 'the port is already in use, so another server answers there',
      };
      starting = null;
      return inHouse;
    }

    let socket = null;
    let started = true;
    try {
      socket = turn.start({ host, port: listenPort });
      // The relay belongs to the process, not the other way about: it must not
      // be the reason the process refuses to stop.
      if (socket && typeof socket.unref === 'function') socket.unref();
    } catch (error) {
      started = false;
      socket = null;
    }

    inHouse = {
      host,
      port: listenPort,
      realm,
      running: started,
      socket,
      startedAt: started ? Date.now() : null,
      reason: started ? '' : 'the relay could not be started',
    };
    starting = null;
    return inHouse;
  })();

  return starting;
}

function inHouseState() {
  if (!inHouse) return null;
  return {
    running: inHouse.running,
    host: inHouse.host,
    port: inHouse.port,
    realm: inHouse.realm,
    startedAt: inHouse.startedAt,
    reason: inHouse.reason || '',
    // Who owns the socket. The voice process owns it when it is running, and
    // this process must not close a socket it did not open.
    managed: inHouse.managed || 'this process',
  };
}

// Stop the relay this process started.
//
// A relay the voice process owns is left alone: it is not this process's
// socket, and closing it would take the service down for everybody.
function stopInHouse() {
  if (!inHouse) return;
  if (inHouse.managed && inHouse.managed !== 'this process') {
    inHouse = null;
    return;
  }
  if (inHouse.socket) {
    try { inHouse.socket.close(); } catch { /* already closed */ }
  }
  inHouse = null;
}

module.exports = {
  parseIceUrl,
  probeAddress,
  ensureInHouse,
  inHouseState,
  stopInHouse,
  DEFAULT_TIMEOUT_MS,
};

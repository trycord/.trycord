// Helpers for the Continuum tests.
//
// The tests here are about two instances that actually talk to each other:
// separate databases, separate signing keys, separate ports. Nothing in this
// file stubs the network - a peer that is not there is a peer that is not
// there, and the delivery fails for real.

'use strict';

const http = require('http');
const crypto = require('crypto');
const { startInstance, apiClient, registerUser } = require('../helpers/instance');

// Federation on, local addresses allowed (the instances under test live on
// the loopback interface), and a short feed interval so a change is noticed
// while the test is still looking at it.
const FEDERATION_ENV = {
  CONTINUUM_ENABLED: 'on',
  CONTINUUM_ALLOW_LOCALHOST: 'true',
  CONTINUUM_FEED_INTERVAL_MS: '300',
};

/**
 * Start an instance that federates.
 *
 * @param {string} instanceId  the instance's own id, unique to this run
 * @param {object} [env]       extra environment
 */
async function startFederatedInstance(instanceId, env) {
  const instance = await startInstance({
    jobs: true,
    env: Object.assign(
      {},
      FEDERATION_ENV,
      { TRYCORD_INSTANCE_ID: instanceId, ADMIN_USERNAMES: 'operator' },
      env || {}
    ),
  });
  // The modules of this instance, captured now.
  //
  // Starting another instance clears the module cache, and the shared code
  // reaches for a module at request time in one place (the channel lookup by
  // slug). After that clear, such a lookup finds the other instance's copy
  // and reads the other instance's database. Holding this instance's own
  // modules here means a test can act on this instance directly.
  instance.modules = {
    db: require('../../src/db'),
    continuum: require('../../src/services/continuum'),
    permissions: require('../../src/services/permissions'),
    rules: require('../../src/services/continuum/rules'),
    relay: require('../../src/services/continuum/relay'),
    ledger: require('../../src/services/continuum/ledger'),
    store: require('../../src/services/continuum/store'),
    inbound: require('../../src/services/continuum/inbound'),
    feed: require('../../src/services/continuum/feed'),
  };
  return instance;
}

/** The public discovery document of an instance. */
async function discoveryOf(instance) {
  const res = await apiClient(instance.baseUrl).get('/.well-known/trycord');
  if (!res.ok) throw new Error('the discovery document was not served: ' + res.status);
  return res.data;
}

/**
 * Make two instances peers of each other, the way an operator would: read
 * the discovery document of each, add the other as a peer, and trust it.
 */
async function peerInstances(a, b, adminA, adminB) {
  const docA = await discoveryOf(a);
  const docB = await discoveryOf(b);

  const addedToA = await adminA.post('/api/continuum/instances', {
    id: docB.instance_id, name: 'instance ' + docB.instance_id, origin: b.baseUrl, public_key: docB.public_key,
  });
  if (addedToA.status !== 201) {
    throw new Error('could not add the peer: ' + addedToA.status + ' ' + JSON.stringify(addedToA.data));
  }
  const addedToB = await adminB.post('/api/continuum/instances', {
    id: docA.instance_id, name: 'instance ' + docA.instance_id, origin: a.baseUrl, public_key: docA.public_key,
  });
  if (addedToB.status !== 201) {
    throw new Error('could not add the peer: ' + addedToB.status + ' ' + JSON.stringify(addedToB.data));
  }

  const trustA = await adminA.patch('/api/continuum/instances/' + docB.instance_id + '/trust', {
    trust_status: 'trusted',
  });
  if (!trustA.ok) throw new Error('could not trust the peer: ' + JSON.stringify(trustA.data));
  const trustB = await adminB.patch('/api/continuum/instances/' + docA.instance_id + '/trust', {
    trust_status: 'trusted',
  });
  if (!trustB.ok) throw new Error('could not trust the peer: ' + JSON.stringify(trustB.data));

  return { docA, docB };
}

/**
 * A peer that records what it is sent.
 *
 * It is a real HTTP server with a real key pair, so an instance can add it
 * as a peer and trust it exactly as it would any other instance. What it is
 * for is the raw envelope: the test needs to replay one, and the outbox does
 * not keep the signature.
 */
async function startCapturePeer(instanceId) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const received = [];

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/trycord') {
      const body = JSON.stringify({
        instance_id: instanceId,
        protocol: 'trycord-continuum',
        protocol_version: '1.1',
        capabilities: ['event_delivery', 'event_receipt'],
        public_key: publicKeyPem,
        enabled: true,
        communities: [],
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/continuum/inbox') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        try {
          received.push(JSON.parse(raw));
        } catch {
          res.writeHead(400).end('not json');
          return;
        }
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(404).end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    instanceId,
    origin: 'http://127.0.0.1:' + port,
    publicKey: publicKeyPem,
    received,
    /** The envelopes received so far, oldest first. */
    envelopes() { return received.slice(); },
    /** The first envelope of a kind, if one has arrived. */
    envelopeOfKind(kind) { return received.find((envelope) => envelope.kind === kind) || null; },
    /**
     * Sign an envelope the way a peer signs one: every field except the
     * signature and the key id, in a stable order.
     */
    sign(envelope) {
      const signed = Object.assign({}, envelope);
      const { signature, key_id, ...rest } = signed;
      signed.signature = crypto
        .sign(null, Buffer.from(JSON.stringify(rest, Object.keys(rest).sort()), 'utf8'), privateKey)
        .toString('base64');
      signed.key_id = key_id || instanceId;
      return signed;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A port nothing is listening on: an origin that cannot be reached. */
async function closedPort() {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Wait for a condition to hold.
 *
 * @param {Function} check   returns something truthy when the condition holds
 * @param {object}   [options]
 */
async function waitFor(check, options = {}) {
  const timeout = options.timeout || 20000;
  const interval = options.interval || 100;
  const started = Date.now();
  let lastError = null;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
      lastError = null;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() - started > timeout) {
      const detail = lastError ? ': ' + lastError.message : '';
      throw new Error('timed out waiting for ' + (options.message || 'the condition') + detail);
    }
    await sleep(interval);
  }
}

/**
 * The outbox events of this instance that are about one message.
 *
 * The event list is a summary; the detail is what says which message an
 * event is about, so that is what this looks at.
 */
async function eventsAboutMessage(admin, messageId) {
  const list = await admin.get('/api/continuum/events?limit=200');
  if (!list.ok) return [];
  const found = [];
  for (const row of list.data) {
    const detail = await admin.get('/api/continuum/events/' + row.id);
    if (!detail.ok) continue;
    const payload = detail.data.payload || {};
    if (payload.origin && payload.origin.message_origin_id === messageId) {
      found.push(detail.data);
    }
  }
  return found;
}

module.exports = {
  FEDERATION_ENV,
  startFederatedInstance,
  discoveryOf,
  peerInstances,
  startCapturePeer,
  sleep,
  closedPort,
  waitFor,
  eventsAboutMessage,
  registerUser,
};

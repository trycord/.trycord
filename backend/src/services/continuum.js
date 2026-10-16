// Community Continuum: real opt-in federation between compatible Trycord
// instances.
//
// Events are JSON envelopes signed with Ed25519 (node:crypto, a maintained
// standard library - no custom cryptography). They are delivered over HTTPS
// POST to remote inboxes, retried with bounded backoff and jitter, and
// deduplicated on receipt by event id. Continuum is opt-in: when the
// continuum.enabled feature flag is off, none of this runs and a local-only
// instance is fully functional.
//
// Event envelope:
//
//   {
//     id:        uuid - stable event id, used for deduplication
//     kind:      string - 'community.created', 'message.posted', ...
//     actor:     string|null - local user id who triggered it
//     target:    string|null - community/channel/message id it concerns
//     timestamp: ISO-8601 string
//     payload:   object - event-specific data
//     signature: string - base64 Ed25519 signature of the canonical envelope
//     key_id:    string - this instance's id, so the receiver knows which key
//   }
//
// The signature covers the envelope with the signature field removed, so a
// receiver can verify the sender without trusting the transport.

const crypto = require('crypto');
const db = require('../db');
const { now, uuid } = require('../util');
const features = require('../features');
const jobs = require('./jobs');

// Continuum is opt-in. Checked on every operation; when disabled the instance
// never sends or receives federation events.
function enabled() {
  try {
    return features.current.continuum === true;
  } catch { return false; }
}

// This instance's stable id. Derived from the instance id setting at boot.
let instanceId = null;
// Ed25519 key pair for signing outgoing events and verifying incoming ones.
let keyPair = null;
let publicKeyPem = null;

function setInstanceId(id) { instanceId = id; }

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  keyPair = privateKey;
  return { publicKey: publicKeyPem, privateKey };
}

function getPublicKey() { return publicKeyPem; }

// Canonical envelope for signing: all fields except signature and key_id,
// key order stable, no whitespace variations. key_id is envelope metadata
// (which public key to use), not content covered by the signature.
function canonical(event) {
  const { signature, key_id, ...rest } = event;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

function signEvent(event) {
  if (!keyPair) throw new Error('continuum key pair not generated');
  return crypto.sign(null, Buffer.from(canonical(event), 'utf8'), keyPair).toString('base64');
}

function verifyEvent(event, publicKeyPem) {
  if (!event || !event.signature || !event.key_id) return false;
  return crypto.verify(null, Buffer.from(canonical(event), 'utf8'), publicKeyPem, Buffer.from(event.signature, 'base64'));
}

// Enqueue an event in the durable outbox. The job system picks it up and
// delivers it to all trusted remote instances.
async function enqueueEvent(kind, payload, { actorId, targetId } = {}) {
  if (!enabled()) return null;
  const id = uuid();
  const event = {
    id, kind, actor: actorId || null, target: targetId || null,
    timestamp: now(), payload,
  };
  event.signature = signEvent(event);
  event.key_id = instanceId;
  await db.run(
    'INSERT INTO continuum_events (id, kind, actor_id, target_id, payload, status, attempts, max_attempts, backoff_ms, run_after, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, kind, actorId || null, targetId || null, JSON.stringify(payload), 'pending', 0, 5, 1000, now(), now(), now()]
  );
  // Wake the delivery job system.
  await jobs.enqueue('continuum_deliver', { eventId: id }, { maxAttempts: 1, backoffMs: 0 });
  return id;
}

// Remote instance registry --------------------------------------------------

async function addInstance(id, name, origin, publicKey) {
  if (!enabled()) throw new Error('Continuum is disabled');
  if (!origin.match(/^https?:\/\//)) throw new Error('origin must be http(s)');
  await db.run(
    'INSERT INTO continuum_instances (id, name, origin, public_key, trust_status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, name, origin, publicKey, 'pending', now()]
  );
  return { id, name, origin, trust_status: 'pending' };
}

async function listInstances() {
  return db.all('SELECT * FROM continuum_instances ORDER BY created_at DESC');
}

async function setTrust(instanceId, trustStatus) {
  const valid = ['trusted', 'blocked', 'pending'];
  if (!valid.includes(trustStatus)) throw new Error('invalid trust status');
  await db.run('UPDATE continuum_instances SET trust_status = ? WHERE id = ?', [trustStatus, instanceId]);
  return { id: instanceId, trust_status: trustStatus };
}

// Discovery ------------------------------------------------------------------

// Public discovery document. No secrets here: instance id, origin, public key,
// supported protocol versions and capabilities. Anything an operator wants
// public goes here; everything else stays behind the admin authentication.
function discovery() {
  return {
    instance_id: instanceId,
    protocol: 'trycord-continuum',
    protocol_version: '1.0',
    capabilities: ['event_delivery', 'event_receipt'],
    public_key: publicKeyPem,
    enabled: enabled(),
  };
}

// Inbound --------------------------------------------------------------------

// Receive an event from a remote instance. Verifies the signature against the
// sending instance's declared key_id (cryptographically bound to the envelope,
// not the transport IP), rejects replays (already-seen event id), and stores
// it idempotently. Returns the stored event or null if it was a duplicate.
async function receiveEvent(envelope) {
  if (!enabled()) return null;
  if (!envelope || !envelope.key_id) return null;
  const instance = await db.get('SELECT * FROM continuum_instances WHERE id = ?', [envelope.key_id]);
  if (!instance) return null;
  if (!verifyEvent(envelope, instance.public_key)) return null;
  // Idempotency: an event we have already seen is never processed again.
  const existing = await db.get('SELECT 1 FROM continuum_inbox WHERE event_id = ?', [envelope.id]);
  if (existing) return null;
  await db.run(
    'INSERT INTO continuum_inbox (event_id, instance_id, kind, payload, received_at, processed) VALUES (?, ?, ?, ?, ?, 0)',
    [envelope.id, instance.id, envelope.kind, JSON.stringify(envelope.payload), now()]
  );
  return { id: envelope.id, kind: envelope.kind, payload: envelope.payload };
}

// Outbox delivery ------------------------------------------------------------

// Deliver one event to one remote instance. Returns true on success.
async function deliverEventToInstance(event, instance) {
  const envelope = {
    id: event.id, kind: event.kind, actor: event.actor_id, target: event.target_id,
    timestamp: event.created_at, payload: JSON.parse(event.payload || '{}'),
    signature: event.signature || signEvent({
      id: event.id, kind: event.kind, actor: event.actor_id, target: event.target_id,
      timestamp: event.created_at, payload: JSON.parse(event.payload || '{}'),
    }),
    key_id: instanceId,
  };
  try {
    const res = await fetch(`${instance.origin}/api/continuum/inbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-instance-id': instanceId },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      await db.run(
        'INSERT INTO continuum_deliveries (id, event_id, instance_id, status, attempted_at) VALUES (?, ?, ?, ?, ?)',
        [uuid(), event.id, instance.id, 'delivered', now()]
      );
      return true;
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    await db.run(
      'INSERT INTO continuum_deliveries (id, event_id, instance_id, status, attempted_at, error) VALUES (?, ?, ?, ?, ?, ?)',
      [uuid(), event.id, instance.id, 'failed', now(), String(e && e.message || e).slice(0, 500)]
    );
    return false;
  }
}

// Process one due outbox event: deliver to all trusted instances, then mark
// done or reschedule with backoff. Registered as the 'continuum_deliver' job
// type in server.js boot.
async function deliverEvent(payload) {
  const { eventId } = payload || {};
  if (!eventId) return;
  const event = await db.get('SELECT * FROM continuum_events WHERE id = ?', [eventId]);
  if (!event) return;
  if (event.status !== 'pending') return;

  const instances = await db.all("SELECT * FROM continuum_instances WHERE trust_status = 'trusted'");
  let anySent = false;
  for (const instance of instances) {
    const sent = await deliverEventToInstance(event, instance);
    if (sent) anySent = true;
  }

  const attempts = event.attempts + 1;
  if (anySent || attempts >= event.max_attempts) {
    await db.run(
      'UPDATE continuum_events SET status = ?, attempts = ?, updated_at = ? WHERE id = ?',
      [anySent ? 'delivered' : 'failed', attempts, now(), eventId]
    );
  } else {
    let backoff = event.backoff_ms * 2;
    if (backoff > 3600000) backoff = 3600000;
    const jitter = Math.floor(Math.random() * backoff / 2);
    await db.run(
      'UPDATE continuum_events SET status = ?, attempts = ?, backoff_ms = ?, run_after = ?, updated_at = ? WHERE id = ?',
      ['pending', attempts, backoff, new Date(Date.now() + backoff + jitter).toISOString(), now(), eventId]
    );
    // Re-enqueue for retry.
    await jobs.enqueue('continuum_deliver', { eventId }, { maxAttempts: 1, backoffMs: backoff + jitter });
  }
}

module.exports = {
  enabled,
  setInstanceId,
  generateKeyPair,
  getPublicKey,
  signEvent,
  verifyEvent,
  enqueueEvent,
  addInstance,
  listInstances,
  setTrust,
  discovery,
  receiveEvent,
  deliverEvent,
};

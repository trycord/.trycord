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
//     kind:      string - one of the kinds in services/continuum/events.js
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
//
// The relay is split by concern under ./continuum:
//
//   events.js             the vocabulary: what kinds exist and what they carry
//   rules.js              what may leave this instance at all
//   relay.js              the publisher: rules, ledger and payload building
//   feed.js               the change feed that finds what has changed
//   inbound.js            the inbound checks and the relay store
//   store.js              the relay store and the remote community registry
//   remote-communities.js the communities a peer federates
//   membership.js         joining and leaving a remote community
//   outgoing.js           writing in a community that lives elsewhere
//   moderation.js         moderating what a member of these communities wrote
//   ledger.js             what has already been federated
//   sequences.js          the per-actor sequence numbers
//   guard.js              where this instance is allowed to reach out to

const crypto = require('crypto');
const db = require('../db');
const { now, uuid } = require('../util');
const features = require('../features');
const jobs = require('./jobs');
const realtime = require('./events');
const events = require('./continuum/events');
const feed = require('./continuum/feed');
const guard = require('./continuum/guard');
const identity = require('./continuum/identity');
const inbound = require('./continuum/inbound');
const ledger = require('./continuum/ledger');
const membership = require('./continuum/membership');
const moderation = require('./continuum/moderation');
const outgoing = require('./continuum/outgoing');
const relay = require('./continuum/relay');
const remoteCommunities = require('./continuum/remote-communities');
const sequences = require('./continuum/sequences');
const store = require('./continuum/store');

// Continuum is opt-in. Checked on every operation; when disabled the instance
// never sends or receives federation events.
function enabled() {
  try {
    return features.current.continuum === true;
  } catch { return false; }
}

// Ed25519 key pair for signing outgoing events and verifying incoming ones.
let keyPair = null;
let publicKeyPem = null;

function setInstanceId(id) { identity.setInstanceId(id); }

// A fresh key pair, for an instance that has never had one. The pair this
// instance actually uses is the persisted one (loadPersistedKeys), because a
// key that changed on every boot would strand every peer relationship.
function prepareKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  keyPair = privateKey;
  return { publicKey: publicKeyPem, privateKey };
}

// Restore signing identity that survives restarts. A federation relationship
// whose public key changes on every boot would strand remote instances: their
// stored copy of our key would no longer verify our signatures, and every
// delivery would be rejected until an operator re-copied a new key. The pair
// is therefore generated once and persisted (continuum_keys, one row), and
// reloaded at every boot - whether or not federation is currently enabled, so
// an administrator can turn Continuum on at runtime without first restarting
// the process.
async function loadPersistedKeys() {
  let persisted = false;
  const row = await db.get('SELECT private_key FROM continuum_keys WHERE id = 1');
  if (row && row.private_key) {
    try {
      const restored = crypto.createPrivateKey(String(row.private_key));
      const certificate = crypto.createPublicKey(restored).export({ type: 'spki', format: 'pem' });
      keyPair = restored;
      publicKeyPem = certificate;
      persisted = true;
    } catch (e) {
      // Unreadable stored key (corruption or manual edits): regenerate below
      // rather than failing the boot.
    }
  }
  if (!persisted) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    keyPair = privateKey;
    publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const pem = keyPair.export({ type: 'pkcs8', format: 'pem' });
    await db.run('DELETE FROM continuum_keys WHERE id = 1');
    await db.run(
      'INSERT INTO continuum_keys (id, private_key, created_at) VALUES (1, ?, ?)',
      [pem, now()]
    );
  }
  // The database is connected by the time the boot gets here, so the change
  // feed can be queued now.
  await scheduleFeed();
  return { persisted };
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

// Remote instance registry --------------------------------------------------

// The rules that decide where this instance may reach live in one place
// (services/continuum/guard.js) so the federation probe, the delivery path
// and the discovery reader cannot drift apart.
function validateOrigin(origin) {
  return guard.validateOrigin(origin);
}

async function addInstance(id, name, origin, publicKey) {
  if (!enabled()) throw new Error('Continuum is disabled');
  const safeOrigin = await validateOrigin(origin);
  // Never trust a public key that looks like a private key/secret.
  if (String(publicKey).includes('PRIVATE KEY')) throw new Error('public key must not be a private key');
  await db.run(
    'INSERT INTO continuum_instances (id, name, origin, public_key, trust_status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, name, safeOrigin, publicKey, 'pending', now()]
  );
  return { id, name, origin: safeOrigin, trust_status: 'pending' };
}

async function listInstances() {
  return db.all('SELECT * FROM continuum_instances ORDER BY created_at DESC');
}

// Remove a peer. Its events are refused from then on: an instance that is no
// longer known is not one whose signatures mean anything here.
//
// The communities that lived on it are revoked rather than deleted: they were
// here, they are on record, and the relationship is over.
async function removeInstance(id) {
  const existing = await db.get('SELECT id FROM continuum_instances WHERE id = ?', [id]);
  if (!existing) throw { code: 'NOT_FOUND', message: 'no such instance' };
  await db.run('DELETE FROM continuum_instances WHERE id = ?', [id]);
  await db.run(
    "UPDATE continuum_communities SET state = 'revoked', updated_at = ? WHERE origin_instance_id = ?",
    [now(), String(id)]
  );
  return { ok: true, id: String(id) };
}

// Operator-facing diagnostics: the durable outbox (what was sent, what is
// failing, what has been abandoned) and the inbox (what arrived from remote
// instances, processed or not). Bounded lists - an instance that runs for
// months should not paste thousands of rows into a console.
async function listEvents(limit) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return db.all(
    'SELECT id, kind, status, attempts, max_attempts, error, created_at, updated_at '
    + 'FROM continuum_events ORDER BY created_at DESC LIMIT ' + cap
  );
}

// One event in full, for an operator who wants to see what was actually sent.
async function getEvent(id) {
  const row = await db.get('SELECT * FROM continuum_events WHERE id = ?', [id]);
  if (!row) return null;
  return { ...row, payload: safeParse(row.payload) };
}

function safeParse(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

async function listInbox(limit) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return db.all(
    'SELECT event_id, instance_id, kind, processed, received_at '
    + 'FROM continuum_inbox ORDER BY received_at DESC LIMIT ' + cap
  );
}

// The delivery status per event and per destination.
//
// The deliveries table is the attempt log; this is what it adds up to. A
// destination that has reached the event is 'delivered', one that is still
// being retried is 'pending' with the last error, and one whose attempts are
// spent is 'failed' with the reason it failed.
async function listDeliveries({ eventId, limit } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = eventId
    ? await db.all(
      'SELECT * FROM continuum_deliveries WHERE event_id = ? ORDER BY attempted_at DESC LIMIT ' + cap,
      [String(eventId)]
    )
    : await db.all('SELECT * FROM continuum_deliveries ORDER BY attempted_at DESC LIMIT ' + cap);

  const byTarget = new Map();
  for (const row of rows) {
    const key = row.event_id + '|' + row.instance_id;
    const entry = byTarget.get(key) || {
      event_id: row.event_id,
      instance_id: row.instance_id,
      attempts: 0,
      status: 'pending',
      error: null,
      last_attempt_at: null,
      delivered: false,
    };
    entry.attempts += 1;
    if (row.status === 'delivered') entry.delivered = true;
    if (!entry.last_attempt_at || row.attempted_at > entry.last_attempt_at) {
      entry.last_attempt_at = row.attempted_at;
      entry.error = row.error || null;
      entry.status = row.status;
    }
    byTarget.set(key, entry);
  }

  const eventIds = [...new Set([...byTarget.values()].map((entry) => entry.event_id))];
  const events2 = eventIds.length
    ? await db.all(
      'SELECT id, status FROM continuum_events WHERE id IN (' + eventIds.map(() => '?').join(',') + ')',
      eventIds
    )
    : [];
  const eventStatus = new Map(events2.map((row) => [row.id, row.status]));

  // A destination that has not been tried yet is still a target, and it is
  // pending until it is.
  for (const id of eventIds) {
    const event = await db.get('SELECT * FROM continuum_events WHERE id = ?', [id]);
    if (!event) continue;
    for (const target of await deliveryTargets(event)) {
      const key = id + '|' + target.id;
      if (byTarget.has(key)) continue;
      byTarget.set(key, {
        event_id: id,
        instance_id: String(target.id),
        attempts: 0,
        status: 'pending',
        error: null,
        last_attempt_at: null,
        delivered: false,
      });
    }
  }

  for (const entry of byTarget.values()) {
    if (entry.delivered) entry.status = 'delivered';
    else if (eventStatus.get(entry.event_id) === 'failed') entry.status = 'failed';
    else entry.status = 'pending';
    delete entry.delivered;
  }
  return [...byTarget.values()].sort((a, b) => String(b.last_attempt_at).localeCompare(String(a.last_attempt_at)));
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
//
// The communities this instance federates are part of it: only the public
// ones, and only the channels the members may post in. A peer reads this
// document to learn what can be federated with, and an operator reads it to
// see what this instance exposes.
//
// A community that has withdrawn from federation is not among them, and not
// among the channels it exposes: the rules decide, and the rules are asked
// for every community in the list. So a community that is turned off leaves
// this document without anything else having to know about it.
async function discovery() {
  return {
    instance_id: identity.getInstanceId(),
    protocol: 'trycord-continuum',
    // 1.2 is the version that carries the return direction: a message a
    // member writes on another instance, the owner's answer about it, and
    // the owner changing a member's standing. A peer that speaks 1.1 does
    // not know those kinds and refuses them.
    protocol_version: '1.2',
    capabilities: ['event_delivery', 'event_receipt', 'community_relay', 'member_relay'],
    public_key: publicKeyPem,
    enabled: enabled(),
    communities: enabled() ? await remoteCommunities.federatedCommunities() : [],
  };
}

// Publication ---------------------------------------------------------------

// How many times a delivery is attempted before it is given up on, and how
// long the first wait between attempts is. Both are read from the environment
// so an operator can tune them, and so a verification run can watch a
// failure arrive quickly.
function maxAttempts() {
  const value = Number(process.env.CONTINUUM_MAX_ATTEMPTS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 5;
}

function retryBaseMs() {
  const value = Number(process.env.CONTINUUM_RETRY_BASE_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1000;
}

// Enqueue an event in the durable outbox. The job system picks it up and
// delivers it to the trusted remote instances.
//
// This is the only way an event leaves this instance, so it is also where
// the relay rules are applied: an event that may not be federated is not
// written to the outbox at all, and the caller is told why.
async function enqueueEvent(kind, payload, opts = {}) {
  const result = await publishEvent(kind, payload, opts);
  return result.ok ? result.eventId : null;
}

// The same publication, with the outcome in full: whether it was published,
// and why not if it was not.
async function publishEvent(kind, payload, opts = {}) {
  if (!enabled()) return { ok: false, reason: 'federation is disabled' };
  let prepared;
  try {
    prepared = await relay.prepare(kind, payload, opts);
  } catch (e) {
    return { ok: false, reason: 'the event could not be prepared: ' + (e && e.message) };
  }
  if (!prepared.ok) {
    // A row that the rules decided against is recorded as decided against.
    // What was not federable when it was written is not federated later, and
    // the ledger is where that is kept - whether the refusal came from the
    // change feed or from a publication asked for directly.
    if (prepared.withhold && prepared.source) {
      await ledger.markWithheld(
        prepared.source.kind, prepared.source.id, prepared.source.fingerprint,
        prepared.reason
      );
    }
    return {
      ok: false,
      reason: prepared.reason,
      withhold: !!prepared.withhold,
      duplicate: !!prepared.duplicate,
      eventId: prepared.eventId || null,
      source: prepared.source || null,
    };
  }

  // The outbox row. The envelope is signed when the event is delivered: the
  // signature covers the payload and the moment of delivery, so a row that
  // has been waiting in the outbox is signed with the time it actually left.
  //
  // The row carries the actor of the event - whoever caused it - because the
  // delivery path keeps one actor's events in order, and an event whose
  // actor is not recorded cannot be ordered against the others.
  const id = uuid();
  const actorId = opts.actorId || (prepared.payload.origin && prepared.payload.origin.actor_id) || null;
  await db.run(
    'INSERT INTO continuum_events (id, kind, actor_id, target_id, payload, status, attempts, max_attempts, backoff_ms, run_after, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id, prepared.kind, actorId, opts.targetId || null, JSON.stringify(prepared.payload),
      'pending', 0, maxAttempts(), retryBaseMs(), now(), now(), now(),
    ]
  );
  if (prepared.source) {
    await ledger.markLive(prepared.source.kind, prepared.source.id, {
      fingerprint: prepared.fingerprint,
      kind: prepared.kind,
      eventId: id,
    });
  }
  // Wake the delivery job system.
  await jobs.enqueue('continuum_deliver', { eventId: id }, { maxAttempts: 1, backoffMs: 0 });
  await scheduleFeed();
  return {
    ok: true,
    eventId: id,
    kind: prepared.kind,
    source: prepared.source,
    fingerprint: prepared.fingerprint,
  };
}

// The change feed ------------------------------------------------------------

// How often the feed reconciles the local state against the ledger. The
// interval is the feed's own: it is also how long a change has to have
// settled before it is published, and the bound the operator is shown.
function feedIntervalMs() {
  return feed.intervalMs();
}

// The feed is a durable job that queues the next pass, so it survives a
// restart and does not need a timer in the process. It is started once, when
// the signing identity is loaded - which the boot does after the database is
// connected and before the job system starts.
let feedScheduled = false;
async function scheduleFeed() {
  if (feedScheduled) return;
  feedScheduled = true;
  try {
    await jobs.enqueue('continuum_feed', {}, { maxAttempts: 1, runAfterMs: feedIntervalMs() });
  } catch {
    // The job system is not up yet; the next publication or boot will queue
    // it again.
    feedScheduled = false;
  }
}

async function runFeed() {
  if (!enabled()) {
    // Federation is off: the feed has nothing to reconcile. The chain is
    // stopped, and the next publication or management screen starts it again.
    feedScheduled = false;
    return;
  }
  try {
    await feed.run(publishEvent);
  } finally {
    // The next pass is queued whether this one worked or not: a pass that
    // throws is retried by the job system, and the chain continues.
    await jobs.enqueue('continuum_feed', {}, { maxAttempts: 1, runAfterMs: feedIntervalMs() })
      .catch(() => {});
  }
}
// The feed is a job kind of its own. It is registered here rather than in the
// boot because the boot belongs to the server module, and because a job kind
// that is registered twice is a startup error: the registration is
// idempotent, and the job system owns the retries.
try {
  jobs.register('continuum_feed', runFeed, { concurrency: 1, maxAttempts: 3, backoffMs: 5000 });
} catch (e) {
  if (!/already registered/.test(String(e && e.message))) throw e;
}

// Inbound --------------------------------------------------------------------

// Receive an event from a remote instance.
//
// The checks are in the order they can be made cheapest, and none of them
// depends on a later one:
//
//   1. the instance it claims to come from is one this instance knows and
//      trusts
//   2. the signature verifies against the key recorded for that instance
//   3. the event id has not been seen before
//   4. its timestamp is a real time, near enough to now
//   5. its kind is part of the vocabulary and its payload is well formed
//   6. its sequence is newer than the highest already accepted from that
//      (origin, actor)
//
// Returns { accepted: true } for an event that was stored, { accepted: true,
// duplicate: true } for one that has been seen before, and { accepted: false,
// reason } for one that was refused.
async function receiveEvent(envelope) {
  if (!enabled()) return { accepted: false, reason: 'federation is disabled' };
  if (!envelope || !envelope.key_id || !envelope.id || !envelope.kind) {
    return { accepted: false, reason: 'the event is not a valid envelope' };
  }
  const instance = await db.get('SELECT * FROM continuum_instances WHERE id = ?', [envelope.key_id]);
  if (!instance) return { accepted: false, reason: 'the sending instance is not known here' };
  // Only a trusted instance may send. A pending one is not yet vouched for
  // and a blocked one is not welcome at all.
  if (instance.trust_status !== 'trusted') {
    return { accepted: false, reason: 'the sending instance is not trusted' };
  }
  if (!verifyEvent(envelope, instance.public_key)) {
    return { accepted: false, reason: 'the signature does not verify' };
  }
  // Idempotency: an event we have already seen is never processed again.
  const existing = await db.get('SELECT 1 FROM continuum_inbox WHERE event_id = ?', [envelope.id]);
  if (existing) return { accepted: true, duplicate: true, id: envelope.id, kind: envelope.kind };

  const timestamp = inbound.checkTimestamp(envelope);
  if (!timestamp.ok) return { accepted: false, reason: timestamp.reason };

  const shape = inbound.checkShape(envelope);
  if (!shape.ok) return { accepted: false, reason: shape.reason };

  const origin = (envelope.payload && envelope.payload.origin) || {};
  const sequence = await sequences.acceptInbound(envelope.key_id, origin.actor_id, origin.seq);
  if (!sequence.ok) return { accepted: false, reason: sequence.reason };

  await db.run(
    'INSERT INTO continuum_inbox (event_id, instance_id, kind, payload, received_at, processed) VALUES (?, ?, ?, ?, ?, 0)',
    [envelope.id, instance.id, envelope.kind, JSON.stringify(envelope.payload), now()]
  );
  // Schedule processing as a durable job so the HTTP request returns quickly
  // and so a crash during processing doesn't lose the event.
  await jobs.enqueue('continuum_inbound_process', { eventId: envelope.id }, { maxAttempts: 3, backoffMs: 1000 });
  return { accepted: true, id: envelope.id, kind: envelope.kind, payload: envelope.payload };
}

// Process one inbound event. An event that cannot be processed remains in
// the inbox with processed=0; re-running the job retries it (idempotent).
async function processInboundEvent(payload) {
  const { eventId } = payload || {};
  if (!eventId) return;
  const row = await db.get('SELECT * FROM continuum_inbox WHERE event_id = ?', [eventId]);
  if (!row) return;
  if (row.processed === 1) return; // already processed
  // Only known supported kinds are processed; everything else is quarantined by
  // simply leaving it unprocessed (admins can review via diagnostics).
  if (!events.isKnownKind(row.kind)) return;
  try {
    const result = await inbound.apply({
      instance_id: row.instance_id,
      kind: row.kind,
      payload: row.payload,
      event_id: eventId,
    }, { publish: publishEvent });
    await db.run('UPDATE continuum_inbox SET processed = 1 WHERE event_id = ?', [eventId]);
    await announceRelayed(result);
  } catch (e) {
    // Leave processed=0; job retry handles it.
    console.error('[continuum] inbound processing failed for', eventId, String(e && e.message || e));
    throw e;
  }
}

// Tell the local accounts that follow a remote community that something
// arrived. A relayed message is presented as a relayed message, and the
// client is told so by the type of the event.
//
// The return direction is told too: the writer of a message that went to the
// owner of a community is told what the owner said about it - taken, or
// refused with the reason - and told when the owner takes it back.
async function announceRelayed(result) {
  if (!result || !result.applied) return;
  if (result.subject === 'message' || result.subject === 'reaction') {
    // The followers of a remote community are the local accounts that read
    // it. A message in a community this instance owns is not a relayed
    // message for them: it is nobody's message here, and it is in the
    // moderation surface rather than in the channel.
    const owned = await db.get('SELECT id FROM servers WHERE id = ?', [result.originCommunityId]);
    if (!owned) {
      const followers = await inbound.localFollowers(result.originInstanceId, result.originCommunityId);
      const type = result.subject === 'message' ? 'continuum:relay-message' : 'continuum:relay-reaction';
      for (const userId of followers) {
        realtime.emitTo(userId, type, {
          origin_instance_id: result.originInstanceId,
          origin_community_id: result.originCommunityId,
          origin_message_id: result.originMessageId || null,
          relayed: true,
        });
      }
    }
  }
  if (result.authorId) {
    realtime.emitTo(result.authorId, 'continuum:relay-outgoing', {
      origin_instance_id: result.originInstanceId || null,
      origin_community_id: result.originCommunityId || null,
      origin_message_id: result.originMessageId || null,
      state: result.decision || (result.deleted ? 'deleted' : 'accepted'),
      reason: result.reason || null,
      relayed: true,
    });
  }
}

// Outbox delivery ------------------------------------------------------------

// The instances one event goes to: the trusted peers, or the single
// instance the event is addressed to.
async function deliveryTargets(event) {
  const peers = await db.all("SELECT * FROM continuum_instances WHERE trust_status = 'trusted'");
  const payload = safeParse(event.payload);
  const addressed = payload.destination_instance_id ? String(payload.destination_instance_id) : null;
  if (!addressed) return peers;
  return peers.filter((peer) => String(peer.id) === addressed);
}

// The sequence number an event carries, if it has one.
function sequenceOf(payload) {
  const parsed = safeParse(payload);
  const seq = parsed.origin && parsed.origin.seq;
  return Number.isFinite(seq) ? seq : null;
}

// Is an older event for the same actor still waiting to be delivered?
//
// The receiver refuses an event whose sequence is not newer than the last one
// it accepted from that actor, so the sender has to deliver an actor's
// events in order. Two events for one actor are therefore never in flight at
// the same time.
async function earlierPendingEvent(event) {
  const actor = event.actor_id;
  if (!actor) return null;
  const mine = sequenceOf(event.payload);
  if (mine === null) return null;
  const rows = await db.all(
    "SELECT id, payload FROM continuum_events WHERE actor_id = ? AND status = 'pending' AND id <> ?",
    [actor, event.id]
  );
  for (const row of rows) {
    const seq = sequenceOf(row.payload);
    if (seq !== null && seq < mine) return row;
  }
  return null;
}

// What the other end said it would not accept. Bounded, because a peer
// could answer with anything at all.
async function readRefusal(res) {
  try {
    const text = await res.text();
    if (!text) return null;
    let reason = text;
    try {
      const parsed = JSON.parse(text);
      reason = (parsed.error && parsed.error.message) || parsed.message || text;
    } catch { /* not JSON: the text is the reason */ }
    return String(reason).slice(0, 300);
  } catch {
    return null;
  }
}

// Deliver one event to one remote instance. Returns true on success.
async function deliverEventToInstance(event, instance) {
  const envelope = {
    id: event.id, kind: event.kind, actor: event.actor_id, target: event.target_id,
    timestamp: event.created_at, payload: safeParse(event.payload),
  };
  envelope.signature = signEvent(envelope);
  envelope.key_id = identity.getInstanceId();
  try {
    // Revalidate origin at delivery time: hostnames may have changed, and a
    // saved instance could now resolve to a private address (DNS rebinding).
    // The name is resolved as well as read, so a name that points inward is
    // caught here and not only when the address was first saved.
    const parsed = String(instance.origin || '').trim().match(/^(\w+:)\/\/([^\/\s:?#]+)(:\d+)?(\/.*)?$/);
    const host = parsed ? parsed[2] : '';
    if (!parsed || guard.forbiddenHost(host)) {
      throw new Error('origin host is not allowed at delivery time');
    }
    if (await guard.resolvesToPrivate(host)) {
      throw new Error('origin resolves to a private address at delivery time');
    }
    const res = await fetch(`${instance.origin}/api/continuum/inbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-instance-id': identity.getInstanceId() },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (res.ok) {
      await db.run(
        'INSERT INTO continuum_deliveries (id, event_id, instance_id, status, attempted_at) VALUES (?, ?, ?, ?, ?)',
        [uuid(), event.id, instance.id, 'delivered', now()]
      );
      return true;
    }
    // The refusal is worth keeping: "HTTP 400" says that something was
    // refused, and the reason says what.
    const reason = await readRefusal(res);
    throw new Error(`HTTP ${res.status}${reason ? ': ' + reason : ''}`);
  } catch (e) {
    await db.run(
      'INSERT INTO continuum_deliveries (id, event_id, instance_id, status, attempted_at, error) VALUES (?, ?, ?, ?, ?, ?)',
      [uuid(), event.id, instance.id, 'failed', now(), String(e && e.message || e).slice(0, 500)]
    );
    return false;
  }
}

// Process one due outbox event: deliver it to the instances it is addressed
// to, then mark it done, reschedule it, or give up on it.
//
// A destination that has already received the event is not asked again, so
// one unreachable peer does not stop the others from receiving it, and an
// event whose attempts are spent is a terminal state an operator can see.
async function deliverEvent(payload) {
  const { eventId } = payload || {};
  if (!eventId) return;
  const event = await db.get('SELECT * FROM continuum_events WHERE id = ?', [eventId]);
  if (!event) return;
  if (event.status !== 'pending') return;

  // The backoff is real: an event that is not due yet is not attempted, and
  // the wait is honoured by the job that runs it.
  const dueAt = Date.parse(event.run_after || '');
  if (Number.isFinite(dueAt) && dueAt > Date.now()) {
    await jobs.enqueue('continuum_deliver', { eventId }, { maxAttempts: 1, runAfterMs: dueAt - Date.now() });
    return;
  }

  // One actor's events go in order, so the receiver sees their sequence
  // numbers in order too.
  const earlier = await earlierPendingEvent(event);
  if (earlier) {
    const wait = 250;
    await db.run(
      'UPDATE continuum_events SET run_after = ?, updated_at = ? WHERE id = ?',
      [new Date(Date.now() + wait).toISOString(), now(), eventId]
    );
    await jobs.enqueue('continuum_deliver', { eventId }, { maxAttempts: 1, runAfterMs: wait });
    return;
  }

  const targets = await deliveryTargets(event);

  if (!targets.length) {
    // There is nowhere to deliver this event. The attempts are spent and the
    // operator is told why, rather than the event sitting in the outbox
    // forever.
    const attempts = event.attempts + 1;
    const reason = 'there is no trusted instance to deliver this event to';
    if (attempts >= event.max_attempts) {
      await db.run(
        'UPDATE continuum_events SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE id = ?',
        ['failed', attempts, reason, now(), eventId]
      );
      return;
    }
    let wait = event.backoff_ms * 2;
    if (wait > 3600000) wait = 3600000;
    const jitter = Math.floor(Math.random() * wait / 2);
    await db.run(
      'UPDATE continuum_events SET status = ?, attempts = ?, backoff_ms = ?, run_after = ?, error = ?, updated_at = ? WHERE id = ?',
      ['pending', attempts, wait, new Date(Date.now() + wait + jitter).toISOString(), reason, now(), eventId]
    );
    await jobs.enqueue('continuum_deliver', { eventId }, { maxAttempts: 1, runAfterMs: wait + jitter });
    return;
  }

  const delivered = new Set(
    (await db.all(
      "SELECT DISTINCT instance_id FROM continuum_deliveries WHERE event_id = ? AND status = 'delivered'",
      [event.id]
    )).map((row) => String(row.instance_id))
  );

  let lastError = null;
  for (const target of targets) {
    if (delivered.has(String(target.id))) continue;
    const sent = await deliverEventToInstance(event, target);
    if (!sent) {
      const failure = await db.get(
        'SELECT error FROM continuum_deliveries WHERE event_id = ? AND instance_id = ? ORDER BY attempted_at DESC LIMIT 1',
        [event.id, target.id]
      );
      if (failure && failure.error) lastError = failure.error;
    }
  }

  const reached = new Set(
    (await db.all(
      "SELECT DISTINCT instance_id FROM continuum_deliveries WHERE event_id = ? AND status = 'delivered'",
      [event.id]
    )).map((row) => String(row.instance_id))
  );
  const outstanding = targets.filter((target) => !reached.has(String(target.id)));

  const attempts = event.attempts + 1;
  if (!outstanding.length) {
    await db.run(
      'UPDATE continuum_events SET status = ?, attempts = ?, error = NULL, updated_at = ? WHERE id = ?',
      ['delivered', attempts, now(), eventId]
    );
    return;
  }
  if (attempts >= event.max_attempts) {
    // The attempts are spent. This is a terminal state: the operator sees it
    // and it is not retried again.
    await db.run(
      'UPDATE continuum_events SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE id = ?',
      ['failed', attempts, lastError || 'the event was not delivered to every instance', now(), eventId]
    );
    return;
  }
  let backoff = event.backoff_ms * 2;
  if (backoff > 3600000) backoff = 3600000;
  const jitter = Math.floor(Math.random() * backoff / 2);
  await db.run(
    'UPDATE continuum_events SET status = ?, attempts = ?, backoff_ms = ?, run_after = ?, error = ?, updated_at = ? WHERE id = ?',
    ['pending', attempts, backoff, new Date(Date.now() + backoff + jitter).toISOString(), lastError, now(), eventId]
  );
  // Re-enqueue for retry, after the wait this attempt set.
  await jobs.enqueue('continuum_deliver', { eventId }, { maxAttempts: 1, runAfterMs: backoff + jitter });
}

// Remote communities ---------------------------------------------------------

// The remote communities this instance knows about, with the local
// relationship to each of them.
async function listRemoteCommunities() {
  const communities = await store.listCommunities();
  const out = [];
  for (const community of communities) {
    const relationship = await remoteCommunities.relationshipState(
      community.origin_instance_id,
      community.origin_community_id
    );
    out.push({ ...community, relationship });
  }
  return out;
}

// The federated communities, for the reader.
//
// A community that lives on another instance is a reference, not a copy. This
// is the list the reader sees, and it is the list the community list is
// built from: the same communities, in a section of their own, because a
// community of this instance and a community of another one are different
// things and mixing them in one list makes both of them harder to read.
//
// What is here is what this instance knows about. The instance it lives on
// is named, because "General" on another instance is not the same "General",
// and the reader is shown where it is from.
async function listFederatedFor(readerId) {
  const communities = await store.listCommunities();
  const out = [];
  for (const community of communities) {
    const origin = await db.get(
      'SELECT id, name, origin FROM continuum_instances WHERE id = ?',
      [community.origin_instance_id]
    );
    const membership = readerId
      ? await db.get(
        'SELECT state FROM continuum_memberships WHERE user_id = ? AND origin_instance_id = ? AND origin_community_id = ?',
        [String(readerId), community.origin_instance_id, community.origin_community_id]
      )
      : null;
    out.push({
      id: community.id,
      originInstanceId: community.origin_instance_id,
      originCommunityId: community.origin_community_id,
      name: community.name,
      description: community.description == null ? null : String(community.description),
      iconUrl: community.icon_url == null ? null : String(community.icon_url),
      // Where it lives. A community whose instance has gone is still named:
      // the reader may follow something that is no longer there.
      originName: origin ? origin.name : null,
      originUrl: origin ? origin.origin : null,
      // 'joined' when this reader follows it, 'discovered' when they do not,
      // and 'left' when they followed it and left again.
      relationship: membership ? membership.state : 'discovered',
      channels: (community.channels || []).map((channel) => ({
        id: channel.id,
        name: channel.name,
        type: channel.type || 'text',
        topic: channel.topic == null ? null : String(channel.topic),
        canPost: channel.is_public !== false,
      })),
    });
  }
  return out;
}

// Ask a peer for the communities it federates and record them.
async function syncPeerCommunities(instanceId) {
  const peer = await db.get('SELECT * FROM continuum_instances WHERE id = ?', [instanceId]);
  if (!peer) throw { code: 'NOT_FOUND', message: 'no such instance' };
  const result = await remoteCommunities.fetchDiscovery(peer.origin);
  if (!result.ok) throw { code: 'UNREACHABLE', message: result.error };
  return { instance_id: String(instanceId), imported: result.imported, communities: await listRemoteCommunities() };
}

// The relayed messages of one remote community.
//
// Who may read them is a question, and it is answered before the list is
// built rather than after. A community of this instance is read by its
// members; a community of another instance is read by the people who follow
// it. An account that follows nothing and belongs to nothing must not be
// able to name an instance and a community and read what was said in it.
async function listRelayedMessages(originInstanceId, originCommunityId, limit, readerId) {
  if (readerId && !(await store.canReadRelayMessages(readerId, originInstanceId, originCommunityId))) {
    const e = new Error('you do not follow that community');
    e.code = 'PERMISSION_DENIED';
    e.status = 403;
    throw e;
  }
  return store.listRelayMessages(originInstanceId, originCommunityId, { limit });
}

// Every relayed message this instance holds.
async function listAllRelayedMessages(limit) {
  return store.listAllRelayMessages({ limit });
}

// The members of this instance's communities who live on another instance.
async function listRelayMemberships(filter) {
  return store.listRelayMemberships(filter);
}

// Membership of a remote community -------------------------------------------

async function joinRemoteCommunity(user, originInstanceId, originCommunityId) {
  return membership.join({ user, originInstanceId, originCommunityId, publish: publishEvent });
}

async function leaveRemoteCommunity(user, originInstanceId, originCommunityId) {
  return membership.leave({ user, originInstanceId, originCommunityId, publish: publishEvent });
}

async function listUserMemberships(userId) {
  return membership.listForUser(userId);
}

// Writing in a community that lives on another instance -----------------------

// A member of a federated community writes here. The message travels to the
// instance that owns the community, and the owner answers: taken, or refused
// with the reason.
async function writeRemoteMessage(user, originInstanceId, originCommunityId, originChannelId, body) {
  return outgoing.write({
    user,
    originInstanceId,
    originCommunityId,
    originChannelId,
    content: body && body.content,
    replyToId: body && body.replyToId,
    publish: publishEvent,
  });
}

async function editRemoteMessage(user, outgoingId, body) {
  return outgoing.edit({ user, outgoingId, content: body && body.content });
}

async function deleteRemoteMessage(user, outgoingId) {
  return outgoing.remove({ user, outgoingId });
}

// What this account has written into communities that live elsewhere, and
// what the owners said about it.
async function listOutgoingMessages(userId, filter) {
  return outgoing.listForUser(userId, filter);
}

// Moderation of what members of these communities wrote elsewhere -------------

// The moderation surface: the messages members of these communities wrote on
// other instances.
async function listModerationMessages(actor, filter) {
  return moderation.listMessages(Object.assign({ actor }, filter || {}));
}

async function removeModerationMessage(actor, originInstanceId, originMessageId, body) {
  return moderation.removeMessage({
    actor,
    originInstanceId,
    originMessageId,
    reason: body && body.reason,
    publish: publishEvent,
  });
}

async function restrictRelayMember(actor, originInstanceId, originUserId, body) {
  return moderation.restrictMember({
    actor,
    originInstanceId,
    originUserId,
    communityId: body && body.community_id,
    action: body && body.action,
    reason: body && body.reason,
    publish: publishEvent,
  });
}

async function listModerationMembers(actor, filter) {
  return moderation.listMembers(Object.assign({ actor }, filter || {}));
}

// The change feed's own state: when it last ran, and how far behind it is.
async function feedStatus() {
  return feed.status();
}

module.exports = {
  enabled,
  setInstanceId,
  prepareKeys,
  loadPersistedKeys,
  getPublicKey,
  signEvent,
  verifyEvent,
  enqueueEvent,
  publishEvent,
  addInstance,
  removeInstance,
  listInstances,
  listEvents,
  getEvent,
  listDeliveries,
  listInbox,
  setTrust,
  discovery,
  receiveEvent,
  deliverEvent,
  processInboundEvent,
  runFeed,
  validateOrigin,
  deliveryTargets,
  listRemoteCommunities,
  syncPeerCommunities,
  listRelayedMessages,
  listAllRelayedMessages,
  listRelayMemberships,
  joinRemoteCommunity,
  leaveRemoteCommunity,
  listUserMemberships,
  listFederatedFor,
  writeRemoteMessage,
  editRemoteMessage,
  deleteRemoteMessage,
  listOutgoingMessages,
  listModerationMessages,
  removeModerationMessage,
  restrictRelayMember,
  listModerationMembers,
  feedStatus,
  runFeedSoon: scheduleFeed,
};

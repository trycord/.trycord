// The public event envelope, and the delivery of it.
//
// A webhook receives a body. The body is a contract, so it is versioned: `v`
// says which contract the body follows, and a body without it is a body from
// before the version existed.
//
// The envelope keeps the field names the existing deliveries already use -
// `event`, `at`, `serverId`, `channelId`, and the event's own fields at the
// top level - and adds the version, the delivery id, the instance and the
// actor. A consumer written against the older shape keeps reading the older
// shape; the versioned fields are additions, not renames.
//
// What the versioned envelope does not do is change what services/webhooks.js
// sends. The fan-out there delivers to every active webhook of a community
// and knows nothing about subscriptions, so a subscribed webhook receives the
// older body for the events the rest of the application produces and the
// versioned body for the events the developer platform produces. Narrowing
// that fan-out belongs in services/webhooks.js, which this workstream does not
// own.

const db = require('../../db');
const { now, uuid } = require('../../util');
const { EVENTS, sign } = require('../webhooks');
const { assertPublicHost } = require('../netguard');

const ENVELOPE_VERSION = 1;
const DELIVERY_TIMEOUT_MS = 4000;

// The vocabulary is the one services/webhooks.js already uses. A second list
// would be a second answer to "which events exist".
const EVENT_TYPES = EVENTS.slice();

function isEventType(type) {
  return EVENT_TYPES.indexOf(String(type || '')) !== -1;
}

function readEvents(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Build the public envelope.
 *
 * The event's own fields are merged in first, so a payload cannot overwrite
 * the version, the type or the timestamp.
 *
 * @param {object} event
 * @param {string} event.type
 * @param {string} event.id the delivery id
 * @param {object} event.instance {id, name}
 * @param {string} event.communityId
 * @param {string} [event.channelId]
 * @param {object} [event.actor] {id, type}
 * @param {object} [event.data] the event's own fields
 * @returns {object}
 */
function buildEnvelope({ type, id, instance, communityId, channelId, actor, data }) {
  return Object.assign({}, data || {}, {
    v: ENVELOPE_VERSION,
    event: type,
    id,
    at: now(),
    instance: { id: instance ? instance.id : null, name: instance ? instance.name : null },
    serverId: communityId || null,
    channelId: channelId || null,
    actor: actor ? { id: actor.id, type: actor.type || 'user' } : null,
  });
}

/**
 * The default transport: an HTTP POST to the endpoint, signed the way
 * services/webhooks.js signs a delivery, so a receiver that already verifies
 * the signature keeps verifying it.
 */
async function httpTransport({ hook, body, id, type }) {
  const secretRow = await db.get('SELECT secret_hash FROM webhooks WHERE id = ?', [hook.id]);
  const signature = sign(secretRow ? secretRow.secret_hash : '', body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DELIVERY_TIMEOUT_MS);
  try {
    // Checked immediately before the request, not only when the webhook was
    // saved: a name that was public then can resolve to a private address now.
    await assertPublicHost(new URL(hook.url).hostname);
    const response = await fetch(hook.url, {
      method: 'POST',
      redirect: 'manual',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Trycord-Webhook/1.0',
        'x-trycord-event': type,
        'x-trycord-delivery': id,
        'x-trycord-signature': 'sha256=' + signature,
      },
      body,
    });
    if (response.ok) return { status: 'delivered', statusCode: response.status, error: null };
    return { status: 'failed', statusCode: response.status, error: 'endpoint returned ' + response.status };
  } catch (e) {
    return { status: 'failed', statusCode: null, error: String((e && e.message) || e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

// The transport is replaceable so a delivery can be exercised without a
// public endpoint. It is replaced by the test suite, never by a request.
let transport = httpTransport;

function setTransport(next) {
  transport = next || httpTransport;
}

/**
 * Deliver one envelope and record the attempt.
 *
 * The record goes into webhook_deliveries, the table the existing deliveries
 * already use, so one delivery log describes every delivery an operator can
 * see.
 *
 * @param {object} hook the webhook row
 * @param {object} envelope the body to deliver
 * @param {string} type the event type
 * @param {string} [id] the delivery id, which the envelope also carries
 */
async function deliver(hook, envelope, type, id) {
  const deliveryId = id || uuid();
  const body = JSON.stringify(envelope);
  const result = await transport({ hook, envelope, body, id: deliveryId, type });
  const status = result && result.status ? result.status : 'failed';
  const statusCode = result && result.statusCode !== undefined ? result.statusCode : null;
  const error = result && result.error ? result.error : null;
  try {
    await db.run(
      'INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status, status_code, error, created_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [deliveryId, hook.id, type, body.slice(0, 8000), status, statusCode, error, now()]
    );
  } catch (e) {
    // A lost record must not become a thrown delivery: the endpoint was
    // reached, and saying otherwise would be wrong.
    console.warn('[developer] could not record webhook delivery: ' + (e && e.message ? e.message : e));
  }
  return { id: deliveryId, status, statusCode };
}

/**
 * Deliver an event to the subscribers of a community.
 *
 * @param {object} event
 * @param {string} event.communityId
 * @param {string} event.type
 * @param {object} [event.instance]
 * @param {string} [event.channelId]
 * @param {object} [event.actor]
 * @param {object} [event.data]
 * @returns {Promise<Array>} one entry per delivery attempted
 */
async function dispatch({ communityId, type, instance, channelId, actor, data }) {
  if (!communityId || !isEventType(type)) return [];
  const subscriptions = await db.all(
    'SELECT * FROM developer_subscriptions WHERE community_id = ?',
    [communityId]
  );
  const out = [];
  for (const subscription of subscriptions) {
    const types = readEvents(subscription.events);
    if (types.indexOf(type) === -1) continue;
    const hook = await db.get('SELECT * FROM webhooks WHERE id = ?', [subscription.webhook_id]);
    if (!hook || !hook.active) continue;
    // The delivery id is the envelope's id: a receiver that logs the body and
    // the delivery header can tell they are about the same delivery.
    const id = uuid();
    const envelope = buildEnvelope({
      type,
      id,
      instance,
      communityId,
      channelId,
      actor,
      data,
    });
    out.push(await deliver(hook, envelope, type, id));
  }
  return out;
}

/**
 * Deliver an event without waiting for the deliveries.
 *
 * A request must not wait for a third party's endpoint, and a delivery that
 * fails must not fail the request that caused it. The failure is logged
 * rather than swallowed: a subscriber that stops receiving events is a
 * problem somebody has to be able to see.
 */
function dispatchInBackground(event) {
  dispatch(event).catch((e) => {
    console.warn('[developer] event delivery failed: ' + (e && e.message ? e.message : e));
  });
}

/**
 * The envelope as the API documents it: the fields, their types and what they
 * mean. The interface reads this rather than a second copy of the shape.
 */
function envelopeDescription() {
  return {
    version: ENVELOPE_VERSION,
    fields: {
      v: { type: 'integer', description: 'The envelope version. Absent on a body delivered before the version existed.' },
      event: { type: 'string', description: 'The event type. One of the types the vocabulary lists.' },
      id: { type: 'string', description: 'The delivery id. The same value is in the x-trycord-delivery header.' },
      at: { type: 'string', format: 'date-time', description: 'When the event happened.' },
      instance: { type: 'object', description: 'The instance that produced the event: its id and its name.' },
      serverId: { type: 'string', description: 'The community the event belongs to.' },
      channelId: { type: 'string', nullable: true, description: 'The channel, when the event belongs to one.' },
      actor: { type: 'object', nullable: true, description: 'Who caused the event: an id and a type.' },
    },
  };
}

module.exports = {
  ENVELOPE_VERSION,
  EVENT_TYPES,
  isEventType,
  readEvents,
  buildEnvelope,
  dispatch,
  dispatchInBackground,
  envelopeDescription,
  setTransport,
};

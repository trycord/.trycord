// Event subscriptions.
//
// A subscription says which events of a community are delivered to which
// webhook, and which credential asked for it. The endpoint itself is a
// webhook row, and the delivery log is the one the rest of the instance
// already writes to, so an operator sees one delivery history rather than
// two.

const db = require('../../db');
const { now, uuid } = require('../../util');
const { isEventType, readEvents } = require('./events');

function bad(message) {
  const e = new Error(message);
  e.code = 'VALIDATION_ERROR';
  throw e;
}

function shape(row) {
  return {
    id: row.id,
    keyId: row.key_id || null,
    ownerUserId: row.owner_user_id || null,
    webhookId: row.webhook_id,
    communityId: row.community_id,
    events: readEvents(row.events),
    createdAt: row.created_at,
  };
}

/**
 * The event types a subscription may ask for.
 *
 * @param {unknown} input
 * @returns {string[]} the accepted types, sorted and without duplicates
 */
function normaliseEvents(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) bad('events must be an array of event types');
  const out = new Set();
  for (const raw of input) {
    const type = String(raw || '').trim();
    if (!isEventType(type)) bad('unknown event type: ' + (type || '(empty)'));
    out.add(type);
  }
  return [...out].sort();
}

/**
 * Subscribe a webhook to the events of a community.
 *
 * @param {object} options
 * @returns {Promise<object>}
 */
async function create({ keyId, ownerUserId, webhookId, communityId, events }) {
  const types = normaliseEvents(events);
  if (!types.length) bad('a subscription needs at least one event type');
  const id = uuid();
  const ts = now();
  await db.run(
    'INSERT INTO developer_subscriptions (id, key_id, owner_user_id, webhook_id, community_id, events, created_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, keyId || null, ownerUserId || null, webhookId, communityId, JSON.stringify(types), ts]
  );
  return shape(await db.get('SELECT * FROM developer_subscriptions WHERE id = ?', [id]));
}

/**
 * The subscriptions of a community.
 *
 * @param {string} communityId
 * @returns {Promise<object[]>}
 */
async function list(communityId) {
  const rows = await db.all(
    'SELECT * FROM developer_subscriptions WHERE community_id = ? ORDER BY created_at',
    [communityId]
  );
  return rows.map(shape);
}

/**
 * End one subscription.
 *
 * @param {string} subscriptionId
 * @param {string} communityId
 * @returns {Promise<boolean>}
 */
async function remove(subscriptionId, communityId) {
  const row = await db.get(
    'SELECT * FROM developer_subscriptions WHERE id = ? AND community_id = ?',
    [subscriptionId, communityId]
  );
  if (!row) return false;
  await db.run('DELETE FROM developer_subscriptions WHERE id = ?', [subscriptionId]);
  return true;
}

module.exports = { create, list, remove };

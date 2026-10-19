// Health, in the words an operator can act on.
//
// A credential is configured, active or failing; an application is the same.
// A webhook is healthy when its deliveries land, and the report says how many
// did and when the last one did not.
//
// There is no invented green check here. Nothing in this module probes a
// third party, guesses at a network, or reports "ok" about something it did
// not observe. Every number comes from a row this instance wrote.

const db = require('../../db');
const usage = require('./usage');

/**
 * The health of one credential.
 *
 * @param {object} key the credential, as apiKeys.shape() returns it
 * @param {object} [options]
 * @param {number} [options.minutes] the window the usage is read over
 * @returns {Promise<object>}
 */
async function keyHealth(key, { minutes = 60 } = {}) {
  const spent = await usage.summary(key.id, { minutes });
  return {
    key: {
      id: key.id,
      name: key.name,
      kind: key.kind,
      status: key.status,
      scopes: key.scopes,
      rateLimitPerMinute: key.rateLimitPerMinute,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
      expiresAt: key.expiresAt,
      revokedAt: key.revokedAt,
      revokedReason: key.revokedReason,
    },
    state: stateOf({
      status: key.status,
      lastUsedAt: key.lastUsedAt,
      lastFailure: spent.lastFailure,
    }),
    windowMinutes: spent.windowMinutes,
    usage: spent.totals,
    lastFailure: spent.lastFailure,
  };
}

/**
 * The health of one webhook, from its delivery log.
 *
 * @param {string} webhookId
 * @returns {Promise<object|null>}
 */
async function webhookHealth(webhookId) {
  const hook = await db.get('SELECT * FROM webhooks WHERE id = ?', [webhookId]);
  if (!hook) return null;
  const rows = await db.all(
    'SELECT id, event_type, status, status_code, error, created_at FROM webhook_deliveries'
    + ' WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 100',
    [webhookId]
  );
  const totals = { delivered: 0, failed: 0 };
  let lastDeliveryAt = null;
  let lastFailure = null;
  for (const row of rows) {
    if (row.status === 'delivered') {
      totals.delivered += 1;
      if (!lastDeliveryAt || row.created_at > lastDeliveryAt) lastDeliveryAt = row.created_at;
    } else {
      totals.failed += 1;
      if (!lastFailure || row.created_at > lastFailure.at) {
        lastFailure = {
          at: row.created_at,
          eventType: row.event_type,
          statusCode: row.status_code === null || row.status_code === undefined ? null : row.status_code,
          error: row.error || null,
        };
      }
    }
  }
  return {
    webhookId: hook.id,
    name: hook.name,
    active: !!hook.active,
    state: !hook.active ? 'disabled' : (totals.failed > 0 ? 'failing' : (totals.delivered > 0 ? 'active' : 'configured')),
    deliveries: totals,
    lastDeliveryAt,
    lastFailure,
  };
}

/**
 * The state of a credential or an application.
 *
 * @param {object} input
 * @param {string|null} input.status 'revoked' when it was withdrawn
 * @param {string|null} input.lastUsedAt
 * @param {object|null} input.lastFailure
 * @returns {string} configured, active, failing or revoked
 */
function stateOf({ status, lastUsedAt, lastFailure }) {
  if (status === 'revoked') return 'revoked';
  if (lastFailure) return 'failing';
  if (!lastUsedAt) return 'configured';
  return 'active';
}

module.exports = { keyHealth, webhookHealth, stateOf };

// The bot application lifecycle, in the terms the developer platform uses.
//
// An application is a community resource that posts messages and answers
// slash commands. It is not an account: it has no login, no session and no
// password, and it never needs one. What it has is a token, a set of scopes,
// a rate limit and a health.
//
// The application row and its commands belong to services/bots.js and
// services/webhooks.js; this module is the layer that ties them to a
// credential: which scopes an application may use, how its token is rotated,
// how it is revoked, and what its health is.

const crypto = require('crypto');
const db = require('../../db');
const { now } = require('../../util');
const bots = require('../bots');
const apiKeys = require('../apiKeys');
const { normaliseScopes } = require('./scopes');
const usage = require('./usage');
const { stateOf } = require('./health');

// The token format is the one services/bots.js issues and accepts, so an
// application created here works with the existing bot API unchanged.
const TOKEN_BYTES = 24;

function newToken() {
  return bots.TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * The credential that belongs to an application.
 *
 * @param {string} applicationId
 * @returns {Promise<object|null>}
 */
async function credentialOf(applicationId) {
  const row = await db.get(
    'SELECT * FROM developer_api_keys WHERE bot_application_id = ? ORDER BY created_at DESC LIMIT 1',
    [applicationId]
  );
  return row || null;
}

/**
 * Create an application and the credential that goes with it.
 *
 * The token is returned exactly once. The credential carries the scopes and
 * the limit; the token itself belongs to the application row, so the existing
 * bot API keeps accepting it.
 *
 * @param {object} options
 * @returns {Promise<{application: object, token: string, credential: object}>}
 */
async function create({ serverId, ownerUserId, name, description, iconUrl, scopes, rateLimitPerMinute }) {
  const granted = normaliseScopes(scopes);
  const app = await bots.createApp({ serverId, ownerUserId, name, description, iconUrl });
  const created = await apiKeys.create({
    ownerUserId,
    name: app.name,
    scopes: granted,
    kind: 'bot',
    botApplicationId: app.id,
    communityId: serverId,
    rateLimitPerMinute,
    withoutSecret: true,
  });
  return { application: app, token: app.token, credential: created.key };
}

/**
 * Give an application a developer credential, or change the one it has.
 *
 * An application created before the developer platform existed has no
 * credential, and without one it cannot use the versioned API at all.
 *
 * @param {string} applicationId
 * @param {string} serverId
 * @param {object} options
 * @returns {Promise<object|null>}
 */
async function setCredential(applicationId, serverId, { scopes, rateLimitPerMinute } = {}) {
  const app = await bots.getApp(applicationId, serverId);
  if (!app) return null;
  const granted = normaliseScopes(scopes);
  const existing = await db.get(
    'SELECT * FROM developer_api_keys WHERE bot_application_id = ? AND status = ?',
    [app.id, 'active']
  );
  if (existing) {
    const limit = apiKeys.clampRateLimit(rateLimitPerMinute === undefined
      ? existing.rate_limit_per_minute
      : rateLimitPerMinute);
    await db.run(
      'UPDATE developer_api_keys SET scopes = ?, rate_limit_per_minute = ? WHERE id = ?',
      [JSON.stringify(granted), limit, existing.id]
    );
    const row = await db.get('SELECT * FROM developer_api_keys WHERE id = ?', [existing.id]);
    return apiKeys.shape(row);
  }
  const created = await apiKeys.create({
    ownerUserId: app.owner_user_id,
    name: app.name,
    scopes: granted,
    kind: 'bot',
    botApplicationId: app.id,
    communityId: serverId,
    rateLimitPerMinute,
    withoutSecret: true,
  });
  return created.key;
}

/**
 * Issue a new token for an application.
 *
 * The application row holds one token, so the previous token stops working at
 * once. There is no overlap window here: a second token would mean a second
 * row in the application table, and that table is not the developer platform's
 * to change.
 *
 * @param {string} applicationId
 * @param {string} serverId
 * @returns {Promise<{application: object, token: string}|null>}
 */
async function rotateToken(applicationId, serverId) {
  const app = await bots.getApp(applicationId, serverId);
  if (!app) return null;
  const token = newToken();
  await db.run(
    'UPDATE bot_applications SET token_hash = ?, updated_at = ? WHERE id = ?',
    [bots.hashToken(token), now(), app.id]
  );
  const updated = await bots.getApp(applicationId, serverId);
  return { application: bots.appShape(updated), token };
}

/**
 * Revoke an application.
 *
 * The token is burned rather than replaced: the stored hash becomes the hash
 * of a value nobody has, so the token that was issued stops authenticating at
 * once and no new token is handed to anyone.
 *
 * @param {string} applicationId
 * @param {string} serverId
 * @param {string} [reason]
 * @returns {Promise<object|null>}
 */
async function revoke(applicationId, serverId, reason) {
  const app = await bots.getApp(applicationId, serverId);
  if (!app) return null;
  const ts = now();
  await db.run(
    'UPDATE bot_applications SET token_hash = ?, status = ?, updated_at = ? WHERE id = ?',
    [bots.hashToken(crypto.randomBytes(TOKEN_BYTES).toString('hex')), 'disabled', ts, app.id]
  );
  const credential = await db.get(
    'SELECT * FROM developer_api_keys WHERE bot_application_id = ? AND status = ?',
    [app.id, 'active']
  );
  if (credential) {
    await db.run(
      'UPDATE developer_api_keys SET status = ?, revoked_at = ?, revoked_reason = ? WHERE key_id = ?',
      ['revoked', ts, String(reason || 'application revoked').slice(0, 255), credential.key_id]
    );
  }
  const updated = await bots.getApp(applicationId, serverId);
  return bots.appShape(updated);
}

/**
 * What an application is doing, and whether it is working.
 *
 * The states are the ones an operator can act on: configured but never used,
 * active, or failing. There is no green check, because there is nothing here
 * to check.
 *
 * @param {string} applicationId
 * @param {string} serverId
 * @returns {Promise<object|null>}
 */
async function health(applicationId, serverId) {
  const app = await bots.getApp(applicationId, serverId);
  if (!app) return null;
  const credential = await credentialOf(app.id);
  const spent = credential ? await usage.summary(credential.key_id, { minutes: 60 }) : null;
  const state = stateOf({
    status: (app.status || 'active') === 'active' ? null : 'revoked',
    lastUsedAt: credential ? credential.last_used_at : null,
    lastFailure: spent ? spent.lastFailure : null,
  });
  return {
    applicationId: app.id,
    name: app.name,
    state,
    status: app.status || 'active',
    rateLimitPerMinute: credential ? Number(credential.rate_limit_per_minute) : null,
    scopes: credential ? apiKeys.readScopes(credential.scopes) : [],
    lastUsedAt: credential ? credential.last_used_at || null : null,
    lastFailure: spent ? spent.lastFailure : null,
    usage: spent ? spent.totals : null,
  };
}

module.exports = {
  create, setCredential, rotateToken, revoke, health, credentialOf,
};
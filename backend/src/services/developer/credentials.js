// Who is calling the versioned API.
//
// Three kinds of caller, resolved from one header:
//
//   session  a signed-in person. The account itself, not restricted by scopes.
//   key      a developer API key. Carries an explicit scope set.
//   bot      an application's token. A scoped credential in its own right, not
//            a session token and not a human one.
//
// The scope check lives here rather than in the route handlers, so a route
// cannot forget it: the router asks for the scopes a route needs and this
// module refuses the request when the caller does not hold them.

const db = require('../../db');
const apiKeys = require('../apiKeys');
const bots = require('../bots');
const sessionAuth = require('../../middleware/auth');
const { fail } = require('../../errors');
const { missingScopes } = require('./scopes');

// Why a credential was refused. Each is a different answer to an integrator
// and leads to a different repair, so they are told apart rather than folded
// into one "invalid".
const REFUSALS = {
  revoked: { code: 'API_KEY_REVOKED', message: 'this credential has been revoked', status: 401 },
  expired: { code: 'API_KEY_EXPIRED', message: 'this credential has expired', status: 401 },
  unknown: { code: 'API_KEY_INVALID', message: 'invalid or expired credential', status: 401 },
  disabled: { code: 'BOT_DISABLED', message: 'this application is disabled', status: 403 },
  no_credential: {
    code: 'BOT_CREDENTIAL_REQUIRED',
    message: 'this application has no developer credential; issue one before using the developer API',
    status: 403,
  },
};

/**
 * Resolve a bearer token to a principal.
 *
 * @param {string} token
 * @returns {Promise<{principal: object}|{error: string}>}
 */
async function resolveCredential(token) {
  if (apiKeys.TOKEN_PREFIX && token.startsWith(apiKeys.TOKEN_PREFIX)) {
    const result = await apiKeys.authenticate(token);
    if (result.error) return { error: result.error };
    const row = result.row;
    return {
      principal: {
        kind: 'key',
        id: row.key_id,
        ownerUserId: row.owner_user_id,
        scopes: apiKeys.readScopes(row.scopes),
        rateLimit: Number(row.rate_limit_per_minute || apiKeys.DEFAULT_RATE_LIMIT),
        communityId: row.community_id || null,
        botApplicationId: null,
        generationId: row.id,
        lastUsedAt: row.last_used_at || null,
      },
    };
  }

  if (token.startsWith(bots.TOKEN_PREFIX)) {
    const app = await bots.appByToken(token);
    if (!app) return { error: 'unknown' };
    if ((app.status || 'active') !== 'active') return { error: 'disabled' };
    const row = await db.get(
      'SELECT * FROM developer_api_keys WHERE bot_application_id = ? AND status = ?',
      [app.id, 'active']
    );
    if (!row) return { error: 'no_credential' };
    return {
      principal: {
        kind: 'bot',
        id: row.key_id,
        ownerUserId: app.owner_user_id,
        userId: bots.botUserIdOf(app),
        scopes: apiKeys.readScopes(row.scopes),
        rateLimit: Number(row.rate_limit_per_minute || apiKeys.DEFAULT_RATE_LIMIT),
        communityId: app.server_id,
        botApplicationId: app.id,
        generationId: row.id,
        lastUsedAt: row.last_used_at || null,
      },
    };
  }

  // Not one of ours: the caller may be presenting a session token.
  return { error: 'unknown' };
}

/**
 * Whether the last use of a credential is old enough to be worth writing.
 *
 * @param {string|null} lastUsedAt
 * @returns {boolean}
 */
function stale(lastUsedAt) {
  if (!lastUsedAt) return true;
  const when = new Date(lastUsedAt).getTime();
  if (Number.isNaN(when)) return true;
  return Date.now() - when > 60000;
}

/**
 * The authentication middleware for the versioned API.
 *
 * A session bearer token keeps working exactly as it does everywhere else, so
 * the interface and an integrator can use the same surface.
 */
async function authenticate(req, res, next) {
  const header = String(req.headers.authorization || '');
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  const token = bearer ? bearer[1].trim() : '';

  if (token && (token.startsWith(apiKeys.TOKEN_PREFIX) || token.startsWith(bots.TOKEN_PREFIX))) {
    let resolved;
    try {
      resolved = await resolveCredential(token);
    } catch (e) {
      return next(e);
    }
    if (!resolved.principal) {
      const refusal = REFUSALS[resolved.error] || REFUSALS.unknown;
      return fail(res, refusal.code, refusal.message, refusal.status);
    }
    req.principal = resolved.principal;
    // A bot acts as its own account. A human API key acts as its owner.
    req.user = {
      id: resolved.principal.kind === 'bot'
        ? (resolved.principal.userId || resolved.principal.ownerUserId)
        : resolved.principal.ownerUserId,
    };
    // The last use is recorded at most once a minute. Writing it on every
    // request would turn every call into a write, and the answer it gives -
    // "when was this key last used" - does not need to be that exact.
    if (stale(resolved.principal.lastUsedAt)) {
      apiKeys.touch(resolved.principal.generationId).catch((e) => {
        console.warn('[developer] could not record key use: ' + (e && e.message ? e.message : e));
      });
    }
    return next();
  }

  return sessionAuth(req, res, (err) => {
    if (err) return next(err);
    if (res.headersSent) return undefined;
    req.principal = {
      kind: 'session',
      id: req.user.id,
      ownerUserId: req.user.id,
      scopes: null,
      rateLimit: null,
      communityId: null,
      botApplicationId: null,
      generationId: null,
    };
    return next();
  });
}

/**
 * Refuse a caller that does not hold every scope the route needs.
 *
 * A session is the account itself and is not scope-checked. A machine
 * credential is checked on every request: a key's scopes are what the
 * integration was given, and a route that does not check them would make the
 * scope set a decoration.
 */
function requireScopes(scopes) {
  const required = scopes || [];
  return (req, res, next) => {
    const principal = req.principal;
    if (!principal) return fail(res, 'AUTH_REQUIRED', 'authentication required', 401);
    if (principal.kind === 'session') return next();
    const missing = missingScopes(principal.scopes, required);
    if (missing.length) {
      return fail(
        res,
        'INSUFFICIENT_SCOPE',
        'this credential lacks the scope: ' + missing.join(', '),
        403,
        { missing }
      );
    }
    return next();
  };
}

/**
 * Refuse an application credential on a route that is not for applications.
 *
 * An application is a machine that acts in a community. It has no business
 * administering credentials, and saying so here is clearer than a scope
 * failure that would look like a configuration mistake.
 */
function denyBots(req, res, next) {
  if (req.principal && req.principal.kind === 'bot') {
    return fail(res, 'BOT_NOT_ALLOWED', 'an application credential cannot use this endpoint', 403);
  }
  return next();
}

module.exports = { authenticate, requireScopes, denyBots };

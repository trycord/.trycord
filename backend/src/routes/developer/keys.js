// The API key routes.
//
// A key is created once, with the scopes it will have for its whole life, and
// the secret that goes with it is returned exactly once. Everything after
// that is a list, a rotation, a revocation, or a report.

const { ref, pathParam, queryParam, requestBody, ok, ERRORS } = require('./metadata');
const apiKeys = require('../../services/apiKeys');
const { fail } = require('../../errors');
const { isMember } = require('../../util');
const { normaliseScopes, missingScopes } = require('../../services/developer/scopes');
const usage = require('../../services/developer/usage');
const health = require('../../services/developer/health');

const MAX_WINDOW_MINUTES = 1440;

function windowMinutes(raw) {
  const minutes = parseInt(raw, 10);
  if (!Number.isFinite(minutes)) return usage.DEFAULT_WINDOW_MINUTES;
  return Math.min(Math.max(minutes, 1), MAX_WINDOW_MINUTES);
}

// The keys of the owner. A credential sees the keys of the account it acts
// for, which is what an integration managing its own credentials needs, and
// never a key it does not own.
async function listKeys(req, res) {
  res.json({ keys: await apiKeys.list(req.principal.ownerUserId) });
}

async function createKey(req, res) {
  const body = req.body || {};
  const principal = req.principal;
  const scopes = normaliseScopes(body.scopes);

  // A credential may only create a key whose scopes it already holds. Without
  // that rule a key with keys:write could mint itself a key with every scope,
  // and the scope set would stop being a limit.
  if (principal.kind !== 'session') {
    const extra = missingScopes(principal.scopes, scopes);
    if (extra.length) {
      return fail(
        res,
        'INSUFFICIENT_SCOPE',
        'a credential may not create a key with a scope it does not hold: ' + extra.join(', '),
        403,
        { missing: extra }
      );
    }
  }

  let communityId = body.communityId || null;
  if (communityId) {
    if (!(await isMember(principal.ownerUserId, communityId))) {
      return fail(res, 'NOT_A_MEMBER', 'you are not a member of this community', 403);
    }
  }

  const created = await apiKeys.create({
    ownerUserId: principal.ownerUserId,
    name: body.name,
    scopes,
    expiresAt: body.expiresAt,
    rateLimitPerMinute: body.rateLimitPerMinute,
    communityId,
  });
  res.status(201).json({ key: created.key, secret: created.secret });
}

async function getKey(req, res) {
  const key = await apiKeys.get(req.params.keyId, req.principal.ownerUserId);
  // A key that belongs to somebody else is not found rather than forbidden:
  // the answer must not say that the id exists.
  if (!key) return fail(res, 'NOT_FOUND', 'key not found');
  res.json({ key });
}

async function rotateKey(req, res) {
  const body = req.body || {};
  const out = await apiKeys.rotate(req.params.keyId, req.principal.ownerUserId, {
    overlapSeconds: body.overlapSeconds,
  });
  if (!out) return fail(res, 'NOT_FOUND', 'key not found');
  res.json({
    key: out.key,
    secret: out.secret,
    previousSecretExpiresAt: out.previousSecretExpiresAt,
  });
}

async function revokeKey(req, res) {
  const body = req.body || {};
  const out = await apiKeys.revoke(req.params.keyId, req.principal.ownerUserId, body.reason);
  if (!out) return fail(res, 'NOT_FOUND', 'key not found');
  res.json({ key: out });
}

async function keyUsage(req, res) {
  const key = await apiKeys.get(req.params.keyId, req.principal.ownerUserId);
  if (!key) return fail(res, 'NOT_FOUND', 'key not found');
  const spent = await usage.summary(key.id, { minutes: windowMinutes(req.query.minutes) });
  res.json({
    keyId: key.id,
    windowMinutes: spent.windowMinutes,
    totals: spent.totals,
    byRoute: spent.byRoute,
    lastFailure: spent.lastFailure,
  });
}

async function keyHealth(req, res) {
  const key = await apiKeys.get(req.params.keyId, req.principal.ownerUserId);
  if (!key) return fail(res, 'NOT_FOUND', 'key not found');
  res.json(await health.keyHealth(key, { minutes: windowMinutes(req.query.minutes) }));
}

const definitions = [
  {
    method: 'get',
    path: '/keys',
    auth: 'principal',
    scopes: ['keys:read'],
    bots: false,
    tags: ['Keys'],
    summary: 'The API keys of the caller',
    description: 'Every key the account the caller acts for holds. The secret is never part of the answer.',
    responses: {
      200: ok('The ', { type: 'object', required: ['keys'], properties: { keys: { type: 'array', items: ref('Key') } } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
    },
    handler: listKeys,
  },
  {
    method: 'post',
    path: '/keys',
    auth: 'principal',
    scopes: ['keys:write'],
    bots: false,
    tags: ['Keys'],
    summary: 'Create an API key',
    description:
      'Creates a key with an explicit scope set. The secret is in the answer and in no other place: it is not stored and cannot be recovered.'
      + ' A machine credential may only create a key whose scopes are a subset of its own.',
    requestBody: requestBody({
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'A label for the operator.' },
        scopes: { type: 'array', items: { type: 'string' }, description: 'The scopes the key carries.' },
        expiresAt: { type: 'string', format: 'date-time', description: 'When the key stops working.' },
        rateLimitPerMinute: { type: 'integer', description: 'Requests per minute the key may make.' },
        communityId: { type: 'string', description: 'The community the key is bound to.' },
      },
    }, 'The key to create.'),
    responses: {
      201: ok('The key, and its secret. This is the only time the secret is returned.', {
        type: 'object',
        required: ['key', 'secret'],
        properties: { key: ref('Key'), secret: { type: 'string' } },
      }),
      400: ERRORS.badRequest,
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
    },
    handler: createKey,
  },
  {
    method: 'get',
    path: '/keys/:keyId',
    auth: 'principal',
    scopes: ['keys:read'],
    bots: false,
    tags: ['Keys'],
    summary: 'One API key',
    description: 'The key with this id, if the caller\'s account holds it.',
    parameters: [pathParam('keyId', 'The key id.')],
    responses: {
      200: ok('The key.', { type: 'object', required: ['key'], properties: { key: ref('Key') } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: getKey,
  },
  {
    method: 'post',
    path: '/keys/:keyId/rotate',
    auth: 'principal',
    scopes: ['keys:write'],
    bots: false,
    tags: ['Keys'],
    summary: 'Rotate an API key',
    description:
      'Issues a new secret and keeps the key\'s identity: the same key id, the same name, the same scopes.'
      + ' The previous secret keeps working until the end of the overlap window.',
    parameters: [pathParam('keyId', 'The key id.')],
    requestBody: requestBody({
      type: 'object',
      properties: {
        overlapSeconds: {
          type: 'integer',
          description: 'How long the previous secret keeps working. Zero ends it at once.',
        },
      },
    }, 'How to rotate.'),
    responses: {
      200: ok('The key, and its new secret.', {
        type: 'object',
        required: ['key', 'secret'],
        properties: {
          key: ref('Key'),
          secret: { type: 'string' },
          previousSecretExpiresAt: { type: 'string', format: 'date-time' },
        },
      }),
      400: ERRORS.badRequest,
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: rotateKey,
  },
  {
    method: 'post',
    path: '/keys/:keyId/revoke',
    auth: 'principal',
    scopes: ['keys:write'],
    bots: false,
    tags: ['Keys'],
    summary: 'Revoke an API key',
    description: 'Withdraws the key. Every secret it ever issued stops working at once.',
    parameters: [pathParam('keyId', 'The key id.')],
    requestBody: requestBody({
      type: 'object',
      properties: { reason: { type: 'string', description: 'Why the key was withdrawn.' } },
    }, 'Why the key is being withdrawn.'),
    responses: {
      200: ok('The revoked key.', { type: 'object', required: ['key'], properties: { key: ref('Key') } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: revokeKey,
  },
  {
    method: 'get',
    path: '/keys/:keyId/usage',
    auth: 'principal',
    scopes: ['keys:read'],
    bots: false,
    tags: ['Keys'],
    summary: 'What a key has spent',
    description: 'The requests the key has made over a window, by route and by outcome.',
    parameters: [
      pathParam('keyId', 'The key id.'),
      queryParam('minutes', 'The window to report over, in minutes.', { type: 'integer' }),
    ],
    responses: {
      200: ok('The usage.', ref('Usage')),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: keyUsage,
  },
  {
    method: 'get',
    path: '/keys/:keyId/health',
    auth: 'principal',
    scopes: ['keys:read'],
    bots: false,
    tags: ['Keys'],
    summary: 'Whether a key is working',
    description: 'Whether the key is configured, active or failing, what limit it is under and when it last failed.',
    parameters: [
      pathParam('keyId', 'The key id.'),
      queryParam('minutes', 'The window the failures are read over, in minutes.', { type: 'integer' }),
    ],
    responses: {
      200: ok('The health.', ref('Health')),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: keyHealth,
  },
];


module.exports = { definitions, listKeys, createKey, getKey, rotateKey, revokeKey, keyUsage, keyHealth };

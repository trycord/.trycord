// The community, application, command and message routes.
//
// An application is a community resource. It is created by somebody who
// administers the community, it posts as itself, and it answers slash
// commands. What it never has is a login: its token is its credential, and
// the credential carries the scopes that say what it may do.

const { ref, pathParam, queryParam, requestBody, ok, ERRORS } = require('./metadata');
const bots = require('../../services/bots');
const apiKeys = require('../../services/apiKeys');
const developerBots = require('../../services/developer/bots');
const events = require('../../services/developer/events');
const instance = require('../../services/developer/instance');
const db = require('../../db');
const { fail } = require('../../errors');
const { visibleChannel } = require('../../util');
const { hasChannelPermission } = require('../../services/permissions');

const MAX_MEMBERS = 200;
const MAX_MESSAGES = 100;

async function getCommunity(req, res) {
  const server = req.server;
  const members = await db.get(
    'SELECT COUNT(*) AS n FROM server_members WHERE server_id = ?',
    [server.id]
  );
  res.json({
    community: {
      id: server.id,
      name: server.name,
      description: server.description || null,
      iconUrl: server.icon_url || null,
      ownerUserId: server.owner_id,
      memberCount: Number((members && members.n) || 0),
      createdAt: server.created_at,
    },
  });
}

async function listMembers(req, res) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), MAX_MEMBERS);
  const rows = await db.all(
    'SELECT m.user_id AS userId, m.joined_at AS joinedAt, u.username, u.display_name AS displayName'
    + ' FROM server_members m JOIN users u ON u.id = m.user_id'
    + ' WHERE m.server_id = ? ORDER BY m.joined_at LIMIT ' + limit,
    [req.server.id]
  );
  res.json({ members: rows });
}

function credentialShape(row) {
  if (!row) return null;
  return {
    id: row.key_id,
    scopes: apiKeys.readScopes(row.scopes),
    rateLimitPerMinute: Number(row.rate_limit_per_minute),
    status: row.status,
    lastUsedAt: row.last_used_at || null,
    createdAt: row.created_at,
  };
}

async function listApplications(req, res) {
  const apps = await bots.listApps(req.server.id);
  const applications = [];
  for (const app of apps) {
    const credential = await developerBots.credentialOf(app.id);
    applications.push(Object.assign({}, app, { credential: credentialShape(credential) }));
  }
  res.json({ applications });
}

async function createApplication(req, res) {
  const body = req.body || {};
  const created = await developerBots.create({
    serverId: req.server.id,
    ownerUserId: req.user.id,
    name: body.name,
    description: body.description,
    iconUrl: body.iconUrl,
    scopes: body.scopes,
    rateLimitPerMinute: body.rateLimitPerMinute,
  });
  res.status(201).json({
    application: created.application,
    token: created.token,
    credential: created.credential,
  });
}

async function getApplication(req, res) {
  const app = await bots.getApp(req.params.applicationId, req.server.id);
  if (!app) return fail(res, 'NOT_FOUND', 'application not found');
  const credential = await developerBots.credentialOf(app.id);
  res.json({ application: app, credential: credentialShape(credential) });
}

// Give an application its developer credential, or change the scopes it has.
async function setApplicationCredential(req, res) {
  const body = req.body || {};
  const credential = await developerBots.setCredential(req.params.applicationId, req.server.id, {
    scopes: body.scopes,
    rateLimitPerMinute: body.rateLimitPerMinute,
  });
  if (!credential) return fail(res, 'NOT_FOUND', 'application not found');
  res.json({ credential });
}

async function rotateApplicationToken(req, res) {
  const out = await developerBots.rotateToken(req.params.applicationId, req.server.id);
  if (!out) return fail(res, 'NOT_FOUND', 'application not found');
  res.json({ application: out.application, token: out.token });
}

async function revokeApplication(req, res) {
  const body = req.body || {};
  const out = await developerBots.revoke(req.params.applicationId, req.server.id, body.reason);
  if (!out) return fail(res, 'NOT_FOUND', 'application not found');
  // The application is disconnected at once. An administrator who revokes a
  // token has said that the application must stop hearing things, and a
  // socket that is already open would otherwise keep hearing them until it
  // noticed.
  const gateway = require('../../services/developer/gateway');
  await gateway.disconnectRevoked();
  res.json({ application: out });
}

async function applicationHealth(req, res) {
  const out = await developerBots.health(req.params.applicationId, req.server.id);
  if (!out) return fail(res, 'NOT_FOUND', 'application not found');
  res.json(out);
}

async function listCommands(req, res) {
  const app = await bots.getApp(req.params.applicationId, req.server.id);
  if (!app) return fail(res, 'NOT_FOUND', 'application not found');
  res.json({ commands: await bots.listCommands(app.id) });
}

async function putCommand(req, res) {
  const command = await bots.setCommand(req.params.applicationId, req.server.id, req.body || {});
  if (!command) return fail(res, 'NOT_FOUND', 'application not found');
  res.json({ command });
}

async function deleteCommand(req, res) {
  const removed = await bots.removeCommand(req.params.commandId, req.params.applicationId, req.server.id);
  if (!removed) return fail(res, 'NOT_FOUND', 'command not found');
  res.json({ ok: true });
}

// The recent messages of a channel.
async function listMessages(req, res) {
  const channel = await visibleChannel(req.params.channelId, req.user.id, req.server.id);
  if (!channel) return fail(res, 'NOT_FOUND', 'channel not found');
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), MAX_MESSAGES);
  const rows = await db.all(
    'SELECT * FROM messages WHERE channel_id = ? ORDER BY seq DESC LIMIT ' + limit,
    [channel.id]
  );
  res.json({ messages: rows.reverse() });
}

// Post a message as an application.
//
// The caller has to be the application: this route posts in the application's
// name, and a person posting as themselves has the ordinary message API for
// that.
async function postMessage(req, res) {
  const principal = req.principal;
  if (principal.kind !== 'bot' || !principal.botApplicationId) {
    return fail(res, 'BOT_NOT_ALLOWED', 'this endpoint posts as an application', 403);
  }
  const app = await bots.getApp(principal.botApplicationId, req.server.id);
  if (!app) return fail(res, 'NOT_FOUND', 'application not found');

  const channel = await visibleChannel(req.params.channelId, req.user.id, req.server.id);
  if (!channel) return fail(res, 'NOT_FOUND', 'channel not found');
  // The permission is evaluated for the owner, so an application cannot post
  // where its owner could not.
  if (!(await hasChannelPermission(app.owner_user_id, channel.server_id, channel.id, 'SEND_MESSAGES'))) {
    return fail(res, 'PERMISSION_DENIED', 'the application owner cannot post in this channel');
  }
  const content = String((req.body || {}).content || '').trim().slice(0, 2000);
  if (!content) return fail(res, 'VALIDATION_ERROR', 'content is required');

  const posted = await bots.postAsApp(app, channel, content);
  if (!posted) return fail(res, 'VALIDATION_ERROR', 'content is required');

  events.dispatchInBackground({
    communityId: channel.server_id,
    type: 'message.created',
    instance: instance.info(),
    channelId: channel.id,
    actor: { id: app.id, type: 'application' },
    data: {
      message: { id: posted.id, authorId: app.owner_user_id, content },
    },
  });

  res.status(201).json({
    id: posted.id,
    channel_id: channel.id,
    author_id: app.owner_user_id,
    content,
    created_at: posted.created_at,
    seq: posted.seq,
    attachments: [],
  });
}

const definitions = [
  {
    method: 'get',
    path: '/communities/:serverId',
    auth: 'principal',
    scopes: ['communities:read'],
    bots: false,
    community: 'member',
    tags: ['Communities'],
    summary: 'A community',
    description: 'The community the caller belongs to.',
    parameters: [pathParam('serverId', 'The community id or its slug.')],
    responses: {
      200: ok('The community.', { type: 'object', required: ['community'], properties: { community: { type: 'object', additionalProperties: true } } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: getCommunity,
  },
  {
    method: 'get',
    path: '/communities/:serverId/members',
    auth: 'principal',
    scopes: ['members:read'],
    bots: false,
    community: 'member',
    tags: ['Communities'],
    summary: 'The members of a community',
    description: 'The members of the community the caller belongs to.',
    parameters: [
      pathParam('serverId', 'The community id or its slug.'),
      queryParam('limit', 'How many members to return.', { type: 'integer' }),
    ],
    responses: {
      200: ok('The members.', { type: 'object', required: ['members'], properties: { members: { type: 'array', items: ref('Member') } } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: listMembers,
  },

  {
    method: 'get',
    path: '/communities/:serverId/applications',
    auth: 'principal',
    scopes: ['bots:read'],
    bots: false,
    community: 'manage',
    tags: ['Applications'],
    summary: 'The bot applications of a community',
    description: 'Every application in the community, with the credential that carries its scopes.',
    parameters: [pathParam('serverId', 'The community id or its slug.')],
    responses: {
      200: ok('The applications.', { type: 'object', required: ['applications'], properties: { applications: { type: 'array', items: ref('Application') } } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: listApplications,
  },
  {
    method: 'post',
    path: '/communities/:serverId/applications',
    auth: 'principal',
    scopes: ['communities:write', 'bots:write'],
    bots: false,
    community: 'manage',
    tags: ['Applications'],
    summary: 'Create a bot application',
    description:
      'Creates an application, its token and the credential that carries its scopes.'
      + ' The token is in the answer and in no other place.',
    parameters: [pathParam('serverId', 'The community id or its slug.')],
    requestBody: requestBody({
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        iconUrl: { type: 'string' },
        scopes: { type: 'array', items: { type: 'string' } },
        rateLimitPerMinute: { type: 'integer' },
      },
    }, 'The application to create.'),
    responses: {
      201: ok('The application, its token and its credential.', {
        type: 'object',
        required: ['application', 'token'],
        properties: {
          application: ref('Application'),
          token: { type: 'string' },
          credential: ref('Credential'),
        },
      }),
      400: ERRORS.badRequest,
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
    },
    handler: createApplication,
  },
  {
    method: 'get',
    path: '/communities/:serverId/applications/:applicationId',
    auth: 'principal',
    scopes: ['bots:read'],
    bots: true,
    community: 'manage',
    tags: ['Applications'],
    summary: 'One bot application',
    description: 'The application, and the credential that carries its scopes.',
    parameters: [
      pathParam('serverId', 'The community id or its slug.'),
      pathParam('applicationId', 'The application id.'),
    ],
    responses: {
      200: ok('The application.', {
        type: 'object',
        required: ['application'],
        properties: { application: ref('Application'), credential: ref('Credential') },
      }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: getApplication,
  },
  {
    method: 'put',
    path: '/communities/:serverId/applications/:applicationId/credential',
    auth: 'principal',
    scopes: ['communities:write', 'bots:write'],
    bots: false,
    community: 'manage',
    tags: ['Applications'],
    summary: 'Set the credential of an application',
    description:
      'Gives an application the scopes it may use and the limit it is under.'
      + ' An application created before the developer platform existed has no credential until this is called.',
    parameters: [
      pathParam('serverId', 'The community id or its slug.'),
      pathParam('applicationId', 'The application id.'),
    ],
    requestBody: requestBody({
      type: 'object',
      properties: {
        scopes: { type: 'array', items: { type: 'string' } },
        rateLimitPerMinute: { type: 'integer' },
      },
    }, 'The scopes and the limit.'),
    responses: {
      200: ok('The credential.', { type: 'object', required: ['credential'], properties: { credential: ref('Credential') } }),
      400: ERRORS.badRequest,
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: setApplicationCredential,
  },
  {
    method: 'post',
    path: '/communities/:serverId/applications/:applicationId/rotate-token',
    auth: 'principal',
    scopes: ['communities:write', 'bots:write'],
    bots: false,
    community: 'manage',
    tags: ['Applications'],
    summary: 'Rotate the token of an application',
    description:
      'Issues a new token. The previous token stops working at once: the application holds one token,'
      + ' so there is no overlap window here.',
    parameters: [
      pathParam('serverId', 'The community id or its slug.'),
      pathParam('applicationId', 'The application id.'),
    ],
    responses: {
      200: ok('The application and its new token.', {
        type: 'object',
        required: ['application', 'token'],
        properties: { application: ref('Application'), token: { type: 'string' } },
      }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: rotateApplicationToken,
  },
  {
    method: 'post',
    path: '/communities/:serverId/applications/:applicationId/revoke',
    auth: 'principal',
    scopes: ['communities:write', 'bots:write'],
    bots: false,
    community: 'manage',
    tags: ['Applications'],
    summary: 'Revoke an application',
    description: 'Withdraws the token and disables the application. The token stops working at once.',
    parameters: [
      pathParam('serverId', 'The community id or its slug.'),
      pathParam('applicationId', 'The application id.'),
    ],
    requestBody: requestBody({
      type: 'object',
      properties: { reason: { type: 'string' } },
    }, 'Why the application is being withdrawn.'),
    responses: {
      200: ok('The application.', { type: 'object', required: ['application'], properties: { application: ref('Application') } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: revokeApplication,
  },
  {
    method: 'get',
    path: '/communities/:serverId/applications/:applicationId/health',
    auth: 'principal',
    scopes: ['bots:read'],
    bots: true,
    community: 'manage',
    tags: ['Applications'],
    summary: 'Whether an application is working',
    description: 'Whether the application is configured, active or failing, and when it last failed.',
    parameters: [
      pathParam('serverId', 'The community id or its slug.'),
      pathParam('applicationId', 'The application id.'),
    ],
    responses: {
      200: ok('The health.', ref('Health')),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: applicationHealth,
  },
  {
    method: 'get',
    path: '/communities/:serverId/applications/:applicationId/commands',
    auth: 'principal',
    scopes: ['commands:read'],
    bots: true,
    community: 'manage',
    tags: ['Applications'],
    summary: 'The commands an application answers',
    description: 'The slash commands the application answers, with the options each one declares.',
    parameters: [
      pathParam('serverId', 'The community id or its slug.'),
      pathParam('applicationId', 'The application id.'),
    ],
    responses: {
      200: ok('The commands.', { type: 'object', required: ['commands'], properties: { commands: { type: 'array', items: ref('Command') } } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: listCommands,
  },
  {
    method: 'put',
    path: '/communities/:serverId/applications/:applicationId/commands',
    auth: 'principal',
    scopes: ['communities:write', 'commands:write'],
    bots: false,
    community: 'manage',
    tags: ['Applications'],
    summary: 'Register a command',
    description: 'Registers a slash command, or replaces the one with the same name.',
    parameters: [
      pathParam('serverId', 'The community id or its slug.'),
      pathParam('applicationId', 'The application id.'),
    ],
    requestBody: requestBody({
      type: 'object',
      required: ['name', 'response'],
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        response: { type: 'string' },
        options: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    }, 'The command.'),
    responses: {
      200: ok('The command.', { type: 'object', required: ['command'], properties: { command: ref('Command') } }),
      400: ERRORS.badRequest,
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: putCommand,
  },
  {
    method: 'delete',
    path: '/communities/:serverId/applications/:applicationId/commands/:commandId',
    auth: 'principal',
    scopes: ['communities:write', 'commands:write'],
    bots: false,
    community: 'manage',
    tags: ['Applications'],
    summary: 'Remove a command',
    description: 'Removes a slash command the application answered.',
    parameters: [
      pathParam('serverId', 'The community id or its slug.'),
      pathParam('applicationId', 'The application id.'),
      pathParam('commandId', 'The command id.'),
    ],
    responses: {
      200: ok('The command is gone.', { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: deleteCommand,
  },

  {
    method: 'get',
    path: '/communities/:serverId/channels/:channelId/messages',
    auth: 'principal',
    scopes: ['messages:read'],
    bots: true,
    community: 'member',
    tags: ['Messages'],
    summary: 'The recent messages of a channel',
    description: 'The most recent messages of a channel the caller can see.',
    parameters: [
      pathParam('serverId', 'The community id or its slug.'),
      pathParam('channelId', 'The channel id or its slug.'),
      queryParam('limit', 'How many messages to return.', { type: 'integer' }),
    ],
    responses: {
      200: ok('The messages.', { type: 'object', required: ['messages'], properties: { messages: { type: 'array', items: ref('Message') } } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: listMessages,
  },
  {
    method: 'post',
    path: '/communities/:serverId/channels/:channelId/messages',
    auth: 'principal',
    scopes: ['communities:write', 'messages:write'],
    bots: true,
    community: 'member',
    tags: ['Messages'],
    summary: 'Post a message as an application',
    description:
      'Posts a message in the application\'s name. Only an application credential may use this route;'
      + ' a person posting as themselves has the ordinary message API for that.',
    parameters: [
      pathParam('serverId', 'The community id or its slug.'),
      pathParam('channelId', 'The channel id or its slug.'),
    ],
    requestBody: requestBody({
      type: 'object',
      required: ['content'],
      properties: { content: { type: 'string' } },
    }, 'The message.'),
    responses: {
      201: ok('The message.', ref('Message')),
      400: ERRORS.badRequest,
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: postMessage,
  },
];


module.exports = {
  definitions,
  getCommunity, listMembers,
  listApplications, createApplication, getApplication, setApplicationCredential,
  rotateApplicationToken, revokeApplication, applicationHealth,
  listCommands, putCommand, deleteCommand, listMessages, postMessage,
};

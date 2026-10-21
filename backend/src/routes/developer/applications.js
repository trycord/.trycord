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
const communityRoles = require('../../services/roles');

const MAX_MEMBERS = 200;
const MAX_MEMBER_OFFSET = 1000000;
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
  const requestedOffset = Number.parseInt(req.query.offset, 10);
  const offset = Number.isFinite(requestedOffset)
    ? Math.min(Math.max(requestedOffset, 0), MAX_MEMBER_OFFSET)
    : 0;
  const count = await db.get(
    'SELECT COUNT(*) AS total FROM server_members WHERE server_id = ?',
    [req.server.id]
  );
  const rows = await db.all(
    'SELECT m.user_id AS userId, m.joined_at AS joinedAt, u.username, u.display_name AS displayName'
    + ', u.avatar_url AS avatarUrl, u.is_bot AS isBot'
    + ' FROM server_members m JOIN users u ON u.id = m.user_id'
    + ' WHERE m.server_id = ? ORDER BY m.joined_at, m.user_id LIMIT ' + limit + ' OFFSET ' + offset,
    [req.server.id]
  );
  const total = Number((count && count.total) || 0);
  res.json({
    members: rows.map((member) => Object.assign({}, member, { isBot: !!member.isBot })),
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total,
  });
}

async function getChannel(req, res) {
  const channel = await visibleChannel(req.params.channelId, req.user.id, req.server.id);
  if (!channel) return fail(res, 'NOT_FOUND', 'channel not found');
  res.json({ channel });
}

async function listRoles(req, res) {
  res.json({ roles: await communityRoles.list(req.server.id) });
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
  res.json({ application: bots.appShape(app), credential: credentialShape(credential) });
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
  if (!canReadApplicationTools(req)) return fail(res, 'PERMISSION_DENIED', 'you cannot inspect this application', 403);
  const out = await developerBots.health(req.params.applicationId, req.server.id);
  if (!out) return fail(res, 'NOT_FOUND', 'application not found');
  res.json(out);
}

async function listCommands(req, res) {
  if (!canReadApplicationTools(req)) return fail(res, 'PERMISSION_DENIED', 'you cannot inspect this application', 403);
  const app = await bots.getApp(req.params.applicationId, req.server.id);
  if (!app) return fail(res, 'NOT_FOUND', 'application not found');
  res.json({ commands: await bots.listCommands(app.id) });
}

function canReadApplicationTools(req) {
  const principal = req.principal || {};
  if (principal.kind === 'bot') {
    return String(principal.botApplicationId) === String(req.params.applicationId)
      && String(principal.communityId) === String(req.server.id);
  }
  const permissions = (req.access && req.access.permissions) || [];
  return permissions.includes('*') || permissions.includes('MANAGE_SERVER');
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
  const before = req.query.before === undefined ? null : Number(req.query.before);
  if (before !== null && (!Number.isSafeInteger(before) || before < 1)) {
    return fail(res, 'VALIDATION_ERROR', 'before must be a positive message sequence', 400);
  }
  const params = [channel.id];
  let cursorClause = '';
  if (before !== null) {
    cursorClause = ' AND seq < ?';
    params.push(before);
  }
  const rows = await db.all(
    'SELECT * FROM messages WHERE channel_id = ?' + cursorClause
      + ' ORDER BY seq DESC LIMIT ' + (limit + 1),
    params
  );
  const hasMore = rows.length > limit;
  const messages = rows.slice(0, limit).reverse();
  res.json({
    messages,
    limit,
    before,
    hasMore,
    nextBefore: hasMore && messages.length ? Number(messages[0].seq) : null,
  });
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
  // The permission is evaluated for the bot's own account, so an application
  // posts with the rights the community gave it - and cannot post where the
  // community would not let it.
  const author = bots.botUserIdOf(app);
  if (!(await hasChannelPermission(author, channel.server_id, channel.id, 'SEND_MESSAGES'))) {
    return fail(res, 'PERMISSION_DENIED', 'the application cannot post in this channel');
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
      message: { id: posted.id, authorId: author, content },
    },
  });

  res.status(201).json({
    id: posted.id,
    channel_id: channel.id,
    // The bot wrote it, so the bot is the author.
    author_id: posted.author_id,
    content,
    created_at: posted.created_at,
    seq: posted.seq,
    attachments: [],
  });
}

// GET /api/v1/applications/self
//
// Which application the token belongs to.
//
// A program that has only the token needs to know what it is before it can
// open the gateway - the handshake names the application - and the answer is
// the application and its community. The token is not in it: the token is
// what the caller already has, and a route that answers "here is your
// token" is a route that writes secrets into logs.
async function getSelf(req, res) {
  const principal = req.principal;
  const applicationId = principal.botApplicationId || principal.id;
  const application = await bots.getApp(applicationId, principal.communityId);
  if (!application) return fail(res, 'NOT_FOUND', 'no such application', 404);
  const community = await db.get('SELECT id, name FROM servers WHERE id = ?', [application.server_id]);
  res.json({
    application: bots.appShape(application),
    communityId: application.server_id,
    communityName: community ? community.name : null,
  });
}

// PATCH /api/v1/communities/:serverId/applications/:applicationId
//
// Change an application: its name, its description, its picture, or whether
// it is switched on.
//
// Switching an application off is not the same as deleting it. A disabled
// application keeps its commands and its identity and comes back when it is
// switched on; a deleted one is gone.
async function updateApplication(req, res) {
  const app = await bots.updateApp(req.params.applicationId, req.server.id, req.body || {});
  if (!app) return fail(res, 'NOT_FOUND', 'application not found');
  res.json({ application: app });
}

// DELETE /api/v1/communities/:serverId/applications/:applicationId
//
// Take the application away for good.
//
// The token stops working with the row, and the bot's account leaves the
// community, so an application that is gone cannot be spoken for either.
async function deleteApplication(req, res) {
  const removed = await bots.removeApp(req.params.applicationId, req.server.id);
  if (!removed) return fail(res, 'NOT_FOUND', 'application not found');
  res.json({ ok: true });
}

const definitions = [
  {
    method: 'patch',
    path: '/communities/:serverId/applications/:applicationId',
    auth: 'principal',
    scopes: ['communities:write', 'bots:write'],
    bots: false,
    community: 'manage',
    tags: ['Applications'],
    summary: 'Change a bot application',
    description:
      'Changes the name, the description, the picture, or whether the application is switched on.'
      + ' A disabled application keeps its commands and comes back when it is switched on.',
    parameters: [
      pathParam('serverId', 'The community id or its slug.'),
      pathParam('applicationId', 'The application id.'),
    ],
    requestBody: requestBody({
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        iconUrl: { type: 'string' },
        status: { type: 'string', enum: ['active', 'disabled'] },
      },
    }, 'What to change.'),
    responses: {
      200: ok('The application.', {
        type: 'object',
        required: ['application'],
        properties: { application: ref('Application') },
      }),
      400: ERRORS.badRequest,
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: updateApplication,
  },
  {
    method: 'delete',
    path: '/communities/:serverId/applications/:applicationId',
    auth: 'principal',
    scopes: ['communities:write', 'bots:write'],
    bots: false,
    community: 'manage',
    tags: ['Applications'],
    summary: 'Delete a bot application',
    description:
      'Deletes the application, which ends its token at once, and takes its bot out of the community.'
      + ' The messages it wrote stay where they are.',
    parameters: [
      pathParam('serverId', 'The community id or its slug.'),
      pathParam('applicationId', 'The application id.'),
    ],
    responses: {
      200: ok('The application is gone.', { type: 'object', properties: { ok: { type: 'boolean' } } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: deleteApplication,
  },
  {
    method: 'get',
    path: '/applications/self',
    auth: 'principal',
    // No scope is needed to ask a credential what it is: the token is the
    // proof, and the answer holds nothing the caller did not already have.
    scopes: [],
    bots: true,
    tags: ['Applications'],
    summary: 'The application this token belongs to',
    description:
      'The application the token belongs to, and the community it was made in.'
      + ' The token itself is never in the answer.',
    responses: {
      200: ok('The application.', {
        type: 'object',
        required: ['application'],
        properties: {
          application: ref('Application'),
          communityId: { type: 'string' },
          communityName: { type: 'string' },
        },
      }),
      401: ERRORS.unauthenticated,
      404: ERRORS.missing,
    },
    handler: getSelf,
  },
  {
    method: 'get',
    path: '/communities/:serverId',
    auth: 'principal',
    scopes: ['communities:read'],
    bots: true,
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
    bots: true,
    community: 'member',
    tags: ['Communities'],
    summary: 'The members of a community',
    description: 'The members of the community the caller belongs to.',
    parameters: [
      pathParam('serverId', 'The community id or its slug.'),
      queryParam('limit', 'How many members to return.', { type: 'integer' }),
      queryParam('offset', 'How many members to skip.', { type: 'integer' }),
    ],
    responses: {
      200: ok('A page of members.', { type: 'object', required: ['members', 'total', 'limit', 'offset', 'hasMore'], properties: {
        members: { type: 'array', items: ref('Member') },
        total: { type: 'integer' },
        limit: { type: 'integer' },
        offset: { type: 'integer' },
        hasMore: { type: 'boolean' },
      } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: listMembers,
  },
  {
    method: 'get',
    path: '/communities/:serverId/channels/:channelId',
    auth: 'principal',
    scopes: ['channels:read'],
    bots: true,
    community: 'member',
    tags: ['Communities'],
    summary: 'A channel',
    description: 'The channel named by this community, for a member who can read channel details.',
    parameters: [
      pathParam('serverId', 'The community id or its slug.'),
      pathParam('channelId', 'The channel id or its slug.'),
    ],
    responses: {
      200: ok('The channel.', { type: 'object', required: ['channel'], properties: { channel: ref('Channel') } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: getChannel,
  },
  {
    method: 'get',
    path: '/communities/:serverId/roles',
    auth: 'principal',
    scopes: ['roles:read'],
    bots: true,
    community: 'member',
    tags: ['Communities'],
    summary: 'The roles of a community',
    description: 'Role names, colors and permissions in the community the caller belongs to.',
    parameters: [pathParam('serverId', 'The community id or its slug.')],
    responses: {
      200: ok('The roles.', { type: 'object', required: ['roles'], properties: { roles: { type: 'array', items: ref('Role') } } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: listRoles,
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
    community: 'member',
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
    community: 'member',
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
      queryParam('before', 'Return messages older than this message sequence.', { type: 'integer', minimum: 1 }),
    ],
    responses: {
      200: ok('A page of messages.', { type: 'object', required: ['messages', 'limit', 'hasMore', 'nextBefore'], properties: {
        messages: { type: 'array', items: ref('Message') },
        limit: { type: 'integer' },
        before: { type: ['integer', 'null'] },
        hasMore: { type: 'boolean' },
        nextBefore: { type: ['integer', 'null'] },
      } }),
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
    // Only the scope that says what the route does.
    //
    // It asked for `communities:write` as well, which says "may change this
    // community's developer configuration" - and posting a message does not
    // change the configuration. A bot that may post was told it could also
    // create applications and webhooks, which it still may not, but the
    // scope it was given said it might.
    scopes: ['messages:write'],
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

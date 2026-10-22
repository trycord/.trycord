// The schemas the OpenAPI document is written in.
//
// These are the shapes the routes actually answer with. They live next to the
// route definitions because that is where they belong: a schema that is
// somewhere else is a schema that drifts.

const error = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', description: 'A stable machine-readable code.' },
        message: { type: 'string', description: 'A human-readable explanation.' },
        details: { type: 'object', additionalProperties: true, description: 'Extra context, when there is any.' },
      },
    },
  },
};

const key = {
  type: 'object',
  description: 'A developer API key. The secret is never part of this shape.',
  required: ['id', 'name', 'status', 'scopes', 'rateLimitPerMinute', 'createdAt'],
  properties: {
    id: { type: 'string', description: 'The key id. It is stable across a rotation.' },
    name: { type: 'string' },
    kind: { type: 'string', enum: ['user', 'bot'] },
    status: { type: 'string', enum: ['active', 'expired', 'revoked'] },
    ownerUserId: { type: 'string', description: 'The account the key acts for.' },
    scopes: { type: 'array', items: { type: 'string' } },
    communityId: { type: ['string', 'null'] },
    botApplicationId: { type: ['string', 'null'] },
    rateLimitPerMinute: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    lastUsedAt: { type: ['string', 'null'], format: 'date-time' },
    expiresAt: { type: ['string', 'null'], format: 'date-time' },
    revokedAt: { type: ['string', 'null'], format: 'date-time' },
    revokedReason: { type: ['string', 'null'] },
    rotatedAt: { type: ['string', 'null'], format: 'date-time' },
    rotatedFrom: { type: ['string', 'null'] },
    previousSecretExpiresAt: { type: ['string', 'null'], format: 'date-time' },
  },
};

const credential = {
  type: 'object',
  description: "An application's developer credential: the scopes and the limit that go with it.",
  required: ['id', 'scopes', 'rateLimitPerMinute', 'status'],
  properties: {
    id: { type: 'string' },
    scopes: { type: 'array', items: { type: 'string' } },
    rateLimitPerMinute: { type: 'integer' },
    status: { type: 'string' },
    lastUsedAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const application = {
  type: 'object',
  required: ['id', 'serverId', 'ownerUserId', 'name', 'status', 'createdAt'],
  properties: {
    id: { type: 'string' },
    serverId: { type: 'string' },
    ownerUserId: { type: 'string' },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    iconUrl: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['active', 'disabled'] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    credential: { oneOf: [{ $ref: '#/components/schemas/Credential' }, { type: 'null' }] },
  },
};

const command = {
  type: 'object',
  required: ['id', 'applicationId', 'name', 'response', 'options'],
  properties: {
    id: { type: 'string' },
    applicationId: { type: 'string' },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    response: { type: 'string' },
    options: { type: 'array', items: { type: 'object', additionalProperties: true } },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

const webhook = {
  type: 'object',
  required: ['id', 'serverId', 'name', 'url', 'active', 'createdAt'],
  properties: {
    id: { type: 'string' },
    serverId: { type: 'string' },
    channelId: { type: ['string', 'null'] },
    name: { type: 'string' },
    url: { type: 'string' },
    active: { type: 'boolean' },
    createdBy: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const subscription = {
  type: 'object',
  required: ['id', 'webhookId', 'communityId', 'events', 'createdAt'],
  properties: {
    id: { type: 'string' },
    keyId: { type: ['string', 'null'] },
    ownerUserId: { type: ['string', 'null'] },
    webhookId: { type: 'string' },
    communityId: { type: 'string' },
    events: { type: 'array', items: { type: 'string' } },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const delivery = {
  type: 'object',
  required: ['id', 'eventType', 'status', 'createdAt'],
  properties: {
    id: { type: 'string' },
    eventType: { type: 'string' },
    status: { type: 'string', enum: ['delivered', 'failed'] },
    statusCode: { type: ['integer', 'null'] },
    error: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const usage = {
  type: 'object',
  required: ['windowMinutes', 'totals', 'byRoute'],
  properties: {
    keyId: { type: 'string' },
    windowMinutes: { type: 'integer' },
    totals: {
      type: 'object',
      required: ['requests', 'succeeded', 'clientErrors', 'serverErrors'],
      properties: {
        requests: { type: 'integer' },
        succeeded: { type: 'integer' },
        clientErrors: { type: 'integer' },
        serverErrors: { type: 'integer' },
      },
    },
    byRoute: {
      type: 'array',
      items: {
        type: 'object',
        required: ['route', 'requests'],
        properties: {
          route: { type: 'string' },
          requests: { type: 'integer' },
          succeeded: { type: 'integer' },
          clientErrors: { type: 'integer' },
          serverErrors: { type: 'integer' },
        },
      },
    },
    lastFailure: {
      type: ['object', 'null'],
      properties: {
        at: { type: 'string', format: 'date-time' },
        route: { type: 'string' },
        errors: { type: 'integer' },
      },
    },
  },
};

const health = {
  type: 'object',
  description: 'The state of a credential or an application, in words an operator can act on.',
  required: ['state'],
  properties: {
    state: { type: 'string', enum: ['configured', 'active', 'failing', 'revoked', 'disabled'] },
    usage: { type: ['object', 'null'], additionalProperties: true },
    routes: {
      type: 'array',
      description: 'What the recent window was spent on, busiest first. '
        + 'Only routes that were actually used appear.',
      items: {
        type: 'object',
        required: ['route', 'requests'],
        properties: {
          route: { type: 'string' },
          requests: { type: 'integer' },
          succeeded: { type: 'integer' },
          clientErrors: { type: 'integer' },
          serverErrors: { type: 'integer' },
        },
      },
    },
    lastFailure: { type: ['object', 'null'], additionalProperties: true },
    lastUsedAt: { type: ['string', 'null'], format: 'date-time' },
    rateLimitPerMinute: { type: ['integer', 'null'] },
  },
};

// The member account an application posts as. The username is what the rest
// of Trycord shows wherever the bot appears, so it is part of the answer
// wherever the application itself is.
const botAccount = {
  type: 'object',
  description: 'The member account an application posts as.',
  required: ['id', 'username', 'isBot'],
  properties: {
    id: { type: 'string' },
    username: { type: 'string' },
    displayName: { type: 'string' },
    isBot: { type: 'boolean' },
  },
};

const principal = {
  type: 'object',
  required: ['kind', 'id', 'ownerUserId'],
  properties: {
    kind: { type: 'string', enum: ['session', 'key', 'bot'] },
    id: { type: 'string' },
    ownerUserId: { type: 'string' },
    scopes: { type: ['array', 'null'], items: { type: 'string' } },
    rateLimitPerMinute: { type: ['integer', 'null'] },
    communityId: { type: ['string', 'null'] },
    botApplicationId: { type: ['string', 'null'] },
    rateLimit: { type: ['object', 'null'], additionalProperties: true },
  },
};

const message = {
  type: 'object',
  required: ['id', 'channel_id', 'author_id', 'content'],
  properties: {
    id: { type: 'string' },
      channel_id: { type: 'string' },
      author_id: { type: 'string' },
    content: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    seq: { type: 'integer' },
    attachments: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
};

const member = {
  type: 'object',
  required: ['userId'],
  properties: {
    userId: { type: 'string' },
    username: { type: 'string' },
    displayName: { type: 'string' },
    avatarUrl: { type: ['string', 'null'] },
    isBot: { type: 'boolean' },
    joinedAt: { type: ['string', 'null'], format: 'date-time' },
  },
};

const channel = {
  type: 'object',
  required: ['id', 'name', 'type'],
  properties: {
    id: { type: 'string' },
    server_id: { type: 'string' },
    name: { type: 'string' },
    type: { type: 'string' },
    topic: { type: ['string', 'null'] },
    category_id: { type: ['string', 'null'] },
    position: { type: 'integer' },
    slow_mode: { type: 'integer' },
  },
};

const role = {
  type: 'object',
  required: ['id', 'name'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    color: { type: ['string', 'null'] },
    permissions: { type: 'array', items: { type: 'string' } },
    position: { type: 'integer' },
  },
};

module.exports = {
  Error: error,
  Key: key,
  Credential: credential,
  Application: application,
  Command: command,
  BotAccount: botAccount,
  Webhook: webhook,
  Subscription: subscription,
  Delivery: delivery,
  Usage: usage,
  Health: health,
  Principal: principal,
  Message: message,
  Member: member,
  Channel: channel,
  Role: role,
  ScopeCatalogue: {
    type: 'object',
    required: ['groups'],
    properties: {
      groups: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'scopes'],
          properties: {
            name: { type: 'string' },
            scopes: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'description'],
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
  EventVocabulary: {
    type: 'object',
    required: ['envelope', 'types'],
    properties: {
      envelope: { type: 'object', additionalProperties: true },
      types: { type: 'array', items: { type: 'string' } },
    },
  },
  InstanceInfo: {
    type: 'object',
    required: ['instanceId', 'name', 'version', 'apiVersion', 'eventVersion'],
    properties: {
      instanceId: { type: 'string' },
      name: { type: 'string' },
      version: { type: 'string' },
      apiVersion: { type: 'string' },
      eventVersion: { type: 'integer' },
    },
  },
  ApiIndex: {
    type: 'object',
    required: ['name', 'apiVersion', 'openapi', 'scopes'],
    properties: {
      name: { type: 'string' },
      apiVersion: { type: 'string' },
      version: { type: 'string' },
      eventVersion: { type: 'integer' },
      basePath: { type: 'string' },
      openapi: { type: 'string' },
      scopes: { type: 'string' },
      events: { type: 'string' },
      documentation: { type: 'string' },
      instance: { type: 'object', additionalProperties: true },
    },
  },
  Diagnostics: {
    type: 'object',
    required: ['instance', 'counts'],
    properties: {
      instance: { type: 'object', additionalProperties: true },
      counts: { type: 'object', additionalProperties: { type: 'integer' } },
      events: { type: 'object', additionalProperties: true },
    },
  },
};

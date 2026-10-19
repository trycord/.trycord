// The webhook and subscription routes.
//
// A webhook is an endpoint a community points at itself. A subscription says
// which of that community's events are delivered to it, in the versioned
// envelope. The endpoint row and the delivery log are the ones the rest of
// the instance already uses, so there is one delivery history to read.

const { ref, pathParam, queryParam, requestBody, ok, ERRORS } = require('./metadata');
const webhooks = require('../../services/webhooks');
const subscriptions = require('../../services/developer/subscriptions');
const health = require('../../services/developer/health');
const { fail } = require('../../errors');
const { visibleChannel } = require('../../util');

async function listWebhooks(req, res) {
  res.json({ webhooks: await webhooks.list(req.server.id) });
}

async function createWebhook(req, res) {
  const body = req.body || {};
  let channelId = null;
  if (body.channelId) {
    const channel = await visibleChannel(body.channelId, req.user.id);
    if (!channel || channel.server_id !== req.server.id) {
      return fail(res, 'NOT_FOUND', 'channel not found in this community');
    }
    channelId = channel.id;
  }
  // The secret is returned exactly once. It is not stored and cannot be
  // recovered afterwards, which is what makes it rotatable.
  const hook = await webhooks.create({
    serverId: req.server.id,
    channelId,
    name: body.name,
    url: body.url,
    createdBy: req.user.id,
  });
  const subscription = await subscriptions.create({
    keyId: req.principal.kind === 'session' ? null : req.principal.id,
    ownerUserId: req.principal.ownerUserId,
    webhookId: hook.id,
    communityId: req.server.id,
    events: body.events,
  });
  res.status(201).json({ webhook: hook, subscription });
}

async function deleteWebhook(req, res) {
  const removed = await webhooks.remove(req.params.webhookId, req.server.id);
  if (!removed) return fail(res, 'NOT_FOUND', 'webhook not found');
  res.json({ ok: true });
}

async function rotateWebhookSecret(req, res) {
  const out = await webhooks.rotate(req.params.webhookId, req.server.id);
  if (!out) return fail(res, 'NOT_FOUND', 'webhook not found');
  res.json({ webhookId: out.id, secret: out.secret });
}

async function webhookDeliveries(req, res) {
  const rows = await webhooks.deliveries(req.params.webhookId, req.server.id, req.query.limit);
  if (rows === null) return fail(res, 'NOT_FOUND', 'webhook not found');
  res.json({ deliveries: rows });
}

async function webhookHealth(req, res) {
  const report = await health.webhookHealth(req.params.webhookId);
  if (!report) return fail(res, 'NOT_FOUND', 'webhook not found');
  res.json(report);
}

async function listSubscriptions(req, res) {
  res.json({ subscriptions: await subscriptions.list(req.server.id) });
}

async function createSubscription(req, res) {
  const body = req.body || {};
  const hook = await webhooks.get(body.webhookId, req.server.id);
  if (!hook) return fail(res, 'NOT_FOUND', 'webhook not found');
  const subscription = await subscriptions.create({
    keyId: req.principal.kind === 'session' ? null : req.principal.id,
    ownerUserId: req.principal.ownerUserId,
    webhookId: hook.id,
    communityId: req.server.id,
    events: body.events,
  });
  res.status(201).json({ subscription });
}

async function deleteSubscription(req, res) {
  const removed = await subscriptions.remove(req.params.subscriptionId, req.server.id);
  if (!removed) return fail(res, 'NOT_FOUND', 'subscription not found');
  res.json({ ok: true });
}

const definitions = [
  {
    method: 'get',
    path: '/communities/:serverId/webhooks',
    auth: 'principal',
    scopes: ['webhooks:read'],
    bots: false,
    community: 'manage',
    tags: ['Webhooks'],
    summary: 'The webhooks of a community',
    description: 'Every webhook the community has pointed at itself.',
    parameters: [pathParam('serverId', 'The community id or its slug.')],
    responses: {
      200: ok('The ', { type: 'object', required: ['webhooks'], properties: { webhooks: { type: 'array', items: ref('Webhook') } } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: listWebhooks,
  },
  {
    method: 'post',
    path: '/communities/:serverId/webhooks',
    auth: 'principal',
    scopes: ['communities:write', 'webhooks:manage'],
    bots: false,
    community: 'manage',
    tags: ['Webhooks'],
    summary: 'Create a webhook and subscribe it to events',
    description:
      'Points the community at an endpoint and subscribes that endpoint to the events named.'
      + ' The signing secret is in the answer and in no other place.',
    parameters: [pathParam('serverId', 'The community id or its slug.')],
    requestBody: requestBody({
      type: 'object',
      required: ['name', 'url', 'events'],
      properties: {
        name: { type: 'string' },
        url: { type: 'string', description: 'An https endpoint on a public address.' },
        channelId: { type: 'string' },
        events: { type: 'array', items: { type: 'string' }, description: 'The event types to deliver.' },
      },
    }, 'The webhook to create.'),
    responses: {
      201: ok('The webhook, its secret and its subscription.', {
        type: 'object',
        required: ['webhook'],
        properties: {
          webhook: ref('Webhook'),
          subscription: ref('Subscription'),
          secret: { type: 'string' },
        },
      }),
      400: ERRORS.badRequest,
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
    },
    handler: createWebhook,
  },
  {
    method: 'delete',
    path: '/communities/:serverId/webhooks/:webhookId',
    auth: 'principal',
    scopes: ['communities:write', 'webhooks:manage'],
    bots: false,
    community: 'manage',
    tags: ['Webhooks'],
    summary: 'Remove a webhook',
    description: 'Stops delivering to the endpoint and removes it.',
    parameters: [
      pathParam('serverId', 'The community id or its slug.'),
      pathParam('webhookId', 'The webhook id.'),
    ],
    responses: {
      200: ok('The webhook is gone.', { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: deleteWebhook,
  },
  {
    method: 'post',
    path: '/communities/:serverId/webhooks/:webhookId/rotate-secret',
    auth: 'principal',
    scopes: ['communities:write', 'webhooks:manage'],
    bots: false,
    community: 'manage',
    tags: ['Webhooks'],
    summary: 'Rotate the signing secret of a webhook',
    description: 'Issues a new signing secret. The previous secret stops working at once.',
    parameters: [
      pathParam('serverId', 'The community id or its slug.'),
      pathParam('webhookId', 'The webhook id.'),
    ],
    responses: {
      200: ok('The new secret.', { type: 'object', required: ['secret'], properties: { webhookId: { type: 'string' }, secret: { type: 'string' } } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: rotateWebhookSecret,
  },
  {
    method: 'get',
    path: '/communities/:serverId/webhooks/:webhookId/deliveries',
    auth: 'principal',
    scopes: ['webhooks:read'],
    bots: false,
    community: 'manage',
    tags: ['Webhooks'],
    summary: 'The delivery log of a webhook',
    description: 'What was delivered to the endpoint, and what was not.',
    parameters: [
      pathParam('serverId', 'The community id or its slug.'),
      pathParam('webhookId', 'The webhook id.'),
      queryParam('limit', 'How many deliveries to return.', { type: 'integer' }),
    ],
    responses: {
      200: ok('The deliveries.', { type: 'object', required: ['deliveries'], properties: { deliveries: { type: 'array', items: ref('Delivery') } } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: webhookDeliveries,
  },
  {
    method: 'get',
    path: '/communities/:serverId/webhooks/:webhookId/health',
    auth: 'principal',
    scopes: ['webhooks:read'],
    bots: false,
    community: 'manage',
    tags: ['Webhooks'],
    summary: 'Whether a webhook is working',
    description: 'How many deliveries landed, how many did not, and when the last one did not.',
    parameters: [
      pathParam('serverId', 'The community id or its slug.'),
      pathParam('webhookId', 'The webhook id.'),
    ],
    responses: {
      200: ok('The health.', ref('Health')),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: webhookHealth,
  },
  {
    method: 'get',
    path: '/communities/:serverId/subscriptions',
    auth: 'principal',
    scopes: ['events:read'],
    bots: false,
    community: 'manage',
    tags: ['Events'],
    summary: 'The event subscriptions of a community',
    description: 'Which webhook is subscribed to which events.',
    parameters: [pathParam('serverId', 'The community id or its slug.')],
    responses: {
      200: ok('The subscriptions.', { type: 'object', required: ['subscriptions'], properties: { subscriptions: { type: 'array', items: ref('Subscription') } } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: listSubscriptions,
  },
  {
    method: 'post',
    path: '/communities/:serverId/subscriptions',
    auth: 'principal',
    scopes: ['communities:write', 'events:subscribe'],
    bots: false,
    community: 'manage',
    tags: ['Events'],
    summary: 'Subscribe a webhook to events',
    description: 'Subscribes a webhook the community already has to a set of event types.',
    parameters: [pathParam('serverId', 'The community id or its slug.')],
    requestBody: requestBody({
      type: 'object',
      required: ['webhookId', 'events'],
      properties: {
        webhookId: { type: 'string' },
        events: { type: 'array', items: { type: 'string' } },
      },
    }, 'The subscription.'),
    responses: {
      201: ok('The subscription.', { type: 'object', required: ['subscription'], properties: { subscription: ref('Subscription') } }),
      400: ERRORS.badRequest,
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: createSubscription,
  },
  {
    method: 'delete',
    path: '/communities/:serverId/subscriptions/:subscriptionId',
    auth: 'principal',
    scopes: ['communities:write', 'events:subscribe'],
    bots: false,
    community: 'manage',
    tags: ['Events'],
    summary: 'End a subscription',
    description: 'Stops delivering the subscribed events to the endpoint.',
    parameters: [
      pathParam('serverId', 'The community id or its slug.'),
      pathParam('subscriptionId', 'The subscription id.'),
    ],
    responses: {
      200: ok('The subscription is gone.', { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
      404: ERRORS.missing,
    },
    handler: deleteSubscription,
  },
];


module.exports = {
  definitions,
  listWebhooks, createWebhook, deleteWebhook, rotateWebhookSecret,
  webhookDeliveries, webhookHealth, listSubscriptions, createSubscription, deleteSubscription,
};

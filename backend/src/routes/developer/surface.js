// The surface itself: what this API is, what it can do, and which credential
// is calling.
//
// These are the routes a client reads before it does anything else, and the
// ones an integrator reads when a request fails and needs to know why. The
// definitions and the handlers are in one file because a route and what it
// does belong together.

const { ref, ok, ERRORS } = require('./metadata');
const { document } = require('./openapi');
const { VERSION } = require('../../version');
const db = require('../../db');
const { catalogue } = require('../../services/developer/scopes');
const { ENVELOPE_VERSION, EVENT_TYPES, envelopeDescription } = require('../../services/developer/events');
const instance = require('../../services/developer/instance');
const { stateOf } = require('../../services/developer/rateLimit');

const API_VERSION = 'v1';

// What the versioned surface is. A client that reads this knows the mount
// path, the document that describes it and the version of the contract it
// speaks.
async function index(req, res) {
  const meta = instance.info();
  res.json({
    name: 'Trycord Developer API',
    apiVersion: API_VERSION,
    version: VERSION,
    eventVersion: ENVELOPE_VERSION,
    basePath: '/api/' + API_VERSION,
    openapi: '/api/' + API_VERSION + '/openapi.json',
    scopes: '/api/' + API_VERSION + '/scopes',
    events: '/api/' + API_VERSION + '/events',
    documentation: 'docs/api/',
    instance: { id: meta.id, name: meta.name },
  });
}

// The scope catalogue, as the interface and an integrator read it.
async function scopes(req, res) {
  res.json({ groups: catalogue() });
}

// The instance this API belongs to.
async function instanceInfo(req, res) {
  const meta = instance.info();
  res.json({
    instanceId: meta.id,
    name: meta.name,
    version: meta.version,
    apiVersion: API_VERSION,
    eventVersion: ENVELOPE_VERSION,
  });
}

// The event vocabulary and the envelope the platform delivers.
async function events(req, res) {
  res.json({
    envelope: envelopeDescription(),
    types: EVENT_TYPES,
  });
}

// What the caller is: a person or a credential, and what it may do.
async function whoami(req, res) {
  const principal = req.principal;
  res.json({
    kind: principal.kind,
    id: principal.id,
    ownerUserId: principal.ownerUserId,
    scopes: principal.scopes,
    rateLimitPerMinute: principal.rateLimit,
    communityId: principal.communityId,
    botApplicationId: principal.botApplicationId,
    rateLimit: principal.kind === 'session' ? null : stateOf(principal),
  });
}

// What the developer platform of this instance holds. Counts and nothing
// else: a diagnostics endpoint that answers "is it working" with a number
// nobody can act on is worse than no endpoint.
async function diagnostics(req, res) {
  const [keys, applications, hooks, subscriptions] = await Promise.all([
    db.get('SELECT COUNT(*) AS n FROM developer_api_keys WHERE status = ?', ['active']),
    db.get('SELECT COUNT(*) AS n FROM bot_applications'),
    db.get('SELECT COUNT(*) AS n FROM webhooks'),
    db.get('SELECT COUNT(*) AS n FROM developer_subscriptions'),
  ]);
  res.json({
    instance: instance.info(),
    counts: {
      activeKeys: Number((keys && keys.n) || 0),
      applications: Number((applications && applications.n) || 0),
      webhooks: Number((hooks && hooks.n) || 0),
      subscriptions: Number((subscriptions && subscriptions.n) || 0),
    },
    events: { version: ENVELOPE_VERSION, types: EVENT_TYPES.length },
  });
}

const definitions = [
  {
    method: 'get',
    path: '/',
    auth: 'public',
    bots: true,
    tags: ['Surface'],
    summary: 'What this API is',
    description: 'The version of the contract, where the machine-readable document is, and which instance this is.',
    responses: { 200: ok('The API index.', ref('ApiIndex')) },
    handler: index,
  },
  {
    method: 'get',
    path: '/openapi.json',
    auth: 'public',
    bots: true,
    tags: ['Surface'],
    summary: 'The OpenAPI document',
    description: 'The OpenAPI 3.1 description of this surface, generated from the same definitions the server routes on.',
    responses: { 200: ok('The OpenAPI document.', { type: 'object', additionalProperties: true }) },
    // The definitions are required here rather than at the top of the file:
    // they are made of the four area modules, and one of those is this one.
    // The require happens when the route is answered, by which time every
    // module has been loaded.
    handler: (req, res) => res.json(document(require('./definitions'))),
  },
  {
    method: 'get',
    path: '/scopes',
    auth: 'public',
    bots: true,
    tags: ['Surface'],
    summary: 'The scope catalogue',
    description: 'Every scope a key may carry, grouped, with what each one allows.',
    responses: { 200: ok('The catalogue.', ref('ScopeCatalogue')) },
    handler: scopes,
  },
  {
    method: 'get',
    path: '/instance',
    auth: 'public',
    bots: true,
    tags: ['Surface'],
    summary: 'The instance this API belongs to',
    description: 'The instance id, its name and the versions of the contracts it speaks.',
    responses: { 200: ok('The instance.', ref('InstanceInfo')) },
    handler: instanceInfo,
  },
  {
    method: 'get',
    path: '/events',
    auth: 'principal',
    scopes: ['events:read'],
    bots: true,
    tags: ['Events'],
    summary: 'The event vocabulary and the envelope',
    description: 'The event types the platform delivers, and the fields of the envelope they arrive in.',
    responses: { 200: ok('The vocabulary.', ref('EventVocabulary')) },
    handler: events,
  },
  {
    method: 'get',
    path: '/whoami',
    auth: 'principal',
    scopes: ['profile:read'],
    bots: true,
    tags: ['Surface'],
    summary: 'The calling credential',
    description: 'What the caller is, which scopes it holds and what limit it is under.',
    responses: {
      200: ok('The caller.', ref('Principal')),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
    },
    handler: whoami,
  },
  {
    method: 'get',
    path: '/diagnostics',
    auth: 'principal',
    scopes: ['admin:read'],
    bots: false,
    tags: ['Surface'],
    summary: 'What the developer platform of this instance holds',
    description: 'Counts of the credentials, applications, webhooks and subscriptions this instance has.',
    responses: {
      200: ok('The diagnostics.', ref('Diagnostics')),
      401: ERRORS.unauthenticated,
      403: ERRORS.forbidden,
    },
    handler: diagnostics,
  },
];


module.exports = { definitions, index, scopes, instanceInfo, events, whoami, diagnostics };

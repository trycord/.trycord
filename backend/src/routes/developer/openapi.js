// The OpenAPI document.
//
// Generated from the route definitions, so it cannot describe a route the
// server does not serve or miss one it does. The test that walks the router
// and compares it with this document is what keeps that true.
//
// OpenAPI 3.1, which is JSON Schema 2020-12: a schema is a schema, and the
// nullable keyword is the union a type array expresses.

const { VERSION } = require('../../version');
const schemas = require('./schemas');
const { ENVELOPE_VERSION } = require('../../services/developer/events');

const API_VERSION = 'v1';

const SECURITY_SCHEMES = {
  sessionToken: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'A user session token. The account itself, not restricted by scopes.',
  },
  apiKey: {
    type: 'http',
    scheme: 'bearer',
    description:
      'A developer API key, sent as "tc_<handle>.<secret>". A key carries an explicit scope set,'
      + ' and a request is refused when it does not hold the scope the route needs.',
  },
};

/**
 * The path as OpenAPI writes it.
 *
 * The router's paths are Express paths, where a parameter is ":name". OpenAPI
 * writes it "{name}". The document carries the OpenAPI form; the router keeps
 * the Express one.
 *
 * @param {string} path
 * @returns {string}
 */
function toTemplate(path) {
  return String(path).replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function operationId(method, path) {
  const parts = path.split('/').filter(Boolean).map((part) => (
    part.startsWith(':') ? 'By' + part.slice(1).replace(/^./, (c) => c.toUpperCase()) : part
  ));
  return parts.length ? method + parts.join('') : method + 'Index';
}

function securityFor(definition) {
  if (definition.auth === 'public') return [];
  if (definition.auth === 'session') return [{ sessionToken: [] }];
  return [{ sessionToken: [] }, { apiKey: [] }];
}

function operation(definition) {
  const scopes = definition.scopes || [];
  const scopeNote = scopes.length
    ? ' Requires the scope' + (scopes.length > 1 ? 's ' : ' ') + scopes.map((s) => '`' + s + '`').join(', ') + '.'
    : '';
  const botNote = definition.bots
    ? ''
    : ' An application credential cannot use this endpoint.';
  return {
    operationId: operationId(definition.method, definition.path),
    tags: definition.tags || [],
    summary: definition.summary,
    description: (definition.description || '') + scopeNote + botNote,
    parameters: definition.parameters || [],
    ...(definition.requestBody ? { requestBody: definition.requestBody } : {}),
    responses: definition.responses,
    security: securityFor(definition),
    'x-trycord-scopes': scopes,
  };
}

/**
 * The OpenAPI document for a set of route definitions.
 *
 * @param {object[]} definitions
 * @returns {object}
 */
function document(definitions) {
  const paths = {};
  for (const definition of definitions) {
    const path = toTemplate(definition.path);
    if (!paths[path]) paths[path] = {};
    paths[path][definition.method] = operation(definition);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Trycord Developer API',
      version: API_VERSION,
      summary: 'The versioned surface a third-party integration builds against.',
      description:
        'This is the versioned surface of the Trycord API. It is a contracted subset, not the whole API:'
        + ' the unversioned routes under /api remain for the interface, and are not covered here.'
        + '\n\n'
        + 'A request authenticates with a user session token or with a developer API key. A key carries an'
        + ' explicit scope set, and every route states the scopes a key must hold; a request that does not'
        + ' hold them is refused with 403 and the code INSUFFICIENT_SCOPE.'
        + '\n\n'
        + 'Errors use one envelope: {"error": {"code": "...", "message": "..."}}.'
        + '\n\n'
        + 'The event envelope delivered to webhooks is version ' + ENVELOPE_VERSION + '. Its fields are'
        + ' described by GET /api/' + API_VERSION + '/events.',
    },
    servers: [{ url: '/api/' + API_VERSION, description: 'This instance.' }],
    paths,
    components: {
      securitySchemes: SECURITY_SCHEMES,
      schemas,
    },
    security: [{ sessionToken: [] }, { apiKey: [] }],
    'x-trycord-version': VERSION,
  };
}

module.exports = { document, operation, toTemplate, SECURITY_SCHEMES, API_VERSION };

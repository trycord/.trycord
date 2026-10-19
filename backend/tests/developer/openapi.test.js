// The OpenAPI document, measured against the routes the server actually
// registers.
//
// A document that is written by hand drifts. This test walks the router and
// compares it with the document, in both directions: a route the server
// serves that the document does not describe, and a path the document
// describes that the server does not serve, are both failures.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, apiClient } = require('../helpers/instance');
const { ensureVersionedApi } = require('./helpers/developer');

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

/**
 * The path as OpenAPI writes it. The router's paths are Express paths, where
 * a parameter is ":name"; the document writes it "{name}".
 */
function template(path) {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** The routes the versioned router registers. */
function registeredRoutes() {
  const router = require('../../src/routes/developer');
  const routes = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      if (!METHODS.includes(method)) continue;
      routes.push({ method: method.toUpperCase(), path: template(layer.route.path) });
    }
  }
  return routes;
}

/** The operations the document describes. */
function documentedOperations(document) {
  const operations = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of Object.keys(item)) {
      if (!METHODS.includes(method)) continue;
      operations.push({ method: method.toUpperCase(), path });
    }
  }
  return operations;
}

test('the OpenAPI document', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());
  const base = await ensureVersionedApi(instance);

  await t.test('the document is served and is valid JSON', async () => {
    const res = await fetch(instance.baseUrl + '/api/v1/openapi.json');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const text = await res.text();
    const parsed = JSON.parse(text);
    assert.equal(typeof parsed, 'object');
    assert.match(parsed.openapi, /^3\.1\./, 'the document is an OpenAPI 3.1 document');
    assert.equal(parsed.info.title, 'Trycord Developer API');
    assert.ok(parsed.servers && parsed.servers.length, 'the document says where it lives');
    assert.deepEqual(parsed.servers[0].url, '/api/v1');
  });

  await t.test('every route the router registers is in the document', async () => {
    const res = await apiClient(base).get('/openapi.json');
    assert.equal(res.status, 200);
    const document = res.data;

    const registered = registeredRoutes();
    const documented = documentedOperations(document);
    assert.ok(registered.length > 0, 'the router registers routes');

    for (const route of registered) {
      const found = documented.some((op) => op.method === route.method && op.path === route.path);
      assert.ok(
        found,
        route.method + ' ' + route.path + ' is registered but not documented'
      );
    }
  });

  await t.test('every path in the document is registered on the router', async () => {
    const res = await apiClient(base).get('/openapi.json');
    const document = res.data;
    const registered = registeredRoutes();

    for (const operation of documentedOperations(document)) {
      const found = registered.some((route) => route.method === operation.method && route.path === operation.path);
      assert.ok(
        found,
        operation.method + ' ' + operation.path + ' is documented but not registered'
      );
    }
  });

  await t.test('the document and the router agree on the set of paths', async () => {
    const res = await apiClient(base).get('/openapi.json');
    const document = res.data;
    const documentedPaths = Object.keys(document.paths).sort();
    const registeredPaths = [...new Set(registeredRoutes().map((route) => route.path))].sort();
    assert.deepEqual(documentedPaths, registeredPaths);
  });

  await t.test('the document says what each route needs', async () => {
    const res = await apiClient(base).get('/openapi.json');
    const document = res.data;
    const definitions = require('../../src/routes/developer/definitions');

    for (const definition of definitions) {
      const operation = document.paths[template(definition.path)][definition.method];
      assert.ok(operation, definition.method + ' ' + definition.path + ' is documented');
      assert.ok(operation.summary, 'the operation has a summary');
      assert.ok(operation.description, 'the operation has a description');
      assert.deepEqual(operation['x-trycord-scopes'], definition.scopes || []);
      if ((definition.scopes || []).length) {
        for (const scope of definition.scopes) {
          assert.ok(
            operation.description.includes(scope),
            'the operation names the scope ' + scope
          );
        }
      }
    }
  });

  await t.test('the document writes its paths the way OpenAPI writes them', async () => {
    const res = await apiClient(base).get('/openapi.json');
    const document = res.data;
    for (const path of Object.keys(document.paths)) {
      assert.equal(path.indexOf(':'), -1, path + ' is not an Express path');
      // Every parameter a path names is declared by the operation.
      const names = (path.match(/\{([^}]+)\}/g) || []).map((n) => n.slice(1, -1));
      for (const method of Object.keys(document.paths[path])) {
        if (!METHODS.includes(method)) continue;
        const declared = (document.paths[path][method].parameters || [])
          .filter((p) => p.in === 'path')
          .map((p) => p.name);
        for (const name of names) {
          assert.ok(declared.includes(name), path + ' declares the parameter ' + name);
        }
      }
    }
  });

  await t.test('the document describes the errors in the envelope the server uses', async () => {
    const res = await apiClient(base).get('/openapi.json');
    const document = res.data;
    const error = document.components.schemas.Error;
    assert.ok(error, 'the error envelope is described');
    assert.deepEqual(error.properties.error.required, ['code', 'message']);

    // The shape the server actually answers with.
    const refused = await apiClient(base, 'tc_nothing.nothing').get('/keys');
    assert.equal(refused.status, 401);
    assert.ok(refused.data.error.code, 'the answer carries a code');
    assert.ok(refused.data.error.message, 'the answer carries a message');
  });
});

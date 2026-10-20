// The server's module graph loads.
//
// A module the server requires that cannot be loaded is a server that cannot
// start, and the failure arrives as a restart loop rather than as a test
// failure: the process comes up, throws, and comes up again.
//
// This happened. A new voice module exported a constant it never defined,
// and the export was evaluated when the module was loaded — so every process
// that required it died at the import. The integration tests caught it, but
// only because they boot the server; this file catches it in a second and
// says which module broke.
//
// The check is deliberately a load, not a boot: it does not open a database
// and it does not listen on a port. It answers one question — can every
// module the server pulls in be evaluated?

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const BACKEND = path.join(__dirname, '..', '..');

test('the server module graph loads', async (t) => {
  await t.test('the server itself can be required', () => {
    // Requiring the server evaluates every module it pulls in: the routers,
    // the services, the schema, the feature flags. A module that throws at
    // load - a missing constant, a circular require, a syntax error - throws
    // here.
    assert.doesNotThrow(() => {
      require(path.join(BACKEND, 'src', 'server.js'));
    });
  });

  await t.test('every route module can be required on its own', () => {
    const routes = fs.readdirSync(path.join(BACKEND, 'src', 'routes'))
      .filter((name) => name.endsWith('.js'));
    const broken = [];
    for (const name of routes) {
      try {
        require(path.join(BACKEND, 'src', 'routes', name));
      } catch (error) {
        broken.push(name + ': ' + (error && error.message ? error.message : String(error)));
      }
    }
    assert.deepEqual(broken, [], 'route modules that cannot be loaded:\n' + broken.join('\n'));
  });

  await t.test('every service module can be required on its own', () => {
    const services = path.join(BACKEND, 'src', 'services');
    const broken = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.js')) continue;
        try {
          require(full);
        } catch (error) {
          broken.push(path.relative(BACKEND, full) + ': '
            + (error && error.message ? error.message : String(error)));
        }
      }
    };
    walk(services);
    assert.deepEqual(broken, [], 'service modules that cannot be loaded:\n' + broken.join('\n'));
  });

  await t.test('every table module declares the same shape', () => {
    const tables = path.join(BACKEND, 'src', 'db', 'tables');
    const problems = [];
    for (const name of fs.readdirSync(tables)) {
      if (!name.endsWith('.js') || name === 'index.js') continue;
      const module = require(path.join(tables, name));
      if (typeof module !== 'function') {
        problems.push(name + ' does not export a function');
        continue;
      }
      const produced = module(' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
      if (!Array.isArray(produced) || !produced.length) {
        problems.push(name + ' produced no statements');
        continue;
      }
      for (const statement of produced) {
        if (typeof statement !== 'string' || !/CREATE TABLE IF NOT EXISTS/.test(statement)) {
          problems.push(name + ' produced a statement that is not a table');
        }
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });
});

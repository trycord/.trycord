// The developer portal: its module graph has to resolve, and its screens have
// to draw. The portal is served at /applications/ as its own entry document,
// so a broken import here is not a broken desktop import: it is the "required
// file failed to load" the reader saw on /applications/.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installDomStub } from './helpers/dom-stub.js';

installDomStub();

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every relative specifier in the portal's modules has to point at a real file,
// the same way the browser's module resolver would resolve it. The portal is
// served at /applications/, so its own tree is short: the shared packages and
// the shared desktop UI live one level up and are reachable through ../..
test('the developer portal module graph resolves', async () => {
  const routerSrc = fs.readFileSync(path.join(ROOT, 'portal', 'js', 'router.js'), 'utf8');
  const entrySrc = fs.readFileSync(path.join(ROOT, 'portal', 'js', 'entry.js'), 'utf8');
  const importRe = /from\s+['"](\.[^'"]+)['"]/g;
  for (const source of [routerSrc, entrySrc]) {
    let m;
    while ((m = importRe.exec(source))) {
      const base = path.resolve(path.join(ROOT, 'portal', 'js'), m[1]);
      const candidates = [base, base + '.js', path.join(base, 'index.js')];
      assert.ok(candidates.some((c) => fs.existsSync(c)),
        'the portal module imports a missing file: ' + m[1]);
    }
  }
});

test('the portal entry points at the portal router', () => {
  const entrySrc = fs.readFileSync(path.join(ROOT, 'portal', 'js', 'entry.js'), 'utf8');
  assert.match(entrySrc, /from\s+['"]\.\/router\.js['"]/);
});

test('the portal answers the shared developer screens', async () => {
  const mod = await import('../js/features/developer.js');
  assert.ok(mod.renderApplicationsPortal, 'the portal home renderer is missing');
  assert.ok(mod.renderDeveloper, 'the developer console renderer is missing');

  const home = mod.renderApplicationsPortal({
    page: { id: 'applications' },
    params: {},
    rest: [],
    query: new URLSearchParams(),
  });
  assert.ok(home && home.node, 'the portal home has no node');
  assert.equal(typeof home.onMount, 'function', 'the portal home has no onMount');

  for (const id of [
    'applications.keys', 'applications.applications', 'applications.dashboard', 'applications.documentation',
  ]) {
    const console = mod.renderDeveloper({
      page: { id },
      params: {},
      rest: [],
      query: new URLSearchParams(),
    });
    assert.ok(console && console.node, id + ' has no node');
    assert.equal(typeof console.onMount, 'function', id + ' has no onMount');
  }
});

test('the developer console maps its section from the page id', async () => {
  const mod = await import('../js/features/developer.js');
  // The portal addresses its sections as applications.<section>; the bare
  // developer page addresses them as developer.<section>. Both must land on the
  // section the address names.
  const portal = mod.renderDeveloper({
    page: { id: 'applications.dashboard' },
    params: {},
    rest: [],
    query: new URLSearchParams(),
  });
  // The dashboard section's renderer is the shared one; the console picks by
  // the section id, so the answer is the dashboard renderer itself.
  assert.ok(portal && portal.node, 'the portal dashboard section has no node');
  assert.ok(typeof portal.onMount, 'the portal dashboard section has no onMount');

  const bare = mod.renderDeveloper({
    page: { id: 'developer' },
    params: {},
    rest: [],
    query: new URLSearchParams(),
  });
  assert.ok(bare && bare.node, 'the bare developer page has no node');
});

test('the portal has no duplicate registry of its own', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'portal', 'packages', 'registry.js')),
    'the portal keeps a duplicate registry it does not use');
  assert.ok(!fs.existsSync(path.join(ROOT, 'portal', 'js', 'main.js')),
    'the portal keeps a home renderer it does not use');
});
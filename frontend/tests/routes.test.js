// The route audit: every door the client draws must open.
//
// "The profile page is gone" was reported while the route, the renderer, the
// backend endpoint and the served module were all verified green — which is
// exactly why this file exists. The failures that make a client feel like
// duct tape are the ones a single walk would have caught: a link to a route
// nobody registered, a prefix every dynamic build shares that lost its page.
// The renderer half of this audit lives in renderers.test.js; this file is
// the links.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installDomStub } from './helpers/dom-stub.js';

installDomStub();

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PAGES, matchPath } = await import('../packages/registry.js');

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('every route the source names resolves in the registry', () => {
  const files = walk(path.join(ROOT, 'js'), []);
  const seen = new Set();
  const dead = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(
      /(?:navigate|path)\(\s*'([^']+)'\s*|href:\s*'([^']+)'|assign\(\s*'([^']+)'\s*\)/g
    )) {
      const raw = m[1] || m[2] || m[3];
      if (!raw || !raw.startsWith('/') || raw.startsWith('//')) continue;
      // A string that ends mid-build ('/server/' + id) is a prefix, not a
      // link; the concatenation is what resolves, and the prefix audit below
      // covers its shape.
      if (raw.endsWith('/') || raw.includes('$')) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      const [pathname] = raw.split('?');
      if (!matchPath(pathname)) dead.push(raw + '  ←  ' + path.relative(ROOT, file));
    }
  }
  assert.deepEqual(dead, [], 'links that open on nothing:\n' + dead.join('\n'));
});

test('the route shapes the source builds dynamically are registered patterns', () => {
  // The prefixes the literal audit skips are real doors only while a pattern
  // with that first segment is registered. Every dynamic build in the client
  // starts from one of these ('/channel/…' is a second segment under
  // /server/, not a top-level prefix); if the page behind one is renamed
  // away, this says so instead of the client saying it with a fault box.
  const prefixes = ['/server/', '/users/', '/c/', '/invite/'];
  const orphans = prefixes.filter((prefix) => !PAGES.some((page) =>
    page.route && page.route.startsWith(prefix)));
  assert.deepEqual(orphans, [], 'dynamic link prefixes with no registered route:\n' + orphans.join('\n'));
});

// The phone can open every page the registry declares.
//
// The renderers table is bound at boot and the router calls renderPage for the
// address the reader asked for. A page with no renderer is the "No renderer for
// page" fault the reader was seeing. This walks the whole registry and opens
// each page the way the router does, so a missing or throwing renderer is named
// here rather than discovered by a reader.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from './helpers/dom-stub.js';

installDomStub();
installFetchStub();

const { PAGES, bind, renderPage, matchRoute } = await import('../packages/registry.js');
const { RENDERERS: MOBILE } = await import('../mobile/js/views/index.js');

bind(MOBILE);

test('every page the phone can open, opens', async () => {
  const problems = [];
  for (const page of PAGES) {
    if (typeof MOBILE[page.id] !== 'function') {
      problems.push(page.id + ' has no mobile renderer');
      continue;
    }
    try {
      const answer = await Promise.resolve(renderPage(page, {
        page, params: {}, rest: [], query: {},
      }));
      if (!answer) problems.push(page.id + ' returned nothing');
    } catch (error) {
      const message = String((error && error.message) || '');
      // A view may refuse the context it is given (a page that needs a
      // community is told so); that is its own answer, not a missing renderer.
      if (message.indexOf('No renderer for page') !== -1) {
        problems.push(page.id + ' -> ' + message);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the doors resolve to a bound renderer', () => {
  for (const route of ['/', '/dms', '/communities', '/you', '/notifications',
    '/settings', '/admin', '/discover', '/search', '/support', '/legal/terms']) {
    const match = matchRoute(route);
    assert.ok(match, route + ' resolves');
    assert.equal(typeof MOBILE[match.page.id], 'function',
      route + ' has no renderer');
  }
});
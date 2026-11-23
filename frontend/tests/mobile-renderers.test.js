// The phone's renderer table is lazy: a module is imported when its address
// is opened. The registry test proves the table names every page, but a name
// is not a screen. This test opens every address, awaits the import and draws
// the page, so a bad import, a missing export, or a context dropped on the way
// to a section fails here - not on somebody's phone.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.js';

installDomStub();

const { PAGES, bind, renderPage } = await import('../packages/registry.js');
const { RENDERERS: MOBILE } = await import('../mobile/js/views/index.js');

test('every address on the phone draws a renderer', async () => {
  bind(MOBILE);
  const failures = [];
  for (const page of PAGES) {
    const ctx = {
      page,
      screen: page.id,
      params: {
        id: 'sample-id',
        slug: 'sample-place',
        channel: 'sample-channel',
        doc: 'terms',
        instanceId: 'sample-instance',
        communityId: 'sample-community',
      },
      rest: [],
      query: new URLSearchParams(),
      serverId: String(page.id).indexOf('community.') === 0 ? 'sample-server' : null,
      channel: null,
      conversationId: 'sample-id',
    };
    try {
      const answer = await renderPage(page, ctx);
      const node = answer && (answer.node || answer);
      assert.ok(node, page.id + ' returned nothing to draw');
    } catch (error) {
      failures.push(page.id + ': ' + ((error && error.message) || error));
    }
  }
  assert.deepEqual(failures, [], 'pages the phone could not draw:\n' + failures.join('\n'));
});

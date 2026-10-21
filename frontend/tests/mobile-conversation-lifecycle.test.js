import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, waitFor } from './helpers/dom-stub.js';

installDomStub();
globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };

const { renderConversation } = await import('../mobile/js/views/messages.js');

test('a late DM history response cannot mark a closed conversation read', async () => {
  let finishHistory;
  const calls = [];
  globalThis.fetch = async (url) => {
    const address = String(url);
    calls.push(address);
    if (address.includes('/api/dms/old/messages')) {
      return new Promise((resolve) => { finishHistory = resolve; });
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      json: async () => ({}),
    };
  };

  const conversation = renderConversation({}, {
    kind: 'dm',
    id: 'old',
    placeholder: 'Message',
  });
  conversation.onMount();
  assert.ok(await waitFor(() => finishHistory), 'the history request started');

  conversation.cleanup();
  finishHistory({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: async () => [],
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.some((address) => address.endsWith('/read')), false,
    'leaving before the history arrives does not mark it read');
  assert.doesNotMatch(conversation.node.textContent, /No messages yet/,
    'a closed view is not repainted by a late response');
});

// A conversation key that moves is not a cosmetic change.
//
// The server tells every member device when a conversation is rekeyed or its
// membership changes. The client's cached answer is stale from that moment,
// and a reader who is about to send something needs to know that the group
// the conversation was encrypted to is not the group it is now.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { installDomStub } from '../helpers/dom-stub.js';
import { MODULES, read } from '../helpers/source.js';

installDomStub();

const { onChange, invalidate, knownState } = await import('../../js/ui/encrypted.js');

test('a moved key drops the cached state and announces the conversation', () => {
  const seen = [];
  const off = onChange((change) => seen.push(change));

  invalidate('conv-1', { action: 'membership-changed' });

  assert.equal(seen.length, 1, 'the change was not announced');
  assert.equal(seen[0].type, 'key-change');
  assert.equal(seen[0].conversationId, 'conv-1');
  assert.equal(knownState('conv-1'), null, 'the stale answer was kept');
  off();
});

test('a key change without a conversation clears every cached answer', () => {
  const seen = [];
  const off = onChange((change) => seen.push(change));

  invalidate(null, { action: 'prekeys-published' });

  assert.equal(seen[0].type, 'key-change');
  assert.equal(seen[0].conversationId, null);
  off();
});

test('the key-change answer warns only when the group actually moved', () => {
  const source = read(path.join(MODULES.desktop, 'ui', 'encrypted.js'));
  assert.match(source, /event\.action === 'membership-changed'/,
    'a membership change does not warn the reader');
  assert.match(source, /event\.changed === true/,
    'a new epoch does not warn the reader');

  const mobile = read(path.join(MODULES.mobile, 'encrypted.js'));
  assert.match(mobile, /event\.action === 'membership-changed'/,
    'the phone does not warn on a membership change');
  assert.match(mobile, /event\.changed === true/,
    'the phone does not warn on a new epoch');
});

// The realtime vocabulary, and the events the client answers.
//
// The gateway and the client have to spell an event the same way: a second
// spelling of one event is an event that is never delivered. The server keeps
// the whole vocabulary in one file, so the client is checked against it
// directly rather than against a copy of it.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

import { installDomStub } from './helpers/dom-stub.js';
import { ROOT, MODULES, read } from './helpers/source.js';

installDomStub();

const require = createRequire(import.meta.url);
const server = require(path.join(ROOT, 'backend', 'src', 'ws', 'events.js'));

const { EVENTS, SESSION_EVENTS } = await import('../packages/realtime.js');
const { State, on, markConversationRead } = await import('../packages/store.js');

test('the client speaks the server\'s vocabulary', () => {
  assert.deepEqual(
    Object.keys(EVENTS).sort(),
    Object.keys(server.EVENTS).sort(),
    'the client and the server name their events differently',
  );
  assert.deepEqual(
    Object.keys(SESSION_EVENTS).sort(),
    Object.keys(server.SESSION_EVENTS).sort(),
    'the client and the server name their account events differently',
  );
});

test('every event name is the same string on both sides', () => {
  for (const [key, name] of Object.entries(EVENTS)) {
    assert.equal(server.EVENTS[key], name, key + ' is spelled differently on the server');
  }
  for (const [key, name] of Object.entries(SESSION_EVENTS)) {
    assert.equal(server.SESSION_EVENTS[key], name, key + ' is spelled differently on the server');
  }
});

test('the events the server declares but never sends are answered by the client', () => {
  // These three are declared in the server's vocabulary. No route emits them
  // yet, so the client is the only place they can be handled correctly: when
  // they arrive, they have to mean what they say.
  for (const name of ['message_pinned', 'message_unpinned', 'dm:read']) {
    assert.ok(Object.values(EVENTS).includes(name), name + ' is not in the client vocabulary');
  }
});

test('both modules answer the pin events', () => {
  const desktop = read(path.join(MODULES.desktop, 'features', 'community.js'));
  assert.match(desktop, /on\(EVENTS\.MESSAGE_PINNED/);
  assert.match(desktop, /on\(EVENTS\.MESSAGE_UNPINNED/);

  const mobile = read(path.join(MODULES.mobile, 'views', 'messages.js'));
  assert.match(mobile, /realtime\.on\(EVENTS\.MESSAGE_PINNED/);
  assert.match(mobile, /realtime\.on\(EVENTS\.MESSAGE_UNPINNED/);
});

test('both modules answer a conversation that was read', () => {
  assert.match(read(path.join(MODULES.desktop, 'main.js')), /onRealtime\(EVENTS\.DM_READ/);
  assert.match(read(path.join(MODULES.mobile, 'main.js')), /onRealtime\(EVENTS\.DM_READ/);
});

test('a conversation read elsewhere loses its unread badge', () => {
  State.dms = [{ id: 'c1', unreadCount: 3 }, { id: 'c2', unreadCount: 1 }];
  let emitted = null;
  const off = on('dms', (payload) => { emitted = payload; });

  assert.equal(markConversationRead('c1'), true);
  assert.equal(State.dms[0].unreadCount, 0);
  assert.equal(State.dms[1].unreadCount, 1);
  assert.ok(emitted, 'the store did not announce the change');

  emitted = null;
  assert.equal(markConversationRead('c2'), true);
  assert.equal(State.dms[1].unreadCount, 0);
  assert.ok(emitted, 'the store did not announce the change');

  // A conversation that was never in the list, or was already read, changes
  // nothing and says so.
  emitted = null;
  assert.equal(markConversationRead('nope'), false);
  assert.equal(markConversationRead('c1'), false);
  assert.equal(emitted, null, 'the store announced a change that did not happen');

  off();
  State.dms = [];
});

test('a read by somebody else leaves this account\'s unread count alone', () => {
  // The gateway tells the other members of a conversation that it has been
  // read. The unread count is this account's own, so somebody else reading
  // changes nothing here.
  const source = read(path.join(MODULES.desktop, 'main.js'));
  assert.match(source, /EVENTS\.DM_READ[\s\S]*?userId/,
    'the desktop does not look at who read the conversation');
  assert.match(source, /EVENTS\.DM_READ[\s\S]*?markConversationRead/,
    'the desktop does not answer a conversation that was read');

  const mobile = read(path.join(MODULES.mobile, 'main.js'));
  assert.match(mobile, /EVENTS\.DM_READ[\s\S]*?userId/,
    'the mobile does not look at who read the conversation');
});

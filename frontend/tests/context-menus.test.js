// The context menu.
//
// On a desk a thing that can be acted on is acted on with a right-click; on a
// phone it is a long press. Either way the surface has to carry the menu, and
// the menu has to have something in it.
//
// The check drives the gesture rather than reading the source: it builds the
// surface, raises the context menu on the row, and asks what came out. A row
// that carries no menu never opens one, and a menu with nothing in it does not
// open either.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from './helpers/dom-stub.js';

installDomStub();

const { State, setPresence } = await import('../packages/store.js');
const { closeMenu } = await import('../js/ui/overlays.js');
const { buildContext } = await import('../js/shell/context.js');
const { memberList } = await import('../js/ui/members.js');
const { renderDms } = await import('../js/features/dms.js');
const { activityRow } = await import('../js/features/activity.js');
const { buildMessageRow, asMessage } = await import('../js/ui/chat.js');
const { embedCard } = await import('../js/ui/embeds.js');
const { attachLongPress } = await import('../mobile/js/ui.js');

function find(node, predicate, found = []) {
  if (!node) return found;
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

// The menu the gesture opened, or null.
function openMenuNode() {
  return document.body.querySelector('.menu');
}

function menuText() {
  const menu = openMenuNode();
  return menu ? (menu.textContent || '') : '';
}

async function raise(node) {
  closeMenu();
  node.dispatch('contextmenu', { clientX: 40, clientY: 60 });
  await tick();
  await tick();
  return openMenuNode();
}

// ---- the community tree ----------------------------------------------------

const SERVER_ID = 'server-1';

function seedCommunity() {
  State.servers = [{
    id: SERVER_ID,
    name: 'The Harbour',
    slug: 'harbour',
    permissions: ['MANAGE_CHANNELS', 'MANAGE_MESSAGES', 'KICK_MEMBERS'],
  }];
  State.serverTree.set(SERVER_ID, {
    categories: [{ id: 'cat-1', name: 'Talking', position: 0 }],
    channels: [
      { id: 'chan-1', name: 'general', category_id: 'cat-1', position: 0, type: 'text' },
      { id: 'chan-2', name: 'lounge', category_id: 'cat-1', position: 1, type: 'text' },
    ],
  });
}

test('a channel in the community tree carries the channel menu', async () => {
  seedCommunity();
  const parts = buildContext('community', { serverId: SERVER_ID }, null);
  const links = find(parts.body, (n) => n.getAttribute && n.getAttribute('class') === 'nav-item nav-item--channel');
  assert.ok(links.length >= 2, 'the tree drew no channels');

  const menu = await raise(links[0]);
  assert.ok(menu, 'a right-click on a channel opened no menu');
  const text = menuText();
  assert.match(text, /Edit channel/, 'the channel menu does not offer the management');
  assert.match(text, /Delete channel/, 'the channel menu does not offer the delete');
  closeMenu();
});

test('the category heading in the community tree carries the category menu', async () => {
  seedCommunity();
  const parts = buildContext('community', { serverId: SERVER_ID }, null);
  const headings = find(parts.body, (n) => n.getAttribute && n.getAttribute('class') === 'nav-label');
  assert.ok(headings.length >= 1, 'the tree drew no category heading');

  const menu = await raise(headings[0]);
  assert.ok(menu, 'a right-click on a category heading opened no menu');
  const text = menuText();
  assert.match(text, /Create channel/, 'the category menu does not offer a channel');
  assert.match(text, /Rename category/, 'the category menu does not offer the rename');
  closeMenu();
});

// ---- the roster ------------------------------------------------------------

test('a member row carries the person menu', async () => {
  installFetchStub({
    ['http://localhost/api/servers/' + SERVER_ID + '/members?limit=50']: {
      json: {
        items: [{
          id: 'u2', username: 'sam', display_name: 'Sam', is_owner: false,
          roles: [], nickname: null,
        }],
        total: 1,
        hasMore: false,
      },
    },
    'http://localhost/api/me/blocks': { json: [] },
    'http://localhost/api/users/presence?ids=u2': { json: { u2: 'online' } },
  });
  const roster = memberList(SERVER_ID);
  await roster.load();
  const rows = find(roster.node, (n) => n.getAttribute && n.getAttribute('class') === 'cardrow member-row');
  assert.equal(rows.length, 1, 'the roster drew no member');

  const menu = await raise(rows[0]);
  assert.ok(menu, 'a right-click on a member opened no menu');
  assert.match(menuText(), /View profile/, 'the member menu is not the person menu');
  closeMenu();
  roster.cleanup();
});

// ---- direct messages -------------------------------------------------------

test('a conversation in the DM list carries the person menu', async () => {
  installFetchStub({ 'http://localhost/api/me/blocks': { json: [] } });
  State.dms = [{
    id: 'dm-1',
    peer: { id: 'u3', username: 'rin', displayName: 'Rin' },
    updatedAt: '2024-01-01T00:00:00.000Z',
  }];
  const view = renderDms();
  const rows = find(view.node, (n) => n.getAttribute && n.getAttribute('class') === 'cardrow');
  assert.ok(rows.length >= 1, 'the DM list drew no conversation');

  const menu = await raise(rows[0]);
  assert.ok(menu, 'a right-click on a conversation opened no menu');
  assert.match(menuText(), /Open a channel/, 'the conversation row is not the person menu');
  closeMenu();
});

// ---- the inbox -------------------------------------------------------------

test('a notification in the inbox carries its own menu', async () => {
  const entry = {
    id: 'n1', type: 'dm', referenceId: 'dm-1',
    actor: { id: 'u4', username: 'bea', displayName: 'Bea' },
    createdAt: '2024-01-01T00:00:00.000Z',
  };
  const row = activityRow(entry, () => {});
  const menu = await raise(row);
  assert.ok(menu, 'a right-click on a notification opened no menu');
  const text = menuText();
  assert.match(text, /Open/, 'the notification menu cannot open the entry');
  assert.match(text, /Mark as read/, 'the notification menu cannot mark it read');
  closeMenu();
});

// ---- a message's own contents ----------------------------------------------

function messageRowWith(message) {
  const factory = buildMessageRow({
    cfg: { standalone: true },
    composerRef: () => ({ replyTo() {}, edit() {} }),
    openThreadRef: () => null,
    delRef: () => () => Promise.resolve(),
    rootNames: new Map(),
  });
  return factory(asMessage(message), false);
}

test('a file attachment inside a message carries a menu', async () => {
  const row = messageRowWith({
    id: 'm1',
    authorId: 'u5',
    authorName: 'Kit',
    content: 'here it is',
    attachments: [{ url: '/api/attachments/a1', name: 'photo.png', contentType: 'image/png' }],
  });
  const files = find(row, (n) => n.getAttribute && /msg-file/.test(n.getAttribute('class') || ''));
  assert.ok(files.length >= 1, 'the message drew no attachment');

  const menu = await raise(files[0]);
  assert.ok(menu, 'a right-click on a file opened no menu');
  const text = menuText();
  assert.match(text, /Copy the address/, 'the file menu cannot copy the address');
  assert.match(text, /Copy the name/, 'the file menu cannot copy the name');
  closeMenu();
});

test('a link preview inside a message carries a menu', async () => {
  const row = messageRowWith({
    id: 'm2',
    authorId: 'u5',
    authorName: 'Kit',
    content: 'look at this',
    embeds: [{
      url: 'https://example.org/a', siteName: 'Example', title: 'A thing',
      description: 'Words.', imageUrl: 'https://example.org/a.png', kind: 'image', status: 'ok',
    }],
  });
  const cards = find(row, (n) => n.getAttribute && /embed-card/.test(n.getAttribute('class') || ''));
  assert.equal(cards.length, 1, 'the message drew no preview');

  const menu = await raise(cards[0]);
  assert.ok(menu, 'a right-click on a preview opened no menu');
  assert.match(menuText(), /Copy the link/, 'the preview menu cannot copy the link');
  closeMenu();
});

// ---- the phone -------------------------------------------------------------

test('the phone raises its menu on a long press', async () => {
  const node = document.createElement('div');
  attachLongPress(node, () => [{ label: 'Open the link', onSelect: () => {} }], { title: 'Link' });
  node.dispatch('touchstart', { touches: [{ clientX: 10, clientY: 10 }] });
  await new Promise((resolve) => setTimeout(resolve, 600));
  await tick();
  const sheet = document.body.querySelector('.m-menu');
  assert.ok(sheet, 'a long press opened no sheet');
  assert.match(sheet.textContent || '', /Open the link/, 'the sheet has nothing in it');
});

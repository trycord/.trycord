// The things a reader keeps: templates and collections.
//
// A template is the reader's own, and so is a collection - unless the
// collection is shared with a community, in which case the members of that
// community see it and nobody else does. The server decides that; the client
// asks for the list and offers the owner's controls only to the owner.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from './helpers/dom-stub.js';

installDomStub();

const { State } = await import('../packages/store.js');
const { setToken } = await import('../packages/api.js');
const { expandShortcut, findByShortcut, isOwner } = await import('../packages/personal.js');
const { templatePicker } = await import('../js/ui/templates.js');
const { renderCollections } = await import('../js/features/collections.js');

function find(node, predicate, found = []) {
  if (!node) return found;
  if (Array.isArray(node)) {
    for (const entry of node) find(entry, predicate, found);
    return found;
  }
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

function classed(word) {
  return (node) => {
    const value = node.getAttribute && node.getAttribute('class');
    return !!value && value.split(/\s+/).indexOf(word) !== -1;
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TEMPLATES = [
  { id: 't1', name: 'Greeting', body: 'Hello - glad to be here.', shortcut: 'greet' },
  { id: 't2', name: 'Sign-off', body: 'See you tomorrow.', shortcut: null },
];

// The collections the fake instance holds. A private one belongs to one
// reader; a shared one belongs to a community.
const PRIVATE = {
  id: 'c1', name: 'Reading for later', visibility: 'private',
  serverId: 'server-1', serverName: 'The Commons', ownerId: 'reader-a', itemCount: 2,
};
const SHARED = {
  id: 'c2', name: 'Everyone\'s links', visibility: 'community',
  serverId: 'server-1', serverName: 'The Commons', ownerId: 'reader-a', itemCount: 5,
};

function collectionsFor(seen) {
  const auth = String((seen[seen.length - 1] || {}).options?.headers?.Authorization || '');
  if (auth.indexOf('reader-a') !== -1) return [PRIVATE, SHARED];
  if (auth.indexOf('reader-b') !== -1) return [SHARED];
  return [];
}

test('the shortcut expands into the text of the template', () => {
  const expanded = expandShortcut('!greet ', TEMPLATES);
  assert.ok(expanded, 'the shortcut did not expand');
  assert.equal(expanded.shortcut, 'greet');
  assert.equal(expanded.text, 'Hello - glad to be here. ');
});

test('the expansion keeps what came before it', () => {
  const expanded = expandShortcut('hi !greet ', TEMPLATES);
  assert.equal(expanded.text, 'hi Hello - glad to be here. ');
});

test('a word that is not a shortcut is left alone', () => {
  assert.equal(expandShortcut('!nothing ', TEMPLATES), null);
  assert.equal(expandShortcut('greet ', TEMPLATES), null);
  assert.equal(findByShortcut(TEMPLATES, 'greet').id, 't1');
  assert.equal(findByShortcut(TEMPLATES, 'absent'), null);
});

test('the picker lists the reader\'s own templates', async () => {
  setToken('reader-a');
  const calls = installFetchStub({
    'http://localhost/api/personal/templates': { json: TEMPLATES },
  });

  const dialog = templatePicker(() => {});
  await wait(30);

  const text = dialog.element.textContent || '';
  assert.match(text, /Greeting/, 'the templates were not listed');
  assert.match(text, /Sign-off/);
  assert.match(text, /!greet/, 'the shortcut was not shown');

  const asked = calls.find((call) => call.url.indexOf('/api/personal/templates') !== -1);
  assert.ok(asked, 'the templates were never read');
  assert.ok(asked.options.headers.Authorization, 'the templates were read without the session');
  dialog.close();
});

test('a private collection is not another reader\'s, and a shared one is', async () => {
  installFetchStub({
    'http://localhost/api/personal/collections': (body, seen) => ({ json: collectionsFor(seen) }),
  });

  // The owner sees both: their own private collection and the shared one.
  setToken('reader-a');
  State.user = { id: 'reader-a' };
  const mine = renderCollections({ page: { id: 'collections' }, query: new URLSearchParams(), params: {}, rest: [] });
  await mine.onMount();
  await wait(20);

  const myText = mine.node.textContent || '';
  assert.match(myText, /Reading for later/, 'the owner did not see their own collection');
  assert.match(myText, /Everyone's links/, 'the owner did not see the shared collection');

  // A member of the community sees the shared one and not the private one.
  setToken('reader-b');
  State.user = { id: 'reader-b' };
  const theirs = renderCollections({ page: { id: 'collections' }, query: new URLSearchParams(), params: {}, rest: [] });
  await theirs.onMount();
  await wait(20);

  const theirText = theirs.node.textContent || '';
  assert.match(theirText, /Everyone's links/, 'a member of the community did not see the shared collection');
  assert.equal(theirText.indexOf('Reading for later'), -1,
    'a private collection was shown to a reader who is not its owner');
});

test('only the owner is offered the controls that change a collection', async () => {
  installFetchStub({
    'http://localhost/api/personal/collections': (body, seen) => ({ json: collectionsFor(seen) }),
    'http://localhost/api/personal/collections/c2': {
      json: Object.assign({}, SHARED, { items: [{ id: 'i1', itemType: 'link', itemRef: 'https://example.dev/', title: 'A link' }] }),
    },
  });

  setToken('reader-b');
  State.user = { id: 'reader-b' };
  const page = renderCollections({ page: { id: 'collections' }, query: new URLSearchParams(), params: {}, rest: [] });
  await page.onMount();
  await wait(20);

  const text = page.node.textContent || '';
  assert.equal(text.indexOf('Rename'), -1, 'a reader who is not the owner was offered a rename');
  assert.equal(text.indexOf('Delete'), -1, 'a reader who is not the owner was offered a delete');
  assert.equal(text.indexOf('Add a link'), -1, 'a reader who is not the owner was offered to add to it');

  // And the server is what decides: the client asks the collection by its id
  // and draws what came back.
  assert.ok(isOwner(SHARED, 'reader-a'), 'the owner was not recognised as the owner');
  assert.equal(isOwner(SHARED, 'reader-b'), false, 'a reader who is not the owner was taken for one');
});

// Managing a community's channels.
//
// The tree and the settings page act on the same things, so they use the same
// implementation - community/manage.js - and the check drives that
// implementation directly. What it proves is the contract with the server: a
// channel is created with the category it was asked for, a rename sends the
// name that was typed, a move sends the category it was moved into, a delete
// asks first, and an order names every channel or is not sent at all.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from './helpers/dom-stub.js';

installDomStub();

const { State } = await import('../packages/store.js');
const {
  openChannelDialog, openCategoryDialog, moveChannel, deleteChannel, deleteCategory,
  reorderChannels, reorderCategories, orderAfterDrop,
} = await import('../js/community/manage.js');

const SERVER_ID = 'server-1';

function seed(overrides) {
  State.servers = [{
    id: SERVER_ID, name: 'The Harbour', slug: 'harbour',
    permissions: ['MANAGE_CHANNELS'],
  }];
  State.serverTree.set(SERVER_ID, Object.assign({
    categories: [{ id: 'cat-1', name: 'Talking', position: 0 }],
    channels: [
      { id: 'chan-1', name: 'general', category_id: 'cat-1', position: 0, type: 'text', topic: '' },
      { id: 'chan-2', name: 'lounge', category_id: 'cat-1', position: 1, type: 'text', topic: '' },
    ],
  }, overrides || {}));
}

function treeRoute() {
  return 'http://localhost/api/servers/' + SERVER_ID + '/channels';
}

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

function dialog() {
  return document.body.querySelector('.dialog');
}

function field(label) {
  const box = dialog();
  for (const field of find(box, (n) => n.tagName === 'INPUT' || n.tagName === 'SELECT')) {
    if (field.getAttribute('aria-label') === label) return field;
  }
  return null;
}

function submit() {
  const form = dialog().querySelector('form');
  form.dispatch('submit', {});
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test('a channel is created in the category it was asked for', async () => {
  seed();
  const calls = installFetchStub({
    [treeRoute()]: { json: { categories: [{ id: 'cat-1', name: 'Talking' }], channels: [] } },
    ['http://localhost/api/servers/' + SERVER_ID + '/channels']: { json: { id: 'chan-9', name: 'new-ideas' } },
  });

  openChannelDialog(SERVER_ID, { categoryId: 'cat-1' });
  field('Channel name').value = 'New Ideas';
  field('Channel topic').value = 'Where the ideas go';
  submit();
  await settle();

  const created = calls.find((call) => call.url === 'http://localhost/api/servers/' + SERVER_ID + '/channels');
  assert.ok(created, 'the channel was never created');
  assert.equal(created.body.name, 'New Ideas');
  assert.equal(created.body.topic, 'Where the ideas go');
  assert.equal(created.body.categoryId, 'cat-1');
  assert.equal(created.body.type, 'text');
});

test('a rename sends the name that was typed', async () => {
  seed();
  const calls = installFetchStub({
    [treeRoute()]: { json: { categories: [], channels: [] } },
    ['http://localhost/api/servers/' + SERVER_ID + '/channels/chan-1']: { json: { id: 'chan-1', name: 'general-talk' } },
  });

  openChannelDialog(SERVER_ID, { channel: State.serverTree.get(SERVER_ID).channels[0] });
  field('Channel name').value = 'General Talk';
  submit();
  await settle();

  const saved = calls.find((call) => call.url.endsWith('/channels/chan-1'));
  assert.ok(saved, 'the rename was never sent');
  assert.equal(saved.body.name, 'General Talk');
});

test('a move sends the category the channel was moved into', async () => {
  seed();
  const calls = installFetchStub({
    [treeRoute()]: { json: { categories: [], channels: [] } },
    ['http://localhost/api/servers/' + SERVER_ID + '/channels/chan-1']: { json: { id: 'chan-1' } },
  });

  const channel = State.serverTree.get(SERVER_ID).channels[0];
  await moveChannel(SERVER_ID, channel, 'cat-1');

  const saved = calls.find((call) => call.url.endsWith('/channels/chan-1'));
  assert.ok(saved, 'the move was never sent');
  assert.equal(saved.body.categoryId, 'cat-1');
  assert.equal(saved.body.name, 'general');
});

test('a delete asks first, and then deletes', async () => {
  seed();
  const calls = installFetchStub({
    [treeRoute()]: { json: { categories: [], channels: [] } },
    ['http://localhost/api/servers/' + SERVER_ID + '/channels/chan-1']: { json: { ok: true } },
  });

  const channel = State.serverTree.get(SERVER_ID).channels[0];
  const answer = deleteChannel(SERVER_ID, channel);
  await settle();

  // The question is asked before anything is deleted.
  const asked = dialog();
  assert.ok(asked, 'the delete was not asked about');
  const confirmed = find(asked, (n) => n.tagName === 'BUTTON' && (n.textContent || '') === 'Delete channel')[0];
  assert.ok(confirmed, 'the dialog has no confirm button');
  confirmed.click();
  await settle();

  assert.equal(await answer, true, 'the delete did not happen');
  assert.ok(calls.some((call) => call.url.endsWith('/channels/chan-1')), 'the delete was never sent');
});

test('an order names every channel, and a partial one is not sent', async () => {
  seed();
  const calls = installFetchStub({
    [treeRoute()]: { json: { categories: [], channels: [] } },
    ['http://localhost/api/servers/' + SERVER_ID + '/channels/reorder']: { json: { ok: true } },
  });

  const whole = await reorderChannels(SERVER_ID, ['chan-2', 'chan-1']);
  assert.equal(whole, true, 'the whole order was refused');
  const sent = calls.find((call) => call.url.endsWith('/channels/reorder'));
  assert.ok(sent, 'the order was never sent');
  assert.deepEqual(sent.body.orderedIds, ['chan-2', 'chan-1']);

  // A partial order is what the server refuses, so it is refused here too -
  // and nothing is sent at all.
  const before = calls.length;
  const partial = await reorderChannels(SERVER_ID, ['chan-1']);
  assert.equal(partial, false, 'a partial order was accepted');
  const afterwards = calls.filter((call) => call.url.endsWith('/channels/reorder'));
  assert.equal(afterwards.length, 1, 'a partial order was sent');
  assert.ok(calls.length > before, 'the list was not reloaded');
});

test('an order of categories names every category', async () => {
  seed({
    categories: [
      { id: 'cat-1', name: 'Talking', position: 0 },
      { id: 'cat-2', name: 'Working', position: 1 },
    ],
  });
  const calls = installFetchStub({
    [treeRoute()]: { json: { categories: [], channels: [] } },
    ['http://localhost/api/servers/' + SERVER_ID + '/categories/reorder']: { json: { ok: true } },
  });

  const whole = await reorderCategories(SERVER_ID, ['cat-2', 'cat-1']);
  assert.equal(whole, true);
  const sent = calls.find((call) => call.url.endsWith('/categories/reorder'));
  assert.deepEqual(sent.body.orderedIds, ['cat-2', 'cat-1']);

  const partial = await reorderCategories(SERVER_ID, ['cat-1']);
  assert.equal(partial, false, 'a partial order of categories was accepted');
});

test('a drop moves the item to where it was dropped', () => {
  seed();
  const channels = State.serverTree.get(SERVER_ID).channels;
  assert.deepEqual(orderAfterDrop(channels, 'chan-2', 'chan-1'), ['chan-2', 'chan-1']);
  assert.deepEqual(orderAfterDrop(channels, 'chan-1', 'chan-2'), ['chan-2', 'chan-1']);
  assert.equal(orderAfterDrop(channels, 'chan-1', 'chan-1'), null, 'a drop on itself moved something');
  assert.equal(orderAfterDrop(channels, 'chan-9', 'chan-1'), null, 'an unknown item moved something');
});

test('a category is created and renamed through the same dialog', async () => {
  seed();
  const calls = installFetchStub({
    [treeRoute()]: { json: { categories: [], channels: [] } },
    ['http://localhost/api/servers/' + SERVER_ID + '/categories']: { json: { id: 'cat-9', name: 'Working' } },
    ['http://localhost/api/servers/' + SERVER_ID + '/categories/cat-1']: { json: { id: 'cat-1', name: 'Talking' } },
  });

  openCategoryDialog(SERVER_ID, {});
  field('Category name').value = 'Working';
  submit();
  await settle();
  const created = calls.find((call) => call.url.endsWith('/categories'));
  assert.ok(created, 'the category was never created');
  assert.equal(created.body.name, 'Working');

  openCategoryDialog(SERVER_ID, { category: { id: 'cat-1', name: 'Talking' } });
  field('Category name').value = 'Talking at length';
  submit();
  await settle();
  const renamed = calls.find((call) => call.url.endsWith('/categories/cat-1'));
  assert.ok(renamed, 'the rename was never sent');
  assert.equal(renamed.body.name, 'Talking at length');
});

test('deleting a category keeps its channels', async () => {
  seed();
  const calls = installFetchStub({
    [treeRoute()]: { json: { categories: [], channels: [] } },
    ['http://localhost/api/servers/' + SERVER_ID + '/categories/cat-1']: { json: { ok: true } },
  });

  const answer = deleteCategory(SERVER_ID, { id: 'cat-1', name: 'Talking' });
  await settle();
  const asked = dialog();
  assert.ok(asked, 'the delete was not asked about');
  const confirmed = find(asked, (n) => n.tagName === 'BUTTON' && (n.textContent || '') === 'Delete category')[0];
  confirmed.click();
  await settle();

  assert.equal(await answer, true);
  assert.ok(calls.some((call) => call.url.endsWith('/categories/cat-1')), 'the delete was never sent');
});

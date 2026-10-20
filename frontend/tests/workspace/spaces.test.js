// The spaces.
//
// A space is a group of references that narrows what a member may see. The
// checks drive the desk's space surface against a stubbed server and ask what
// a reader would see, and what the client would send.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from '../helpers/dom-stub.js';
import {
  api, find, byText, buttonNamed, controlNamed, fieldNamed, openForm, textOf, waitFor, callTo,
} from './helpers.js';

installDomStub();

const { spacesList, spacesDetail } = await import('../../js/features/workspace/spaces.js');
const { State } = await import('../../packages/store.js');

// The store is shared with the other checks, so what these checks put in it
// is taken out again when they are done.
after(() => { State.servers = []; State.user = null; });

const SPACE = {
  id: 'space-1',
  name: 'Engineering',
  description: 'The people who build it',
  isPrivate: false,
  position: 0,
  items: [
    { id: 'item-1', spaceId: 'space-1', kind: 'channel', targetId: 'chan-1', title: 'general', position: 0 },
    { id: 'item-2', spaceId: 'space-1', kind: 'document', targetId: 'doc-1', title: 'How we work', position: 1 },
    { id: 'item-3', spaceId: 'space-1', kind: 'board', targetId: 'board-1', title: 'The quarter', position: 2 },
  ],
};

const CTX = { page: { id: 'community.workspace.spaces' }, params: {}, serverId: 's1' };

// The reader of these checks manages the community's structure, which is what
// lets a space be made and arranged.
function asManager() {
  State.servers = [{ id: 's1', name: 'Ember Works', permissions: ['MANAGE_CHANNELS'] }];
  State.user = { id: 'me', username: 'ada' };
}

function routes(overrides) {
  return Object.assign({
    [api('/spaces')]: { json: [SPACE] },
    [api('/spaces/space-1')]: { json: SPACE },
    [api('/channels')]: { json: { categories: [], channels: [{ id: 'chan-1', name: 'general' }] } },
    [api('/documents')]: { json: [{ id: 'doc-1', title: 'How we work', revision: 1 }] },
    [api('/boards')]: { json: [{ id: 'board-1', name: 'The quarter' }] },
  }, overrides || {});
}

test('the spaces list shows the spaces of the community', async () => {
  asManager();
  const calls = installFetchStub(routes());
  const view = spacesList(CTX);
  await view.onMount();

  assert.ok(byText(view.node, 'Engineering').length > 0, 'the space is not listed');
  assert.ok(byText(view.node, 'The people who build it').length > 0, 'the space has no description');
  assert.ok(callTo(calls, 'GET', api('/spaces')), 'the spaces were not read');
});

test('a space is made from the list', async () => {
  asManager();
  const calls = installFetchStub(routes({ [api('/spaces')]: { json: [] } }));
  const view = spacesList(CTX);
  await view.onMount();

  const make = buttonNamed(view.node, 'New space');
  assert.ok(make, 'a reader who may manage the structure is not offered a new space');
  make.click();

  const name = fieldNamed(document.body, 'The name of the space');
  assert.ok(name, 'the space editor has no name field');
  name.value = 'Engineering';
  openForm().submit();

  const made = await waitFor(() => callTo(calls, 'POST', api('/spaces')));
  assert.ok(made, 'the space was not made');
  assert.equal(made.body.name, 'Engineering');
  assert.equal(made.body.isPrivate, false);
});

test('a reference is added to a space', async () => {
  asManager();
  const calls = installFetchStub(routes());
  const view = spacesDetail({ page: { id: 'community.workspace.space' }, params: { spaceId: 'space-1' }, serverId: 's1' });
  await view.onMount();

  const add = buttonNamed(view.node, 'Add a reference');
  assert.ok(add, 'a reader who may manage the structure cannot add a reference');
  add.click();

  // The picker offers only what the reader may see, so it reads the channels,
  // the documents and the boards of the community first.
  await waitFor(() => callTo(calls, 'GET', api('/documents')) && callTo(calls, 'GET', api('/boards')));
  const kind = fieldNamed(document.body, 'What kind of reference');
  const target = fieldNamed(document.body, 'The thing to reference');
  assert.ok(kind && target, 'the picker has no kind or target');
  kind.value = 'document';
  kind.dispatch('change', {});
  target.value = 'doc-1';
  openForm().submit();

  const added = await waitFor(() => callTo(calls, 'POST', api('/spaces/space-1/items')));
  assert.ok(added, 'the reference was not added');
  assert.equal(added.body.kind, 'document');
  assert.equal(added.body.targetId, 'doc-1');
});

test('the references of a space are put in order', async () => {
  asManager();
  const calls = installFetchStub(routes());
  const view = spacesDetail({ page: { id: 'community.workspace.space' }, params: { spaceId: 'space-1' }, serverId: 's1' });
  await view.onMount();

  const up = controlNamed(view.node, 'Move How we work up');
  assert.ok(up, 'a reference cannot be moved up');
  up.click();

  const reordered = await waitFor(() => callTo(calls, 'POST', api('/spaces/space-1/reorder')));
  assert.ok(reordered, 'the order was not sent');
  assert.deepEqual(reordered.body.orderedIds, ['item-2', 'item-1', 'item-3']);
});

test('a reference is taken out of a space', async () => {
  asManager();
  const calls = installFetchStub(routes());
  const view = spacesDetail({ page: { id: 'community.workspace.space' }, params: { spaceId: 'space-1' }, serverId: 's1' });
  await view.onMount();

  const remove = controlNamed(view.node, 'Remove general from the space');
  assert.ok(remove, 'a reference cannot be removed');
  remove.click();

  // The removal is confirmed, because it is a removal.
  const dialog = await waitFor(() => document.body.querySelector('.dialog'));
  assert.ok(dialog, 'the removal was not confirmed');
  const confirm = buttonNamed(dialog, 'Remove');
  assert.ok(confirm, 'the confirmation has no confirm button');
  confirm.click();

  const removed = await waitFor(() => callTo(calls, 'DELETE', api('/spaces/space-1/items/item-1')));
  assert.ok(removed, 'the reference was not removed');
});

test('a space holds the references it points at', async () => {
  asManager();
  installFetchStub(routes());
  const view = spacesDetail({ page: { id: 'community.workspace.space' }, params: { spaceId: 'space-1' }, serverId: 's1' });
  await view.onMount();

  const text = textOf(view.node);
  assert.ok(text.indexOf('general') !== -1, 'the channel is not named');
  assert.ok(text.indexOf('How we work') !== -1, 'the document is not named');
  assert.ok(text.indexOf('The quarter') !== -1, 'the board is not named');
});

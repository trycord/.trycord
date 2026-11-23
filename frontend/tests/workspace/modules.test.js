// The two modules.
//
// The desk and the phone are two interfaces, not one interface at two widths:
// the desk is three columns and the phone is a screen at a time. The checks
// read both and ask each for its own shape, and read the sources to ask that
// neither reaches into the other.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { installDomStub, installFetchStub } from '../helpers/dom-stub.js';
import { CLIENT, read } from '../helpers/source.js';
import { api, find, byText, waitFor } from './helpers.js';

installDomStub();

const { renderWorkspace } = await import('../../js/features/workspace.js');
const phone = await import('../../mobile/js/views/workspace.js');
const { State } = await import('../../packages/store.js');
const { SURFACES } = await import('../../packages/workspace.js');

// The surfaces are the registry's truth, and both interfaces draw one door
// (or strip item) per surface. The count is read, not typed, so a new surface
// - files arrived this way - is a product change, not a test edit.
const SURFACES_LENGTH = SURFACES.length;

// The store is shared with the other checks, so what these checks put in it
// is taken out again when they are done.
after(() => { State.servers = []; State.user = null; });

const DOCUMENT = {
  id: 'doc-1', serverId: 's1', title: 'How we work', body: [{ type: 'paragraph', text: 'We write it down.' }],
  revision: 3, authorId: 'ada', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-02T09:00:00.000Z',
};

function asMember() {
  State.servers = [{ id: 's1', name: 'Ember Works', permissions: ['SEND_MESSAGES', 'MANAGE_CHANNELS', 'MEMORIZE'] }];
  State.user = { id: 'me', username: 'me' };
}

function routes() {
  return {
    [api('/spaces')]: { json: [] },
    [api('/documents')]: { json: [DOCUMENT] },
    [api('/boards')]: { json: [] },
    [api('/events')]: { json: [] },
    [api('/polls')]: { json: [] },
    [api('/files')]: { json: [] },
    [api('/documents/doc-1')]: { json: DOCUMENT },
    [api('/documents/doc-1/revisions')]: { json: [] },
    [api('/documents/doc-1/comments')]: { json: [] },
    [api('/documents/doc-1/links')]: { json: [] },
  };
}

function hasClass(node, name) {
  return !!(node && node.classList && node.classList.contains(name));
}

test('the desk is three columns', async () => {
  asMember();
  installFetchStub(routes());
  const view = renderWorkspace({ page: { id: 'community.workspace' }, params: {}, serverId: 's1' });
  await view.onMount();

  assert.ok(hasClass(view.node, 'studio'), 'the desk is not a studio');
  const doors = find(view.node, (node) => hasClass(node, 'studionav-link'));
  // One door per surface in the registry, so a new surface arrives with its
  // door rather than leaving the reader to find it by address.
  assert.equal(doors.length, SURFACES_LENGTH, 'the desk does not carry every surface as its doors');
  assert.ok(find(view.node, (node) => hasClass(node, 'collection-layout')).length > 0,
    'the desk does not put the list beside the thing itself');
});

test('the desk puts the list beside the thing itself', async () => {
  asMember();
  installFetchStub(routes());
  const view = renderWorkspace({
    page: { id: 'community.workspace.documents' }, params: {}, serverId: 's1',
  });
  await view.onMount();

  const list = find(view.node, (node) => hasClass(node, 'collection-list'));
  const detail = find(view.node, (node) => hasClass(node, 'collection-detail'));
  assert.ok(list.length > 0, 'the desk has no list column');
  assert.ok(detail.length > 0, 'the desk has no detail column');
  assert.ok(byText(list[0], 'How we work').length > 0, 'the list does not hold the documents');
});

test('the phone keeps the files, one screen at a time', async () => {
  asMember();
  const calls = installFetchStub(routes());
  const view = phone.renderWorkspace({ page: { id: 'community.workspace' }, params: {}, serverId: 's1' });
  await view.onMount();
  await waitFor(() => byText(view.node, 'No files yet').length > 0 || byText(view.node, 'The store').length > 0);

  assert.ok(calls.some((call) => call.url === api('/files')), 'the phone did not read the file store');
  assert.equal(find(view.node, (node) => hasClass(node, 'collection-layout')).length, 0,
    'the phone is the desk in a narrow window');
  assert.equal(find(view.node, (node) => hasClass(node, 'm-seg')).length, 0,
    'the phone has no strip of surfaces; the files are the one surface it keeps');
});

test('neither module reaches into the other', () => {
  const desk = read(path.join(CLIENT, 'js', 'features', 'workspace.js'));
  const phoneSource = read(path.join(CLIENT, 'mobile', 'js', 'views', 'workspace.js'));

  assert.doesNotMatch(desk, /mobile\//, 'the desk names the mobile module');
  assert.doesNotMatch(phoneSource, /\.\.\/\.\.\/js\//, 'the phone names the desk module');
  assert.doesNotMatch(phoneSource, /js\/features/, 'the phone names the desk module');
});

test('the two modules keep their own files', () => {
  const deskFile = path.join(CLIENT, 'js', 'features', 'workspace.js');
  const phoneFile = path.join(CLIENT, 'mobile', 'js', 'views', 'workspace.js');
  assert.ok(fs.existsSync(deskFile), 'the desk has no workspace');
  assert.ok(fs.existsSync(phoneFile), 'the phone has no workspace');
  assert.notEqual(deskFile, phoneFile);
});

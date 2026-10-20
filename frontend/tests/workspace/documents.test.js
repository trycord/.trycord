// The documents.
//
// A document is a community page made of the same typed blocks the page editor
// stores. What the checks drive is the collaborative part: that a document
// opens, that a save carries the revision it was written against, and that a
// save written against an older revision is refused rather than quietly
// replacing somebody's work.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from '../helpers/dom-stub.js';
import { api, byText, buttonNamed, fieldNamed, textOf, waitFor, callTo } from './helpers.js';

installDomStub();

const { documentsList, documentsDetail } = await import('../../js/features/workspace/documents.js');
const { State } = await import('../../packages/store.js');

// The store is shared with the other checks, so what these checks put in it
// is taken out again when they are done.
after(() => { State.servers = []; State.user = null; });

const DOCUMENT = {
  id: 'doc-1',
  serverId: 's1',
  title: 'How we work',
  body: [
    { type: 'heading', level: 2, text: 'The rules' },
    { type: 'paragraph', text: 'We write it down.' },
    { type: 'list', ordered: false, items: ['one', 'two'] },
  ],
  revision: 3,
  authorId: 'ada',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T09:00:00.000Z',
};

const CTX = { page: { id: 'community.workspace.document' }, params: { documentId: 'doc-1' }, serverId: 's1' };

function asWriter() {
  State.servers = [{ id: 's1', name: 'Ember Works', permissions: ['MEMORIZE', 'SEND_MESSAGES'] }];
  State.user = { id: 'me', username: 'ada' };
}

function routes(overrides) {
  return Object.assign({
    [api('/documents')]: { json: [DOCUMENT] },
    [api('/documents/doc-1')]: { json: DOCUMENT },
    [api('/documents/doc-1/revisions')]: { json: [] },
    [api('/documents/doc-1/comments')]: { json: [] },
    [api('/documents/doc-1/links')]: { json: [] },
  }, overrides || {});
}

test('the document list shows the documents of the community', async () => {
  asWriter();
  const calls = installFetchStub(routes());
  const view = documentsList({ page: { id: 'community.workspace.documents' }, params: {}, serverId: 's1' });
  await view.onMount();

  assert.ok(byText(view.node, 'How we work').length > 0, 'the document is not listed');
  assert.ok(callTo(calls, 'GET', api('/documents')), 'the documents were not read');
});

test('a document opens and shows its blocks', async () => {
  asWriter();
  const calls = installFetchStub(routes());
  const view = documentsDetail(CTX);
  await view.onMount();

  const text = textOf(view.node);
  assert.ok(text.indexOf('The rules') !== -1, 'the heading is not shown');
  assert.ok(text.indexOf('We write it down.') !== -1, 'the paragraph is not shown');
  assert.ok(text.indexOf('one') !== -1, 'the list is not shown');
  assert.ok(callTo(calls, 'GET', api('/documents/doc-1')), 'the document was not read');
});

test('a document opens under the address the registry gives it', async () => {
  asWriter();
  installFetchStub(routes());
  // The registry names the parameter after the thing it names.
  const view = documentsDetail({
    page: { id: 'community.workspace.document' }, params: { document: 'doc-1' }, serverId: 's1',
  });
  await view.onMount();

  assert.ok(byText(view.node, 'We write it down.').length > 0, 'the document did not open');
});

test('a save carries the revision it was written against', async () => {
  asWriter();
  const calls = installFetchStub(routes({
    [api('/documents/doc-1')]: (body, seen) => {
      if (seen[seen.length - 1].options.method === 'PUT') {
        return { json: Object.assign({}, DOCUMENT, { title: body.title, revision: 4 }) };
      }
      return { json: DOCUMENT };
    },
  }));
  const view = documentsDetail(CTX);
  await view.onMount();

  const edit = buttonNamed(view.node, 'Edit');
  assert.ok(edit, 'a reader who may write is not offered the editor');
  edit.click();

  const title = fieldNamed(view.node, 'The title of the document');
  assert.ok(title, 'the editor has no title field');
  title.value = 'How we work here';
  title.dispatch('input', {});

  const save = buttonNamed(view.node, 'Save');
  assert.ok(save, 'the editor has no save button');
  save.click();

  const saved = await waitFor(() => callTo(calls, 'PUT', api('/documents/doc-1')));
  assert.ok(saved, 'the document was not saved');
  assert.equal(saved.body.title, 'How we work here');
  assert.equal(saved.body.revision, 3, 'the save did not state the revision it was written against');
  assert.equal(saved.body.overwrite, false);
  assert.deepEqual(saved.body.body, DOCUMENT.body);
});

test('a save written against an older revision is refused, and the newer one is left alone', async () => {
  asWriter();
  // The server moves on while the reader is writing: after the refusal it
  // holds revision 7, and reading the document brings that in.
  let conflicted = false;
  const calls = installFetchStub(routes({
    [api('/documents/doc-1')]: (body, seen) => {
      const last = seen[seen.length - 1];
      if (last.options.method === 'PUT') {
        conflicted = true;
        return {
          ok: false,
          status: 409,
          json: {
            error: {
              code: 'CONFLICT',
              message: 'this document changed since you loaded it',
              details: { currentRevision: 7, submittedRevision: 3 },
            },
          },
        };
      }
      return { json: conflicted ? Object.assign({}, DOCUMENT, { revision: 7 }) : DOCUMENT };
    },
  }));
  const view = documentsDetail(CTX);
  await view.onMount();

  buttonNamed(view.node, 'Edit').click();
  const title = fieldNamed(view.node, 'The title of the document');
  title.value = 'My version';
  title.dispatch('input', {});
  buttonNamed(view.node, 'Save').click();

  // The conflict is shown, and it says what the server holds.
  const conflict = await waitFor(() => byText(view.node, 'This document changed while you were writing it')[0]);
  assert.ok(conflict, 'the conflict was not shown');
  assert.ok(byText(view.node, 'revision 7').length > 0, 'the conflict does not say which revision the server holds');

  // The write was refused, not quietly made again over somebody's work.
  const puts = calls.filter((call) => call.options.method === 'PUT');
  assert.equal(puts.length, 1, 'the refused save was sent again');
  assert.equal(puts[0].body.overwrite, false, 'the refused save was made over the server\'s version');

  // The reader chooses: reload brings the newer revision in.
  const reload = buttonNamed(view.node, 'Reload from the server');
  assert.ok(reload, 'the reader is not offered a reload');
  reload.click();

  await waitFor(() => byText(view.node, 'Revision 7').length > 0);
  assert.ok(byText(view.node, 'Revision 7').length > 0, 'the newer revision was not brought in');
});

test('overwriting is deliberate', async () => {
  asWriter();
  const calls = installFetchStub(routes({
    [api('/documents/doc-1')]: (body, seen) => {
      const last = seen[seen.length - 1];
      if (last.options.method === 'PUT' && last.body.overwrite === true) {
        return { json: Object.assign({}, DOCUMENT, { title: last.body.title, revision: 8 }) };
      }
      if (last.options.method === 'PUT') {
        return {
          ok: false,
          status: 409,
          json: {
            error: {
              code: 'CONFLICT',
              message: 'this document changed since you loaded it',
              details: { currentRevision: 7, submittedRevision: 3 },
            },
          },
        };
      }
      return { json: DOCUMENT };
    },
  }));
  const view = documentsDetail(CTX);
  await view.onMount();

  buttonNamed(view.node, 'Edit').click();
  const title = fieldNamed(view.node, 'The title of the document');
  title.value = 'My version';
  title.dispatch('input', {});
  buttonNamed(view.node, 'Save').click();

  const replace = await waitFor(() => buttonNamed(view.node, 'Replace it with mine'));
  assert.ok(replace, 'the reader is not offered the choice to replace the server\'s version');
  replace.click();

  const overwritten = await waitFor(() => calls.filter((call) => (
    call.options.method === 'PUT' && call.body.overwrite === true
  ))[0]);
  assert.ok(overwritten, 'the deliberate overwrite was not sent');
  assert.equal(overwritten.body.overwrite, true);
  assert.equal(overwritten.body.revision, 3, 'the overwrite did not state the revision it was written against');
});

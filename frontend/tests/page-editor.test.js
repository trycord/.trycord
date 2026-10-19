// The page editor.
//
// The editor is one thing with two faces: a list of blocks, and the source
// that writes the same blocks. This drives it against a stubbed server and
// checks that it reads the real content model, writes the real body, and
// refuses a body the server would refuse.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from './helpers/dom-stub.js';

installDomStub();

const { adminPageEditor } = await import('../js/features/adminPages.js');
const { State } = await import('../packages/store.js');

const BASE = 'http://localhost';

const PAGE = {
  route: 'terms',
  title: 'Terms of Service',
  legal: true,
  status: 'DRAFT',
  hasDraft: true,
  hasPublished: false,
  draft: [
    { type: 'heading', level: 2, text: 'What this covers' },
    { type: 'paragraph', text: 'The rules of this instance.' },
    { type: 'list', ordered: false, items: ['one', 'two'] },
  ],
  published: [],
  outstandingFields: ['OPERATOR: contact address'],
  draftAuthor: 'admin',
  draftAt: '2026-10-01T10:00:00.000Z',
  publishedAuthor: null,
  publishedAt: null,
};

function routes(overrides) {
  return Object.assign({
    [BASE + '/api/admin/pages']: { json: [PAGE] },
    [BASE + '/api/admin/pages/terms']: { json: PAGE },
    [BASE + '/api/admin/pages/terms/revisions']: { json: [] },
  }, overrides || {});
}

async function openEditor(overrides) {
  const calls = installFetchStub(routes(overrides));
  const editor = adminPageEditor();
  await editor.onMount();
  return { editor, calls };
}

function find(node, predicate, found = []) {
  if (!node) return found;
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

function byText(node, text) {
  return find(node, (candidate) => String(candidate.textContent || '').indexOf(text) !== -1);
}

function buttonNamed(node, label) {
  return find(node, (candidate) => (
    candidate.tagName === 'BUTTON'
    && String(candidate.textContent || '').trim().toLowerCase() === label.toLowerCase()
  ))[0] || null;
}

test('the editor lists the pages and opens the first one', async () => {
  const { editor, calls } = await openEditor();
  const names = byText(editor.node, 'Terms of Service');
  assert.ok(names.length > 0, 'the page is not listed');
  assert.ok(calls.some((call) => call.url === BASE + '/api/admin/pages'), 'the list was not read');
  assert.ok(calls.some((call) => call.url === BASE + '/api/admin/pages/terms'), 'the page was not opened');
});

test('the editor shows the blocks of the draft', async () => {
  const { editor } = await openEditor();
  const blocks = find(editor.node, (node) => node.getAttribute && node.getAttribute('data-block-type'));
  const types = blocks.map((node) => node.getAttribute('data-block-type'));
  assert.deepEqual(types, ['heading', 'paragraph', 'list']);
});

test('the source mode writes the same blocks', async () => {
  const { editor } = await openEditor();
  // The mode is switched by the control the editor draws.
  const tab = find(editor.node, (node) => (
    node.tagName === 'BUTTON' && String(node.textContent || '').trim() === 'Source'
  ))[0];
  assert.ok(tab, 'the source tab is not there');
  tab.click();
  const area = find(editor.node, (node) => node.getAttribute && node.getAttribute('aria-label') === 'Page source')[0];
  assert.ok(area, 'the source field is not there');
  assert.match(String(area.value || ''), /## What this covers/);
  assert.match(String(area.value || ''), /- one/);
});

test('a draft written in the source mode carries what the source says', async () => {
  const { editor, calls } = await openEditor();
  const tab = find(editor.node, (node) => (
    node.tagName === 'BUTTON' && String(node.textContent || '').trim() === 'Source'
  ))[0];
  tab.click();
  const area = find(editor.node, (node) => node.getAttribute && node.getAttribute('aria-label') === 'Page source')[0];
  assert.ok(area, 'the source field is not there');
  area.value = '## A different heading\n\nA different paragraph.';
  area.dispatch('input');

  const save = buttonNamed(editor.node, 'Save draft');
  save.click();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const saved = calls.find((call) => call.options.method === 'PUT');
  assert.ok(saved, 'the draft was never written');
  assert.deepEqual(saved.body.body, [
    { type: 'heading', level: 2, text: 'A different heading' },
    { type: 'paragraph', text: 'A different paragraph.' },
  ]);
});

test('a draft is written as the blocks the server stores', async () => {
  const { editor, calls } = await openEditor();
  const save = buttonNamed(editor.node, 'Save draft');
  assert.ok(save, 'there is no save control');
  save.click();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const saved = calls.find((call) => call.url === BASE + '/api/admin/pages/terms' && call.options.method === 'PUT');
  assert.ok(saved, 'the draft was never written');
  assert.equal(saved.body.title, 'Terms of Service');
  assert.deepEqual(saved.body.body, PAGE.draft);
});

test('a page that moved on the server is not overwritten silently', async () => {
  // The page is opened, and then someone else saves it: the second read of the
  // page answers with a newer draft than the one the editor opened.
  const moved = Object.assign({}, PAGE, { draftAt: '2026-10-02T09:00:00.000Z' });
  let reads = 0;
  const calls = installFetchStub(routes({
    [BASE + '/api/admin/pages/terms']: () => {
      reads += 1;
      return { json: reads === 1 ? PAGE : moved };
    },
  }));
  const editor = adminPageEditor();
  await editor.onMount();
  calls.length = 0;

  const save = buttonNamed(editor.node, 'Save draft');
  save.click();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const written = calls.find((call) => call.options.method === 'PUT');
  assert.equal(written, undefined, 'the newer work on the server was overwritten without saying so');
  const warning = byText(editor.node, 'This page changed on the server');
  assert.ok(warning.length > 0, 'the change was not reported');
});

test('a body the server would refuse is not written', async () => {
  const { editor, calls } = await openEditor();
  // Empty the first block, which the server refuses.
  const heading = find(editor.node, (node) => (
    node.getAttribute && node.getAttribute('aria-label') === 'Heading text'
  ))[0];
  assert.ok(heading, 'the heading field is not there');
  heading.value = '';
  heading.dispatch('input');

  const save = buttonNamed(editor.node, 'Save draft');
  save.click();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const written = calls.find((call) => call.options.method === 'PUT');
  assert.equal(written, undefined, 'a body with an empty heading was written');
  const problem = byText(editor.node, 'cannot be saved as it is');
  assert.ok(problem.length > 0, 'the problem was not reported');
});

test('the preview is rendered by the server, not by the client', async () => {
  const { editor, calls } = await openEditor();
  const preview = buttonNamed(editor.node, 'Preview');
  assert.ok(preview, 'there is no preview control');
  preview.click();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const asked = calls.find((call) => call.options.method === 'PUT');
  assert.ok(asked, 'the preview was not asked for');
  assert.equal(asked.body.preview, true);
  assert.deepEqual(asked.body.body, PAGE.draft);
});

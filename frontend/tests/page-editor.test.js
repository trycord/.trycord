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

// The editor is the administrator's, so the account holding it is one.
State.user = { id: 'admin', isAdmin: true };

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

// A page that uses the whole vocabulary: a picture, a quotation, a code block
// and a table.
const RICH = Object.assign({}, PAGE, {
  draft: [
    { type: 'heading', level: 2, text: 'What this covers' },
    { type: 'image', src: '/uploads/picture.png', alt: 'A picture', width: 320 },
    { type: 'quote', text: 'What they said.', attribution: 'Someone' },
    { type: 'code', text: 'const x = 1;\n  const y = 2;', language: 'js' },
    { type: 'table', headers: ['Name', 'Cost'], rows: [['Tea', '2']], caption: 'Prices' },
  ],
});

const REVISIONS = [
  { revision: 2, title: 'Terms of Service', state: 'DRAFT', authorId: 'admin', createdAt: '2026-10-02T09:00:00.000Z', body: RICH.draft, isDraft: true },
  { revision: 1, title: 'Terms of Service', state: 'PUBLISHED', authorId: 'admin', createdAt: '2026-10-01T10:00:00.000Z', body: PAGE.draft, isPublished: true },
];

const COMPARISON = {
  route: 'terms',
  from: { revision: 1, title: 'Terms of Service' },
  to: { revision: 2, title: 'Terms of Service' },
  titleChanged: false,
  added: [{ index: 1, block: { type: 'image', src: '/uploads/picture.png', alt: 'A picture', width: 320 } }],
  removed: [],
  changed: [],
  unchanged: 3,
  summary: { added: 1, removed: 0, changed: 0, unchanged: 3 },
};

const LIBRARY = [{
  id: 'block-1',
  name: 'Contact details',
  body: [{ type: 'paragraph', text: 'Write to us at the address below.' }],
  scope: 'SHARED',
  authorId: 'admin',
  mine: true,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
}];

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

function fieldNamed(node, label) {
  return find(node, (candidate) => (
    candidate.getAttribute && candidate.getAttribute('aria-label') === label
  ))[0] || null;
}

function sourceTab(editor) {
  return buttonNamed(editor.node, 'Source');
}

function blocksTab(editor) {
  return buttonNamed(editor.node, 'Blocks');
}

function sourceArea(editor) {
  return fieldNamed(editor.node, 'Page source');
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
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
  const tab = sourceTab(editor);
  assert.ok(tab, 'the source tab is not there');
  tab.click();
  const area = sourceArea(editor);
  assert.ok(area, 'the source field is not there');
  assert.match(String(area.value || ''), /## What this covers/);
  assert.match(String(area.value || ''), /- one/);
});

test('a draft written in the source mode carries what the source says', async () => {
  const { editor, calls } = await openEditor();
  sourceTab(editor).click();
  const area = sourceArea(editor);
  assert.ok(area, 'the source field is not there');
  area.value = '## A different heading\n\nA different paragraph.';
  area.dispatch('input');

  const save = buttonNamed(editor.node, 'Save draft');
  save.click();
  await settle();

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
  await settle();

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
  await settle();

  const written = calls.find((call) => call.options.method === 'PUT');
  assert.equal(written, undefined, 'the newer work on the server was overwritten without saying so');
  const warning = byText(editor.node, 'This page changed on the server');
  assert.ok(warning.length > 0, 'the change was not reported');
});

test('a body the server would refuse is not written', async () => {
  const { editor, calls } = await openEditor();
  // Empty the first block, which the server refuses.
  const heading = fieldNamed(editor.node, 'Heading text');
  assert.ok(heading, 'the heading field is not there');
  heading.value = '';
  heading.dispatch('input');

  const save = buttonNamed(editor.node, 'Save draft');
  save.click();
  await settle();

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
  await settle();

  const asked = calls.find((call) => call.options.method === 'PUT');
  assert.ok(asked, 'the preview was not asked for');
  assert.equal(asked.body.preview, true);
  assert.deepEqual(asked.body.body, PAGE.draft);
});

test('the preview of the new blocks is rendered by the server too', async () => {
  const { editor, calls } = await openEditor({ [BASE + '/api/admin/pages/terms']: { json: RICH } });
  buttonNamed(editor.node, 'Preview').click();
  await settle();

  const asked = calls.find((call) => call.options.method === 'PUT');
  assert.ok(asked, 'the preview was not asked for');
  assert.equal(asked.body.preview, true);
  assert.deepEqual(asked.body.body, RICH.draft, 'the client rendered the blocks itself');
});

// -- the new block types ------------------------------------------------------

test('the editor shows a row for each of the new block types', async () => {
  const { editor } = await openEditor({ [BASE + '/api/admin/pages/terms']: { json: RICH } });
  const types = find(editor.node, (node) => node.getAttribute && node.getAttribute('data-block-type'))
    .map((node) => node.getAttribute('data-block-type'));
  assert.deepEqual(types, ['heading', 'image', 'quote', 'code', 'table']);
  assert.ok(fieldNamed(editor.node, 'Image source'), 'the image has no source field');
  assert.ok(fieldNamed(editor.node, 'Image alt text'), 'the image has no alt text field');
  assert.ok(fieldNamed(editor.node, 'Quotation text'), 'the quotation has no text field');
  assert.ok(fieldNamed(editor.node, 'Quotation attribution'), 'the quotation has no attribution field');
  assert.ok(fieldNamed(editor.node, 'Code text'), 'the code block has no text field');
  assert.ok(fieldNamed(editor.node, 'Code language'), 'the code block has no language field');
  assert.ok(fieldNamed(editor.node, 'Table caption'), 'the table has no caption field');
  assert.ok(fieldNamed(editor.node, 'Column 1 heading'), 'the table has no headings');
});

test('the blocks mode edits an image and writes the right shape', async () => {
  const { editor, calls } = await openEditor({ [BASE + '/api/admin/pages/terms']: { json: RICH } });
  const source = fieldNamed(editor.node, 'Image source');
  const alt = fieldNamed(editor.node, 'Image alt text');
  source.value = 'https://example.org/other.png';
  source.dispatch('input');
  alt.value = 'Another picture';
  alt.dispatch('input');

  buttonNamed(editor.node, 'Save draft').click();
  await settle();

  const saved = calls.find((call) => call.options.method === 'PUT');
  assert.ok(saved, 'the draft was never written');
  const image = saved.body.body.find((block) => block.type === 'image');
  assert.deepEqual(image, {
    type: 'image', src: 'https://example.org/other.png', alt: 'Another picture', width: 320,
  });
});

test('an image without alt text cannot be saved, and says why', async () => {
  const { editor, calls } = await openEditor({ [BASE + '/api/admin/pages/terms']: { json: RICH } });
  const alt = fieldNamed(editor.node, 'Image alt text');
  alt.value = '';
  alt.dispatch('input');

  buttonNamed(editor.node, 'Save draft').click();
  await settle();

  const written = calls.find((call) => call.options.method === 'PUT');
  assert.equal(written, undefined, 'an image without alt text was written');
  assert.ok(byText(editor.node, 'cannot be saved as it is').length > 0, 'the problem was not reported');
  assert.ok(byText(editor.node, 'an image needs alt text').length > 0, 'the reason was not given');
});

test('an image with a javascript: source cannot be saved', async () => {
  const { editor, calls } = await openEditor({ [BASE + '/api/admin/pages/terms']: { json: RICH } });
  const source = fieldNamed(editor.node, 'Image source');
  source.value = 'javascript:alert(1)';
  source.dispatch('input');

  buttonNamed(editor.node, 'Save draft').click();
  await settle();

  const written = calls.find((call) => call.options.method === 'PUT');
  assert.equal(written, undefined, 'an image the server would not fetch was written');
  assert.ok(byText(editor.node, 'an image source must be http, https').length > 0, 'the reason was not given');
});

test('the blocks mode edits a quotation and writes the right shape', async () => {
  const { editor, calls } = await openEditor({ [BASE + '/api/admin/pages/terms']: { json: RICH } });
  const text = fieldNamed(editor.node, 'Quotation text');
  const attribution = fieldNamed(editor.node, 'Quotation attribution');
  text.value = 'What else they said.';
  text.dispatch('input');
  attribution.value = 'Someone else';
  attribution.dispatch('input');

  buttonNamed(editor.node, 'Save draft').click();
  await settle();

  const saved = calls.find((call) => call.options.method === 'PUT');
  const quote = saved.body.body.find((block) => block.type === 'quote');
  assert.deepEqual(quote, {
    type: 'quote', text: 'What else they said.', attribution: 'Someone else',
  });
});

test('the blocks mode edits a code block and keeps its indentation', async () => {
  const { editor, calls } = await openEditor({ [BASE + '/api/admin/pages/terms']: { json: RICH } });
  const text = fieldNamed(editor.node, 'Code text');
  const language = fieldNamed(editor.node, 'Code language');
  text.value = 'function outer() {\n  return 1;\n}';
  text.dispatch('input');
  language.value = 'JS';
  language.dispatch('input');

  buttonNamed(editor.node, 'Save draft').click();
  await settle();

  const saved = calls.find((call) => call.options.method === 'PUT');
  const code = saved.body.body.find((block) => block.type === 'code');
  assert.equal(code.text, 'function outer() {\n  return 1;\n}');
  assert.equal(code.language, 'js', 'the language is held to what the server holds');
});

test('the blocks mode edits a table and writes the right shape', async () => {
  const { editor, calls } = await openEditor({ [BASE + '/api/admin/pages/terms']: { json: RICH } });
  const cell = fieldNamed(editor.node, 'Row 1, column 1');
  const caption = fieldNamed(editor.node, 'Table caption');
  cell.value = 'Coffee';
  cell.dispatch('input');
  caption.value = 'Prices today';
  caption.dispatch('input');

  buttonNamed(editor.node, 'Save draft').click();
  await settle();

  const saved = calls.find((call) => call.options.method === 'PUT');
  const table = saved.body.body.find((block) => block.type === 'table');
  assert.deepEqual(table, {
    type: 'table',
    headers: ['Name', 'Cost'],
    rows: [['Coffee', '2']],
    caption: 'Prices today',
  });
});

test('a column added to a table is added to every row', async () => {
  const { editor, calls } = await openEditor({ [BASE + '/api/admin/pages/terms']: { json: RICH } });
  const add = buttonNamed(editor.node, 'Add column');
  assert.ok(add, 'there is no way to add a column');
  add.click();

  // A new column starts blank, and the server refuses a table with a blank
  // heading, so the operator fills it in before the table can be saved.
  const heading = fieldNamed(editor.node, 'Column 3 heading');
  assert.ok(heading, 'the new column has no heading');
  heading.value = 'Cups';
  heading.dispatch('input');

  buttonNamed(editor.node, 'Save draft').click();
  await settle();

  const saved = calls.find((call) => call.options.method === 'PUT');
  assert.ok(saved, 'the draft was never written');
  const table = saved.body.body.find((block) => block.type === 'table');
  assert.deepEqual(table.headers, ['Name', 'Cost', 'Cups']);
  assert.deepEqual(table.rows, [['Tea', '2', '']], 'the row was left narrower than the headings');
});

test('a row added to a table is as wide as its headings', async () => {
  const { editor, calls } = await openEditor({ [BASE + '/api/admin/pages/terms']: { json: RICH } });
  const add = buttonNamed(editor.node, 'Add row');
  assert.ok(add, 'there is no way to add a row');
  add.click();

  buttonNamed(editor.node, 'Save draft').click();
  await settle();

  const saved = calls.find((call) => call.options.method === 'PUT');
  const table = saved.body.body.find((block) => block.type === 'table');
  assert.deepEqual(table.rows, [['Tea', '2'], ['', '']]);
});

test('a table whose row is not as wide as its headings cannot be saved', async () => {
  const { editor, calls } = await openEditor();
  sourceTab(editor).click();
  const area = sourceArea(editor);
  area.value = '| a | b |\n| --- | --- |\n| 1 |';
  area.dispatch('input');

  buttonNamed(editor.node, 'Save draft').click();
  await settle();

  const written = calls.find((call) => call.options.method === 'PUT');
  assert.equal(written, undefined, 'a ragged table was written');
  assert.ok(byText(editor.node, 'same number of cells').length > 0, 'the reason was not given');
});

test('the source mode writes the new blocks in their own spelling', async () => {
  const { editor } = await openEditor({ [BASE + '/api/admin/pages/terms']: { json: RICH } });
  sourceTab(editor).click();
  const area = sourceArea(editor);
  const written = String(area.value || '');
  assert.match(written, /!\[A picture\]\(\/uploads\/picture\.png\) "width=320"/);
  assert.match(written, /> What they said\.\n> -- Someone/);
  assert.match(written, /```js\nconst x = 1;/);
  assert.match(written, /: Prices\n\| Name \| Cost \|/);
});

test('a code block keeps its indentation through the round trip', async () => {
  const { editor, calls } = await openEditor({ [BASE + '/api/admin/pages/terms']: { json: RICH } });
  sourceTab(editor).click();
  blocksTab(editor).click();

  buttonNamed(editor.node, 'Save draft').click();
  await settle();

  const saved = calls.find((call) => call.options.method === 'PUT');
  const code = saved.body.body.find((block) => block.type === 'code');
  assert.equal(code.text, 'const x = 1;\n  const y = 2;');
});

// -- the reusable blocks and the comparison -----------------------------------

test('the reusable blocks on the server are offered and can be inserted', async () => {
  const { editor, calls } = await openEditor({
    [BASE + '/api/admin/pages/blocks']: { json: LIBRARY },
  });
  assert.ok(byText(editor.node, 'Contact details').length > 0, 'the library was not offered');

  const insert = find(editor.node, (node) => (
    node.tagName === 'BUTTON' && node.getAttribute('aria-label') === 'Insert Contact details'
  ))[0];
  assert.ok(insert, 'there is no way to insert the block');
  insert.click();

  buttonNamed(editor.node, 'Save draft').click();
  await settle();

  const saved = calls.find((call) => call.options.method === 'PUT');
  assert.ok(saved.body.body.some((block) => block.text === 'Write to us at the address below.'),
    'the block was not inserted into the page');
});

test('a block can be saved to the library on the server', async () => {
  const { editor, calls } = await openEditor({
    [BASE + '/api/admin/pages/blocks']: { json: LIBRARY },
  });
  const copy = find(editor.node, (node) => (
    node.tagName === 'BUTTON' && node.getAttribute('aria-label') === 'Save this block as a reusable block'
  ))[0];
  assert.ok(copy, 'there is no way to save a block as reusable');
  copy.click();

  const name = fieldNamed(document.body, 'Name for this reusable block');
  assert.ok(name, 'the name of the block was not asked for');
  name.value = 'Our address';
  name.dispatch('input');
  const form = name.parentNode;
  form.dispatch('submit');
  await settle();

  const written = calls.find((call) => call.options.method === 'POST'
    && call.url === BASE + '/api/admin/pages/blocks');
  assert.ok(written, 'the block was never written to the library');
  assert.equal(written.body.name, 'Our address');
  assert.deepEqual(written.body.body, [{ type: 'heading', level: 2, text: 'What this covers' }]);
});

test('a reusable block can be renamed', async () => {
  const { editor, calls } = await openEditor({
    [BASE + '/api/admin/pages/blocks']: { json: LIBRARY },
  });
  const rename = find(editor.node, (node) => (
    node.tagName === 'BUTTON' && node.getAttribute('aria-label') === 'Rename the reusable block Contact details'
  ))[0];
  assert.ok(rename, 'there is no way to rename the block');
  rename.click();

  const name = fieldNamed(document.body, 'Name for this reusable block');
  assert.ok(name, 'the name of the block was not asked for');
  name.value = 'How to reach us';
  name.dispatch('input');
  name.parentNode.dispatch('submit');
  await settle();

  const written = calls.find((call) => call.options.method === 'PUT');
  assert.ok(written, 'the block was never renamed');
  assert.equal(written.url, BASE + '/api/admin/pages/blocks/block-1');
  assert.equal(written.body.name, 'How to reach us');
});

test('two revisions can be compared, and the server says what changed', async () => {
  const { editor, calls } = await openEditor({
    [BASE + '/api/admin/pages/terms/revisions?limit=20']: { json: REVISIONS },
    [BASE + '/api/admin/pages/terms/revisions/compare?from=1&to=2']: { json: COMPARISON },
  });
  const compare = buttonNamed(editor.node, 'Compare revisions');
  assert.ok(compare, 'there is no comparison');
  compare.click();
  await settle();

  const asked = calls.find((call) => (
    call.url === BASE + '/api/admin/pages/terms/revisions/compare?from=1&to=2'
  ));
  assert.ok(asked, 'the server was not asked what changed');

  const dialog = find(document.body, (node) => node.getAttribute && node.getAttribute('role') === 'dialog')[0];
  assert.ok(dialog, 'there is no report');
  assert.ok(byText(dialog, '1 added').length > 0, 'the report does not say what was added');
  assert.ok(byText(dialog, '![A picture](/uploads/picture.png)').length > 0, 'the block that was added is not shown');
});

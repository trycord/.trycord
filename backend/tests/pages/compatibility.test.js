'use strict';

// What must not change.
//
// The page editor has been in use: legal pages have been written under the
// seven-block vocabulary, and the revisions that hold them are in the
// database. Adding images, quotations, code and tables must not alter a
// single byte of what those pages render, and must not make their history
// unreadable.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser } = require('../helpers/instance');
const content = require('../../src/services/pageContent');
const bbcode = require('../../src/services/bbcode');

// The vocabulary as it was before the change.
const OLD_DOCUMENT = [
  { type: 'heading', level: 2, text: 'Terms' },
  { type: 'paragraph', text: 'These terms are the terms.' },
  { type: 'lead', text: 'The short version.' },
  { type: 'list', ordered: false, items: ['One', 'Two'] },
  { type: 'note', kind: 'info', text: 'A note.' },
  { type: 'link', text: 'The rules', href: '/rules' },
  { type: 'rule' },
];

// The exact HTML that document rendered to, block by block, joined the way the
// renderer joins them.
const OLD_HTML = [
  '<h2>Terms</h2>',
  '<p>These terms are the terms.</p>',
  '<p class="lede">The short version.</p>',
  '<ul><li>One</li><li>Two</li></ul>',
  '<div class="draft-note" role="note">A note.</div>',
  '<p><a href="/rules">The rules</a></p>',
  '<hr>',
].join('\n      ');

test('the old vocabulary', async (t) => {
  await t.test('renders exactly as it did', () => {
    assert.equal(content.toHtml(content.normalise(OLD_DOCUMENT)), OLD_HTML);
  });

  await t.test('exports to BBCode exactly as it did', () => {
    const blocks = content.normalise(OLD_DOCUMENT);
    assert.equal(content.toBBCode(blocks), bbcode.toBBCode(blocks));
  });

  await t.test('is still accepted block for block', () => {
    const blocks = content.normalise(OLD_DOCUMENT);
    assert.deepEqual(blocks.map((b) => b.type), OLD_DOCUMENT.map((b) => b.type));
    assert.equal(blocks[0].level, 2);
    assert.equal(blocks[4].kind, 'info');
    assert.equal(blocks[5].href, '/rules');
  });
});

test('a page published before the change', async (t) => {
  const instance = await startInstance({ env: { ADMIN_USERNAMES: 'owner' } });
  t.after(() => instance.stop());
  const owner = await registerUser(instance, 'owner');

  // A page and a revision written by an older build: the rows are in the
  // table in the shape that build left them, under the seven-block
  // vocabulary, and they were written before the change.
  await instance.db.run(
    'INSERT INTO pages (id, route, title, status, legal, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['page-from-an-older-build', 'terms', 'Terms of Service', 'DRAFT', 1, '2024-01-01T00:00:00.000Z']
  );
  await instance.db.run(
    'INSERT INTO page_revisions (id, page_id, revision, body, title, state, author_id, created_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      'revision-from-an-older-build',
      'page-from-an-older-build',
      1,
      JSON.stringify(OLD_DOCUMENT),
      'Terms of Service',
      'DRAFT',
      owner.user.id,
      '2024-01-01T00:00:00.000Z',
    ]
  );

  await owner.put('/api/admin/pages/terms', {
    title: 'Terms of Service',
    body: OLD_DOCUMENT,
  });
  const saved = await owner.get('/api/admin/pages/terms');
  assert.equal(saved.status, 200);
  assert.equal(saved.data.draft.length, OLD_DOCUMENT.length);
  assert.equal(saved.data.description, 'The short version.');

  await t.test('renders the same through the server as it always did', async () => {
    const preview = await owner.put('/api/admin/pages/terms', {
      preview: true,
      body: OLD_DOCUMENT,
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.html, OLD_HTML);
  });

  await t.test('a revision written before the change still restores', async () => {
    const restored = await owner.post('/api/admin/pages/terms/revisions/1/restore');
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.data.draft, content.normalise(OLD_DOCUMENT));
    assert.equal(restored.data.description, 'The short version.');

    // Restoring writes a new revision rather than rewriting the old one, so
    // the history still holds what was there before.
    const revisions = await owner.get('/api/admin/pages/terms/revisions');
    assert.equal(revisions.status, 200);
    const numbers = revisions.data.map((r) => r.revision);
    assert.ok(numbers.includes(1), 'the old revision is still in the history');
    assert.ok(numbers.includes(3), 'the restore is recorded as a new revision');
    const oldest = revisions.data.find((r) => r.revision === 1);
    assert.deepEqual(oldest.body, content.normalise(OLD_DOCUMENT));
    const restoredRevision = revisions.data.find((r) => r.revision === 3);
    assert.deepEqual(restoredRevision.body, content.normalise(OLD_DOCUMENT));
  });

  await t.test('the revision list says which revision is in force', async () => {
    await owner.post('/api/admin/pages/terms/publish', { confirm: 'terms' });
    const revisions = await owner.get('/api/admin/pages/terms/revisions');
    assert.equal(revisions.status, 200);
    const published = revisions.data.filter((r) => r.isPublished);
    const draft = revisions.data.filter((r) => r.isDraft);
    assert.equal(published.length, 1, 'exactly one revision is the published one');
    assert.equal(draft.length, 1, 'exactly one revision is the current draft');
    assert.equal(published[0].state, 'PUBLISHED');
    assert.equal(draft[0].state, 'DRAFT');
  });
});

'use strict';

// Comparing two revisions.
//
// The revision list carries the body of every revision, so two of them can
// be compared. The comparison answers what changed in the content: which
// blocks were added, which were removed and which were rewritten. It is a
// report, not a rendered diff - how two revisions are shown is the client's
// decision.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser } = require('../helpers/instance');

const FIRST = [
  { type: 'heading', level: 2, text: 'Terms' },
  { type: 'paragraph', text: 'The first paragraph.' },
  { type: 'paragraph', text: 'The second paragraph.' },
];

const SECOND = [
  { type: 'heading', level: 2, text: 'Terms' },
  { type: 'paragraph', text: 'The first paragraph, rewritten.' },
  { type: 'list', ordered: false, items: ['A new list'] },
];

test('comparing two revisions', async (t) => {
  const instance = await startInstance({ env: { ADMIN_USERNAMES: 'owner' } });
  t.after(() => instance.stop());
  const owner = await registerUser(instance, 'owner');

  await owner.put('/api/admin/pages/terms', { title: 'Terms of Service', body: FIRST });
  await owner.put('/api/admin/pages/terms', { title: 'Terms and Conditions', body: SECOND });

  await t.test('the comparison says what was added, removed and changed', async () => {
    const res = await owner.get('/api/admin/pages/terms/revisions/compare?from=1&to=2');
    assert.equal(res.status, 200);
    const report = res.data;

    assert.equal(report.route, 'terms');
    assert.equal(report.from.revision, 1);
    assert.equal(report.to.revision, 2);
    assert.equal(report.titleChanged, true, 'the title changed between the two revisions');

    assert.equal(report.added.length, 1);
    assert.equal(report.added[0].index, 2);
    assert.equal(report.added[0].block.type, 'list');

    assert.equal(report.removed.length, 1);
    assert.equal(report.removed[0].index, 2);
    assert.equal(report.removed[0].block.text, 'The second paragraph.');

    assert.equal(report.changed.length, 1);
    assert.equal(report.changed[0].fromIndex, 1);
    assert.equal(report.changed[0].toIndex, 1);
    assert.equal(report.changed[0].before.text, 'The first paragraph.');
    assert.equal(report.changed[0].after.text, 'The first paragraph, rewritten.');

    assert.equal(report.unchanged, 1, 'the heading did not move');
    assert.deepEqual(report.summary, { added: 1, removed: 1, changed: 1, unchanged: 1 });
  });

  await t.test('the comparison is a report about the content, not a rendered diff', async () => {
    const res = await owner.get('/api/admin/pages/terms/revisions/compare?from=1&to=2');
    const report = res.data;
    assert.equal(typeof report.added[0].block, 'object');
    assert.equal(report.added[0].block.type, 'list');
    assert.equal(report.added[0].block.items[0], 'A new list');
    assert.equal(JSON.stringify(report).includes('<p>'), false, 'no markup is in the report');
  });

  await t.test('a revision compared with itself has nothing to report', async () => {
    const res = await owner.get('/api/admin/pages/terms/revisions/compare?from=2&to=2');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.summary, { added: 0, removed: 0, changed: 0, unchanged: 3 });
  });

  await t.test('a revision that does not exist is not found', async () => {
    const res = await owner.get('/api/admin/pages/terms/revisions/compare?from=1&to=99');
    assert.equal(res.status, 404);
    assert.equal(res.data.error.code, 'NOT_FOUND');
  });

  await t.test('a comparison needs two revision numbers', async () => {
    const res = await owner.get('/api/admin/pages/terms/revisions/compare');
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'VALIDATION_ERROR');
  });
});

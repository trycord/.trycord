'use strict';

// Reusable blocks.
//
// The editor's library used to live in one browser, so a block could only be
// shared with the person who wrote it. A block that cannot be shared between
// two administrators of the same instance is not a shared block, so the
// library is on the server.
//
// The rule that matters most is the one about what a page holds: a page holds
// the content of a block, not a reference to it. A published page is a thing
// visitors have already read, and a later edit to a block must not change it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser } = require('../helpers/instance');

const CONTACT = [{ type: 'paragraph', text: 'Write to us.' }];
const EDITED = [{ type: 'paragraph', text: 'Write to us at legal@example.org.' }];

test('reusable blocks', async (t) => {
  const instance = await startInstance({ env: { ADMIN_USERNAMES: 'owner,second' } });
  t.after(() => instance.stop());
  const owner = await registerUser(instance, 'owner');
  const second = await registerUser(instance, 'second');
  const member = await registerUser(instance, 'member');

  // Required after the instance has started, so this is the same module the
  // server is using and the same database connection.
  const pageBlocks = require('../../src/services/pageBlocks');

  await t.test('a shared block is listed for every administrator', async () => {
    const created = await owner.post('/api/admin/pages/blocks', {
      name: 'Contact details',
      body: CONTACT,
      scope: 'SHARED',
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.scope, pageBlocks.SCOPES.SHARED);
    assert.equal(created.data.name, 'Contact details');
    assert.deepEqual(created.data.body, CONTACT);
    assert.equal(created.data.mine, true);

    const library = await second.get('/api/admin/pages/blocks');
    assert.equal(library.status, 200);
    const found = library.data.find((b) => b.id === created.data.id);
    assert.ok(found, 'a shared block is in the library of another administrator');
    assert.deepEqual(found.body, CONTACT);
    assert.equal(found.mine, false);
  });

  await t.test('a shared block is inserted into a page, and editing it later leaves that page alone', async () => {
    const library = await second.get('/api/admin/pages/blocks');
    const block = library.data.find((b) => b.name === 'Contact details');
    assert.ok(block);

    // Inserting a block copies its blocks into the page. The page holds the
    // content, not a reference to the block.
    const body = [{ type: 'heading', level: 2, text: 'Contact' }].concat(block.body);
    const saved = await second.put('/api/admin/pages/support', {
      title: 'Support',
      body,
    });
    assert.equal(saved.status, 200);
    const published = await second.post('/api/admin/pages/support/publish', { confirm: 'support' });
    assert.equal(published.status, 200);

    const page = await instance.baseUrl + '/support';
    const before = await fetch(page);
    assert.equal(before.status, 200);
    const beforeHtml = await before.text();
    assert.match(beforeHtml, /Write to us\./);
    assert.doesNotMatch(beforeHtml, /legal@example\.org/);

    // The block is then edited. The page that used it must not move.
    const edited = await owner.put('/api/admin/pages/blocks/' + block.id, {
      body: EDITED,
    });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.data.body, EDITED);

    const after = await fetch(page);
    const afterHtml = await after.text();
    assert.match(afterHtml, /Write to us\./, 'the published page still holds what it was given');
    assert.doesNotMatch(afterHtml, /legal@example\.org/, 'the edited block did not reach the published page');

    const record = await second.get('/api/admin/pages/support');
    assert.equal(record.data.published.length, 2);
    assert.equal(record.data.published[1].text, 'Write to us.');

    // The revision records the content as it was at that moment.
    const revisions = await second.get('/api/admin/pages/support/revisions');
    const publishedRevision = revisions.data.find((r) => r.isPublished);
    assert.equal(publishedRevision.body[1].text, 'Write to us.');
  });

  await t.test('a personal block belongs to its author', async () => {
    const created = await owner.post('/api/admin/pages/blocks', {
      name: 'My own note',
      body: [{ type: 'note', kind: 'info', text: 'Only mine.' }],
      scope: 'PERSONAL',
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.scope, 'PERSONAL');

    // The other administrator's library does not hold it.
    const library = await second.get('/api/admin/pages/blocks');
    assert.equal(library.data.some((b) => b.id === created.data.id), false);

    // And it cannot be changed or deleted by them either.
    const changed = await second.put('/api/admin/pages/blocks/' + created.data.id, {
      name: 'Not yours',
    });
    assert.equal(changed.status, 404);
    const removed = await second.delete('/api/admin/pages/blocks/' + created.data.id);
    assert.equal(removed.status, 404);

    // The author still has it, and can still write it.
    const mine = await owner.get('/api/admin/pages/blocks');
    assert.ok(mine.data.some((b) => b.id === created.data.id));
    const updated = await owner.put('/api/admin/pages/blocks/' + created.data.id, {
      name: 'My own note, renamed',
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.name, 'My own note, renamed');
  });

  await t.test('writing a shared block is an administrative act', async () => {
    const refused = await member.post('/api/admin/pages/blocks', {
      name: 'Not allowed',
      body: CONTACT,
      scope: 'SHARED',
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.data.error.code, 'PERMISSION_DENIED');

    // The rule is the service's, not only the route's: asked directly, the
    // service refuses a shared block from a caller who is not an
    // administrator.
    await assert.rejects(
      () => pageBlocks.create({
        actorId: member.user.id,
        name: 'Not allowed',
        body: CONTACT,
        scope: 'SHARED',
      }),
      (e) => e.code === 'PERMISSION_DENIED'
    );
  });

  await t.test('writing a shared block is audited', async () => {
    const audit = await instance.db.all(
      'SELECT action, actor_id, target_type, reason FROM audit_logs WHERE target_type = ? ORDER BY created_at',
      ['page_block']
    );
    const actions = audit.map((a) => a.action);
    assert.ok(actions.includes('PAGE_BLOCK_CREATED'));
    assert.ok(actions.includes('PAGE_BLOCK_UPDATED'));
    const shared = audit.find((a) => a.action === 'PAGE_BLOCK_CREATED' && a.reason === 'SHARED');
    assert.ok(shared, 'a shared block records that it was shared');
    assert.equal(shared.actor_id, owner.user.id);
  });

  await t.test('a block is held to the page validator', async () => {
    const refused = await owner.post('/api/admin/pages/blocks', {
      name: 'An image that cannot execute',
      body: [{ type: 'image', src: 'javascript:alert(1)', alt: 'A picture' }],
      scope: 'SHARED',
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.data.error.code, 'VALIDATION_ERROR');
  });
});

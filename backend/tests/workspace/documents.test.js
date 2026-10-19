// Collaborative documents: revisions, conflicts, comments and who may write.
//
// The point of the conflict rule is that two people editing the same
// document cannot lose each other's work by accident: the save that was
// written against an older revision is refused, and the answer says which
// revision the document is on now.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startWorkspace, createCommunity, addMember, createRole, assignRole, registerUser,
} = require('./helpers');

test('documents', async (t) => {
  const ws = await startWorkspace();
  t.after(() => ws.stop());

  const owner = await registerUser(ws, 'ada');
  const serverId = await createCommunity(ws, owner, 'Documents');
  const member = await addMember(ws, owner, serverId, 'bob');

  const create = async (title, text) => {
    const res = await owner.post(`/api/servers/${serverId}/documents`, {
      title,
      body: [{ type: 'paragraph', text }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return res.data;
  };

  await t.test('a save appends a revision', async () => {
    const doc = await create('Notes', 'First.');
    assert.equal(doc.revision, 1);

    const saved = await owner.put(`/api/servers/${serverId}/documents/${doc.id}`, {
      title: 'Notes',
      body: [{ type: 'paragraph', text: 'Second.' }],
      revision: 1,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.revision, 2);
    assert.equal(saved.data.body[0].text, 'Second.');

    const history = await owner.get(`/api/servers/${serverId}/documents/${doc.id}/revisions`);
    assert.equal(history.status, 200);
    assert.equal(history.data.length, 2, 'the history holds the first revision and the save');
    assert.equal(history.data[0].revision, 2, 'the newest revision is first');
  });

  await t.test('a save written against an older revision is refused, not applied', async () => {
    const doc = await create('Plan', 'One.');
    const first = await owner.put(`/api/servers/${serverId}/documents/${doc.id}`, {
      body: [{ type: 'paragraph', text: 'Two.' }],
      revision: 1,
    });
    assert.equal(first.status, 200);

    // The same editor, still holding revision 1.
    const stale = await owner.put(`/api/servers/${serverId}/documents/${doc.id}`, {
      body: [{ type: 'paragraph', text: 'Three.' }],
      revision: 1,
    });
    assert.equal(stale.status, 409, 'a stale save is refused');
    assert.equal(stale.data.error.code, 'CONFLICT');
    assert.equal(stale.data.error.details.currentRevision, 2, 'the answer says which revision is current');
    assert.equal(stale.data.error.details.submittedRevision, 1);

    const read = await owner.get(`/api/servers/${serverId}/documents/${doc.id}`);
    assert.equal(read.data.revision, 2, 'the refused save did not land');
    assert.equal(read.data.body[0].text, 'Two.', 'the newer work is still there');

    // Overwriting is a deliberate choice, and it is still a revision.
    const forced = await owner.put(`/api/servers/${serverId}/documents/${doc.id}`, {
      body: [{ type: 'paragraph', text: 'Three.' }],
      revision: 1,
      overwrite: true,
    });
    assert.equal(forced.status, 200, JSON.stringify(forced.data));
    assert.equal(forced.data.revision, 3);
    assert.equal(forced.data.body[0].text, 'Three.');
  });

  await t.test('a restore brings back an earlier revision and keeps the history', async () => {
    const doc = await create('Notes', 'Original.');
    await owner.put(`/api/servers/${serverId}/documents/${doc.id}`, {
      body: [{ type: 'paragraph', text: 'Changed.' }],
      revision: 1,
    });

    const restored = await owner.post(`/api/servers/${serverId}/documents/${doc.id}/restore`, { revision: 1 });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.equal(restored.data.revision, 3, 'a restore is a new revision, not a rewrite');
    assert.equal(restored.data.body[0].text, 'Original.');

    const history = await owner.get(`/api/servers/${serverId}/documents/${doc.id}/revisions`);
    assert.equal(history.data.length, 3, 'the revision that was restored is still in the history');
  });

  await t.test('two revisions can be compared', async () => {
    const doc = await create('Compare me', 'One.');
    await owner.put(`/api/servers/${serverId}/documents/${doc.id}`, {
      body: [
        { type: 'paragraph', text: 'One.' },
        { type: 'paragraph', text: 'Two.' },
      ],
      revision: 1,
    });
    const compared = await owner.get(
      `/api/servers/${serverId}/documents/${doc.id}/compare?from=1&to=2`
    );
    assert.equal(compared.status, 200, JSON.stringify(compared.data));
    assert.equal(compared.data.changes.length, 1, 'one block was added');
    assert.equal(compared.data.changes[0].change, 'added');
    assert.equal(compared.data.changes[0].after.text, 'Two.');
  });

  await t.test('a comment is recorded against a block', async () => {
    const doc = await create('Commented', 'Text.');
    const comment = await owner.post(`/api/servers/${serverId}/documents/${doc.id}/comments`, {
      body: 'Is this the right wording?',
      blockId: 'block-1',
    });
    assert.equal(comment.status, 201, JSON.stringify(comment.data));
    assert.equal(comment.data.body, 'Is this the right wording?');
    assert.equal(comment.data.blockId, 'block-1');

    const comments = await owner.get(`/api/servers/${serverId}/documents/${doc.id}/comments`);
    assert.equal(comments.status, 200);
    assert.equal(comments.data.length, 1);
    assert.equal(comments.data[0].id, comment.data.id);
  });

  await t.test('a document is findable by its words', async () => {
    await create('Searchable', 'The quarterly report is ready.');
    const found = await owner.get(`/api/servers/${serverId}/documents/search?q=quarterly`);
    assert.equal(found.status, 200, JSON.stringify(found.data));
    assert.ok(found.data.length >= 1);
    assert.ok(found.data.some((d) => d.title === 'Searchable'));
  });

  await t.test('a document can link to another document and to a link', async () => {
    const first = await create('First', 'Text.');
    const second = await create('Second', 'Text.');

    const toDocument = await owner.post(`/api/servers/${serverId}/documents/${first.id}/links`, {
      kind: 'document',
      targetId: second.id,
    });
    assert.equal(toDocument.status, 201, JSON.stringify(toDocument.data));
    assert.equal(toDocument.data.targetId, second.id);

    const toUrl = await owner.post(`/api/servers/${serverId}/documents/${first.id}/links`, {
      kind: 'url',
      url: 'https://example.org/handbook',
      label: 'Handbook',
    });
    assert.equal(toUrl.status, 201, JSON.stringify(toUrl.data));

    const links = await owner.get(`/api/servers/${serverId}/documents/${first.id}/links`);
    assert.equal(links.data.length, 2);

    // A link that is not a link is refused.
    const bad = await owner.post(`/api/servers/${serverId}/documents/${first.id}/links`, {
      kind: 'url',
      url: 'javascript:alert(1)',
    });
    assert.equal(bad.status, 400);
  });

  await t.test('a comment can be resolved by its author', async () => {
    const doc = await create('Resolved', 'Text.');
    const comment = await owner.post(`/api/servers/${serverId}/documents/${doc.id}/comments`, {
      body: 'Fixed already.',
    });
    const resolved = await owner.post(
      `/api/servers/${serverId}/documents/${doc.id}/comments/${comment.data.id}/resolve`,
      {}
    );
    assert.equal(resolved.status, 200, JSON.stringify(resolved.data));
    assert.ok(resolved.data.resolvedAt, 'the comment says when it was resolved');
    assert.equal(resolved.data.resolvedBy, owner.user.id);
  });

  await t.test('writing needs the permission the community grants', async () => {
    const doc = await create('Guarded', 'Text.');
    const refused = await member.put(`/api/servers/${serverId}/documents/${doc.id}`, {
      body: [{ type: 'paragraph', text: 'Edited.' }],
      revision: 1,
    });
    assert.equal(refused.status, 403, 'a member without the permission cannot write');
    assert.equal(refused.data.error.code, 'PERMISSION_DENIED');

    // The member can read it, though: reading is membership.
    const read = await member.get(`/api/servers/${serverId}/documents/${doc.id}`);
    assert.equal(read.status, 200);

    const role = await createRole(owner, serverId, 'Writers', ['MEMORIZE']);
    await assignRole(owner, serverId, role.id, member.user.id);
    const allowed = await member.put(`/api/servers/${serverId}/documents/${doc.id}`, {
      body: [{ type: 'paragraph', text: 'Edited.' }],
      revision: 1,
    });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
    assert.equal(allowed.data.revision, 2);
  });

  await t.test('a member of another community is refused', async () => {
    const outsider = await registerUser(ws, 'mallory');
    const list = await outsider.get(`/api/servers/${serverId}/documents`);
    assert.equal(list.status, 403);
    assert.equal(list.data.error.code, 'NOT_A_MEMBER');

    const read = await outsider.get(`/api/servers/${serverId}/documents/anything`);
    assert.equal(read.status, 403);
  });
});

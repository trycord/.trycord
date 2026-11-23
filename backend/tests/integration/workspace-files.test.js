// The workspace's file store, end to end.
//
// A file the workspace keeps is a different thing from a file a message
// carries: it is owned by the community outright, not pending until some
// message adopts it. The checks that follow are the ones that matter for
// that difference - the bytes come back exactly as they went up, a non-member
// is refused on the read as well as the write, and a removal takes the row
// and the object both.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser } = require('../helpers/instance');

const BODY = 'the community keeps this';

test('the workspace stores, serves and removes a file', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const stranger = await registerUser(instance, 'stranger');

  const made = await owner.post('/api/servers', { name: 'The archive' });
  const serverId = made.data.serverId;

  await t.test('a member uploads, and the row answers with what was stored', async () => {
    const up = await owner.post('/api/servers/' + serverId + '/files',
      formData(BODY, 'notes.txt', 'text/plain'));
    assert.equal(up.status, 201, JSON.stringify(up.data));
    assert.equal(up.data.name, 'notes.txt');
    assert.equal(up.data.mime, 'text/plain');
    assert.equal(up.data.size, BODY.length);
    assert.ok(up.data.id, 'the upload answers with an id');
  });

  let fileId = null;
  await t.test('the bytes come back through the download route, unharmed', async () => {
    const up = await owner.post('/api/servers/' + serverId + '/files',
      formData(BODY, 'notes.txt', 'text/plain'));
    fileId = up.data.id;

    const dl = await owner.get('/api/servers/' + serverId + '/files/' + fileId + '/download');
    assert.equal(dl.status, 200, JSON.stringify(dl.data));
    assert.equal(String(dl.data), BODY, 'the file comes back exactly as it went up');
  });

  await t.test('a non-member is refused on the write and the read alike', async () => {
    const strangerUp = await stranger.post('/api/servers/' + serverId + '/files',
      formData(BODY, 'sneaky.txt', 'text/plain'));
    assert.ok(strangerUp.status >= 400, 'a non-member cannot store a file');

    const strangerDl = await stranger.get('/api/servers/' + serverId + '/files/' + fileId + '/download');
    assert.ok(strangerDl.status >= 400, 'a non-member cannot read a file');

    const strangerList = await stranger.get('/api/servers/' + serverId + '/files');
    assert.ok(strangerList.status >= 400, 'a non-member cannot list the store');
  });

  await t.test('a removal takes the row, and the list is honest about it', async () => {
    const del = await owner.delete('/api/servers/' + serverId + '/files/' + fileId);
    assert.equal(del.status, 200, JSON.stringify(del.data));

    const after = await owner.get('/api/servers/' + serverId + '/files');
    assert.equal(after.status, 200);
    assert.ok(!after.data.some((f) => f.id === fileId), 'the removed file is not on the list');

    const gone = await owner.get('/api/servers/' + serverId + '/files/' + fileId + '/download');
    assert.equal(gone.status, 404, 'the removed file does not serve');
  });
});

function formData(content, name, type) {
  const fd = new FormData();
  fd.append('file', new Blob([content], { type }), name);
  return fd;
}

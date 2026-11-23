// Reports on the files a message carries.
//
// A picture travels with the words but is not the words: the report names the
// attachment itself, and the frozen snapshot a moderator reads carries the
// file and its author. The checks that follow are the ones that matter for
// that difference - the snapshot lands with the file named, a member of the
// conversation may report a picture in it, a stranger may not, and a file
// nobody adopted is not a report at all.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser } = require('../helpers/instance');

const PIXEL = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000d49444154789c63f8cfc0f01f0005050201cdb0446d0000000049454e44ae426082',
  'hex',
);

test('reports on message attachments', async (t) => {
  const instance = await startInstance({ env: { ADMIN_USERNAMES: 'admin' } });
  t.after(() => instance.stop());

  const ada = await registerUser(instance, 'ada');
  const grace = await registerUser(instance, 'grace');
  const stranger = await registerUser(instance, 'stranger');
  const admin = await registerUser(instance, 'admin');

  // A community with one channel, and a conversation between two people.
  const made = await ada.post('/api/servers', { name: 'The gallery' });
  const serverId = made.data.serverId;
  const tree = await ada.get('/api/servers/' + serverId + '/channels');
  const base = tree.data && tree.data.channels ? tree.data.channels : tree.data;
  const channelId = base[0].id;

  const opened = await ada.post('/api/dms', { userId: grace.user.id });
  const conversationId = opened.data.id;

  // Grace sees the channel picture because she is in the community: an
  // invitation brings her in before the reports begin.
  const inv = await ada.post('/api/servers/' + serverId + '/invites', { maxUses: 5 });
  const joined = await grace.post('/api/invites/' + inv.data.code + '/join', {});
  assert.equal(joined.status, 200, JSON.stringify(joined.data));

  // A picture into the channel: uploaded pending, then adopted by a message.
  // The upload answers with the row it stored, under `attachment`.
  const channelUp = await ada.post('/api/channels/' + channelId + '/attachments',
    formData(PIXEL, 'pattern.png', 'image/png'));
  assert.ok(channelUp.status < 400, JSON.stringify(channelUp.data));
  const channelAttachmentId = channelUp.data.attachment
    ? channelUp.data.attachment.id : channelUp.data.id;
  const channelMessage = await ada.post('/api/channels/' + channelId + '/messages',
    { content: 'The picture in the channel', attachmentIds: [channelAttachmentId] });
  assert.ok(channelMessage.status < 400, JSON.stringify(channelMessage.data));

  // A picture into the conversation, adopted the same way.
  const dmUp = await ada.post('/api/dms/' + conversationId + '/attachments',
    formData(PIXEL, 'quiet.png', 'image/png'));
  assert.ok(dmUp.status < 400, JSON.stringify(dmUp.data));
  const dmAttachmentId = dmUp.data.attachment ? dmUp.data.attachment.id : dmUp.data.id;
  const dmMessage = await ada.post('/api/dms/' + conversationId + '/messages',
    { content: 'The picture in the conversation', attachmentIds: [dmAttachmentId] });
  assert.ok(dmMessage.status < 400, JSON.stringify(dmMessage.data));

  await t.test('a member reports a picture in a community channel', async () => {
    const res = await grace.post('/api/reports', {
      targetType: 'attachment', targetId: channelAttachmentId,
      serverId, reason: 'spam', description: 'The same picture posted over and over.',
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.ok(res.data.caseId, 'the report landed in a case');
    const mine = await grace.get('/api/reports/mine');
    const row = (mine.data || []).find((r) => r.targetType === 'attachment');
    assert.ok(row, 'the report is on the reporter\'s own list');
  });

  await t.test('the frozen snapshot names the file and its author', async () => {
    const queue = await admin.get('/api/admin/reports');
    assert.equal(queue.status, 200, JSON.stringify(queue.data));
    const report = (queue.data || []).find((r) => r.targetId === channelAttachmentId
      || r.target_id === channelAttachmentId);
    assert.ok(report, 'the report is in the queue');
    const openedCase = await admin.get('/api/admin/cases/' + report.caseId);
    assert.equal(openedCase.status, 200, JSON.stringify(openedCase.data));
    const snapshot = openedCase.data.subject && openedCase.data.subject.snapshot;
    assert.ok(snapshot, 'the case froze a snapshot');
    assert.equal(snapshot.filename, 'pattern.png');
    assert.equal(snapshot.mime, 'image/png');
    assert.equal(String(snapshot.message_author_id), String(ada.user.id),
      'the snapshot names the person who posted it');
  });

  await t.test('a member of the conversation reports a picture in it', async () => {
    const res = await grace.post('/api/reports', {
      targetType: 'attachment', targetId: dmAttachmentId,
      reason: 'harassment', description: 'This picture was sent to harass me.',
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
  });

  await t.test('a stranger is refused a picture they could not have seen', async () => {
    const channel = await stranger.post('/api/reports', {
      targetType: 'attachment', targetId: channelAttachmentId,
      reason: 'spam', description: 'I am not in this community.',
    });
    assert.ok(channel.status >= 400, 'a stranger cannot report a community picture: '
      + JSON.stringify(channel.data));

    const dm = await stranger.post('/api/reports', {
      targetType: 'attachment', targetId: dmAttachmentId,
      reason: 'spam', description: 'I am not in this conversation.',
    });
    assert.ok(dm.status >= 400, 'a stranger cannot report a conversation picture: '
      + JSON.stringify(dm.data));
  });

  await t.test('a file nobody adopted is not a report at all', async () => {
    const up = await ada.post('/api/channels/' + channelId + '/attachments',
      formData(PIXEL, 'unadopted.png', 'image/png'));
    const unadoptedId = up.data.attachment ? up.data.attachment.id : up.data.id;
    const res = await ada.post('/api/reports', {
      targetType: 'attachment', targetId: unadoptedId,
      serverId, reason: 'spam', description: 'Nothing points at this yet.',
    });
    assert.ok(res.status >= 400, JSON.stringify(res.data));
  });

  await t.test('an attachment id that is nobody\'s is not found', async () => {
    const res = await ada.post('/api/reports', {
      targetType: 'attachment', targetId: 'no-such-attachment',
      reason: 'spam', description: 'Not a file.',
    });
    assert.ok(res.status >= 400, JSON.stringify(res.data));
  });
});

function formData(content, name, type) {
  const fd = new FormData();
  fd.append('file', new Blob([content], { type }), name);
  return fd;
}

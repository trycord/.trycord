// The moderation journey, end to end.
//
// A report is not a row in a queue that disappears into a second system. It
// becomes a case, the case is linked to the action, the action can be
// appealed, and the decision appears in the audit hash chain and in the
// member's notifications. Community scope is tested from the other side: an
// id that belongs to another community must be not found, not a shortcut.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startInstance, registerUser } = require('../helpers/instance');

async function createCommunity(owner, name) {
  const res = await owner.post('/api/servers', { name, description: name + ' for moderation tests' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}

async function invite(owner, communityId, user) {
  const inv = await owner.post('/api/servers/' + communityId + '/invites', { maxUses: 5 });
  assert.equal(inv.status, 200, JSON.stringify(inv.data));
  const joined = await user.post('/api/invites/' + inv.data.code + '/join', {});
  assert.equal(joined.status, 200, JSON.stringify(joined.data));
}

test('report, case, action, appeal, audit and notification agree', async (t) => {
  const instance = await startInstance({ env: { ADMIN_USERNAMES: 'admin' } });
  t.after(() => instance.stop());

  const admin = await registerUser(instance, 'admin');
  const owner = await registerUser(instance, 'owner');
  const member = await registerUser(instance, 'member');
  const reporter = await registerUser(instance, 'reporter');
  const otherOwner = await registerUser(instance, 'otherowner');

  const community = await createCommunity(owner, 'Moderation Lab');
  const other = await createCommunity(otherOwner, 'Other Lab');
  await invite(owner, community.serverId, member);
  await invite(owner, community.serverId, reporter);

  let reportId = null;
  let reportCaseId = null;
  let banActionId = null;

  await t.test('a report freezes its evidence and opens a case', async () => {
    const res = await reporter.post('/api/reports', {
      targetType: 'user',
      targetId: member.user.id,
      serverId: community.serverId,
      reason: 'Harassment',
      category: 'HARASSMENT',
      severity: 'HIGH',
      description: 'The messages in the lab were directed at me.',
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    reportId = res.data.id;
    reportCaseId = res.data.caseId;
    assert.ok(reportId && reportCaseId);

    const mine = await reporter.get('/api/reports/mine');
    assert.equal(mine.status, 200, JSON.stringify(mine.data));
    assert.ok(mine.data.some((r) => r.id === reportId));

    const detail = await admin.get('/api/admin/reports/' + reportId);
    assert.equal(detail.status, 200, JSON.stringify(detail.data));
    assert.equal(detail.data.caseId, reportCaseId);
    assert.equal(detail.data.targetType, 'user');
    assert.equal(detail.data.targetSnapshot.username, 'member');
    assert.ok(detail.data.case, 'the report detail carries its case');
    assert.ok(detail.data.case.events.some((e) => e.kind === 'REPORT_FILED'));
    assert.ok(detail.data.case.evidence.some((e) => e.kind === 'TARGET_SNAPSHOT'));
  });

  await t.test('another community cannot read the report or its case', async () => {
    const crossReport = await otherOwner.get(
      '/api/servers/' + other.serverId + '/moderation/reports/' + reportId
    );
    assert.equal(crossReport.status, 404, JSON.stringify(crossReport.data));
    const crossCase = await otherOwner.get(
      '/api/servers/' + other.serverId + '/moderation/cases/' + reportCaseId
    );
    assert.equal(crossCase.status, 404, JSON.stringify(crossCase.data));
    const outsider = await member.get('/api/servers/' + community.serverId + '/moderation/reports');
    assert.equal(outsider.status, 403, JSON.stringify(outsider.data));
  });

  await t.test('a community action requires a reason and resolves the report through its case', async () => {
    const noReason = await owner.post('/api/servers/' + community.serverId + '/ban', {
      userId: member.user.id,
    });
    assert.equal(noReason.status, 400, 'a community ban without a reason was accepted');

    const banned = await owner.post('/api/servers/' + community.serverId + '/ban', {
      userId: member.user.id,
      reason: 'Harassment confirmed by the moderation record',
      reportId,
    });
    assert.equal(banned.status, 200, JSON.stringify(banned.data));
    banActionId = banned.data.actionId || banned.data.id;
    assert.ok(banActionId);
    assert.equal(banned.data.caseId, reportCaseId, 'the action joined the report case');

    const queue = await owner.get('/api/servers/' + community.serverId + '/moderation/reports');
    assert.equal(queue.status, 200, JSON.stringify(queue.data));
    const resolved = queue.data.find((r) => r.id === reportId);
    assert.equal(resolved.status, 'RESOLVED');

    const caseDetail = await owner.get(
      '/api/servers/' + community.serverId + '/moderation/cases/' + reportCaseId
    );
    assert.equal(caseDetail.status, 200, JSON.stringify(caseDetail.data));
    assert.ok(caseDetail.data.actions.some((a) => a.id === banActionId));
    assert.equal(caseDetail.data.status, 'RESOLVED');
    assert.ok(caseDetail.data.events.some((e) => e.kind === 'COMMUNITY_BAN'));
  });

  await t.test('the member sees the decision and appeals it without knowing an id', async () => {
    const notifications = await member.get('/api/notifications');
    assert.equal(notifications.status, 200, JSON.stringify(notifications.data));
    const notice = notifications.data.items.find((n) => n.type === 'community_moderation');
    assert.ok(notice, 'the banned member was not told');
    assert.ok(notice.detail && /community/i.test(notice.detail));
    assert.ok(!/harassment confirmed/i.test(notice.detail), 'the public notice leaked the reason');

    const eligible = await member.get('/api/appeals/eligible');
    assert.equal(eligible.status, 200, JSON.stringify(eligible.data));
    const item = eligible.data.find((e) => e.actionId === banActionId);
    assert.ok(item, 'the live community ban is not appealable');
    assert.equal(item.serverId, community.serverId);

    const submitted = await member.post('/api/appeals', {
      actionId: banActionId,
      reason: 'I did not send those messages and the context is missing.',
    });
    assert.equal(submitted.status, 201, JSON.stringify(submitted.data));

    const duplicate = await member.post('/api/appeals', {
      actionId: banActionId,
      reason: 'A second appeal',
    });
    assert.equal(duplicate.status, 409, 'a second pending appeal was accepted');

    const mine = await member.get('/api/appeals/mine');
    assert.equal(mine.status, 200, JSON.stringify(mine.data));
    const appeal = mine.data.find((a) => a.actionId === banActionId);
    assert.ok(appeal);
    assert.equal(appeal.status, 'OPEN');
  });

  await t.test('the community decides the appeal and the ban is lifted once', async () => {
    const queue = await owner.get('/api/servers/' + community.serverId + '/moderation/appeals');
    assert.equal(queue.status, 200, JSON.stringify(queue.data));
    const appeal = queue.data.find((a) => a.actionId === banActionId);
    assert.ok(appeal, 'the community appeal queue lost the appeal');

    const noNote = await owner.patch(
      '/api/servers/' + community.serverId + '/moderation/appeals/' + appeal.id,
      { decision: 'DENIED' }
    );
    assert.equal(noNote.status, 400, 'a denial without an explanation was accepted');

    const approved = await owner.patch(
      '/api/servers/' + community.serverId + '/moderation/appeals/' + appeal.id,
      { decision: 'APPROVED', note: 'The record does not support the ban.' }
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.equal(approved.data.status, 'APPROVED');

    const bans = await owner.get('/api/servers/' + community.serverId + '/bans');
    assert.equal(bans.status, 200, JSON.stringify(bans.data));
    assert.ok(!(bans.data || []).some((b) => (b.userId || b.user_id) === member.user.id),
      'the lifted ban is still live');

    const again = await member.post('/api/appeals', {
      actionId: banActionId,
      reason: 'Please review again.',
    });
    assert.equal(again.status, 400, 'a decided action can be appealed again');

    const decisionNotices = await member.get('/api/notifications');
    assert.ok(decisionNotices.data.items.some((n) => n.type === 'appeal_update'
      && /approved/i.test(String(n.detail || ''))));
  });

  await t.test('the platform warning follows the same appeal path, with a case and a notification', async () => {
    const warned = await admin.post('/api/admin/users/' + member.user.id + '/warn', {
      reason: 'A platform warning for the same conduct',
      expiresInDays: 7,
    });
    assert.equal(warned.status, 201, JSON.stringify(warned.data));
    const actionId = warned.data.id;
    assert.ok(warned.data.caseId);

    const detail = await admin.get('/api/admin/users/' + member.user.id);
    assert.equal(detail.status, 200, JSON.stringify(detail.data));
    assert.ok(detail.data.cases.some((c) => c.id === warned.data.caseId));
    assert.ok(detail.data.notes !== undefined);

    const eligible = await member.get('/api/appeals/eligible');
    const item = eligible.data.find((e) => e.actionId === actionId);
    assert.ok(item, 'the platform warning is not appealable');

    const appeal = await member.post('/api/appeals', {
      actionId,
      reason: 'The warning is based on a mistaken identity.',
    });
    assert.equal(appeal.status, 201, JSON.stringify(appeal.data));

    const platformQueue = await admin.get('/api/admin/appeals');
    assert.equal(platformQueue.status, 200, JSON.stringify(platformQueue.data));
    const found = platformQueue.data.find((a) => a.actionId === actionId);
    assert.ok(found, 'the platform appeal queue did not receive the appeal');

    const approved = await admin.patch('/api/admin/appeals/' + found.id, {
      decision: 'APPROVED',
      note: 'The account was confused with another member.',
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.equal(approved.data.status, 'APPROVED');
  });

  await t.test('a restricted account cannot use the restricted feature', async () => {
    const restricted = await admin.post('/api/admin/users/' + reporter.user.id + '/restrict', {
      restrictionType: 'SEND_MESSAGES',
      reason: 'Spam during the investigation',
      expiresInHours: 1,
    });
    assert.equal(restricted.status, 201, JSON.stringify(restricted.data));
    const channel = community.channelId;
    const send = await reporter.post('/api/channels/' + channel + '/messages', {
      content: 'This should be refused.',
    });
    assert.equal(send.status, 403, JSON.stringify(send.data));
    assert.equal(send.data.error.code, 'FEATURE_RESTRICTED');

    const detail = await admin.get('/api/admin/users/' + reporter.user.id);
    const restriction = detail.data.activeRestrictions.find((r) => r.kind === 'SEND_MESSAGES');
    assert.ok(restriction);
    const lifted = await admin.post(
      '/api/admin/users/' + reporter.user.id + '/restrictions/' + restriction.id + '/lift',
      { reason: 'The restriction served its purpose.' }
    );
    assert.equal(lifted.status, 200, JSON.stringify(lifted.data));
  });

  await t.test('a suspended community is inaccessible to members and restorable by the platform', async () => {
    const suspended = await admin.post('/api/admin/servers/' + community.serverId + '/suspend', {
      reason: 'A temporary pause while the report is investigated',
      expiresInHours: 24,
    });
    assert.equal(suspended.status, 200, JSON.stringify(suspended.data));

    const reach = await member.get('/api/servers/' + community.serverId + '/channels');
    assert.equal(reach.status, 403, JSON.stringify(reach.data));
    assert.equal(reach.data.error.code, 'SERVER_SUSPENDED');

    const looked = await admin.get('/api/admin/servers/' + community.serverId);
    assert.equal(looked.status, 200, JSON.stringify(looked.data));
    assert.equal(looked.data.enforcement.state, 'suspended');

    const restored = await admin.post('/api/admin/servers/' + community.serverId + '/lift', {
      reason: 'The pause is no longer needed.',
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    const reachable = await member.get('/api/servers/' + community.serverId + '/channels');
    assert.equal(reachable.status, 200, JSON.stringify(reachable.data));
  });

  await t.test('the audit chain verifies and names the case and actor', async () => {
    const verify = await admin.get('/api/admin/audit/verify');
    assert.equal(verify.status, 200, JSON.stringify(verify.data));
    assert.equal(verify.data.valid, true, JSON.stringify(verify.data));

    const audit = await admin.get('/api/admin/audit?caseId=' + reportCaseId);
    assert.equal(audit.status, 200, JSON.stringify(audit.data));
    assert.ok(audit.data.some((row) => row.action === 'REPORT_CREATED'));
    assert.ok(audit.data.some((row) => row.action === 'COMMUNITY_BAN'));
    assert.ok(audit.data.some((row) => row.action === 'APPEAL_APPROVED'));
  });

  await t.test('an expiry sweep moves the durable record and notifies the member', async () => {
    const warned = await admin.post('/api/admin/users/' + owner.user.id + '/warn', {
      reason: 'A warning that will expire during this test',
      expiresInDays: 1,
    });
    assert.equal(warned.status, 201, JSON.stringify(warned.data));
    const actionId = warned.data.id;

    await instance.db.run('UPDATE moderation_actions SET expires_at = ? WHERE id = ?', [
      new Date(Date.now() - 60000).toISOString(), actionId,
    ]);
    const expiry = require(path.join(__dirname, '..', '..', 'src', 'services', 'moderationExpiry'));
    const result = await expiry.sweep();
    assert.ok(result.warnings >= 1, JSON.stringify(result));

    const row = await instance.db.get('SELECT status FROM moderation_actions WHERE id = ?', [actionId]);
    assert.equal(row.status, 'EXPIRED');
    const notices = await owner.get('/api/notifications');
    assert.ok(notices.data.items.some((n) => n.type === 'moderation_lift'
      && /warning/i.test(String(n.detail || ''))));
  });
});

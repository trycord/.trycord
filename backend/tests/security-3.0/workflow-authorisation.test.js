// What a workflow may do to a community.
//
// A workflow acts as its owner, and its owner has no standing in a community
// they do not belong to. The action catalogue checked that for the actions
// that write - posting a message, reading a channel's history - but three
// actions did not check it, and one of them handed out authority:
//
//   member.role.add  gave a member any role in any community, without
//                     MANAGE_ROLES and without a bound on what the role
//                     carried. A workflow with `members.write` could make
//                     anybody an administrator of a community its owner was
//                     not even a member of.
//   member.count     read the size of a community its owner was not in.
//   webhook.notify   delivered an arbitrary event and an arbitrary payload to
//                     a community's outgoing webhooks - which are usually
//                     somebody else's endpoint.
//
// The rule the interactive role routes already apply is the rule here: the
// owner has to be allowed to administer roles, and may only hand out
// authority they hold themselves.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { start, community } = require('../extensions/support');
const { apiClient, registerUser } = require('../helpers/instance');

/** Create a workflow and give it the capability it needs. */
async function workflowWith(ext, owner, definition, capability) {
  const created = await owner.post('/api/extensions/workflows', definition);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const granted = await ext.admin.post(
    '/api/extensions/workflows/' + created.data.workflow.id + '/grants',
    { capability, reason: 'the operator agreed' }
  );
  assert.equal(granted.status, 200, JSON.stringify(granted.data));
  return created.data.workflow.id;
}

/** Run a workflow and answer with the error its step recorded. */
async function runAndFail(ext, owner, workflowId, expected) {
  const res = await owner.post('/api/extensions/workflows/' + workflowId + '/run', {});
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const detail = await owner.get('/api/extensions/workflows/runs/' + res.data.run.id);
  assert.equal(detail.data.steps[0].status, 'failed',
    'the step should have been refused: ' + JSON.stringify(detail.data.steps[0]));
  assert.match(detail.data.steps[0].error, expected);
}

/** Run a workflow and answer with its step. */
async function runAndSucceed(ext, owner, workflowId) {
  const res = await owner.post('/api/extensions/workflows/' + workflowId + '/run', {});
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const detail = await owner.get('/api/extensions/workflows/runs/' + res.data.run.id);
  assert.equal(detail.data.steps[0].status, 'succeeded',
    JSON.stringify(detail.data.steps[0]));
  return detail.data.steps[0];
}

test('a workflow may only act on a community its owner belongs to', async (t) => {
  const { instance, db, admin, member, stranger, ext, close } = await start();
  t.after(() => close());

  const home = await community(admin, 'Workflow community');
  const other = await registerUser(instance, 'other');
  const extOther = apiClient(ext.url, other.token);
  // A second member of the community, who is only ever the target of a grant.
  const target = await registerUser(instance, 'target');

  // A role that carries authority, and a role that administers roles.
  const power = await admin.post('/api/servers/' + home.serverId + '/roles', {
    name: 'Power', permissions: ['MANAGE_SERVER'],
  });
  assert.equal(power.status, 200, JSON.stringify(power.data));
  const moderator = await admin.post('/api/servers/' + home.serverId + '/roles', {
    name: 'Moderator', permissions: ['MANAGE_ROLES'],
  });
  assert.equal(moderator.status, 200, JSON.stringify(moderator.data));

  // The member and the other account join the community; the member is made
  // a moderator of it, the other account is left with the baseline role.
  for (const account of [member, other, target]) {
    const invite = await admin.post('/api/servers/' + home.serverId + '/invites', {});
    assert.ok(invite.ok, JSON.stringify(invite.data));
    const joined = await account.post('/api/invites/' + invite.data.code + '/join', {});
    assert.ok(joined.ok, JSON.stringify(joined.data));
  }
  const assigned = await admin.post(
    '/api/servers/' + home.serverId + '/roles/' + moderator.data.id + '/assign',
    { userId: member.user.id }
  );
  assert.equal(assigned.status, 200, JSON.stringify(assigned.data));

  await t.test('a moderator may hand out a role it holds', async () => {
    const workflowId = await workflowWith(ext, ext.member, {
      name: 'Promotes',
      trigger: { type: 'manual' },
      steps: [{
        type: 'action',
        action: 'member.role.add',
        params: {
          serverId: home.serverId,
          userId: target.user.id,
          roleId: moderator.data.id,
        },
      }],
      grants: ['members.write'],
    }, 'members.write');

    await runAndSucceed(ext, ext.member, workflowId);

    const held = await db.all(
      'SELECT 1 AS ok FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?',
      [home.serverId, target.user.id, moderator.data.id]
    );
    assert.equal(held.length, 1, 'the role should have been granted');
  });

  await t.test('a workflow cannot hand out a role its owner may not grant', async () => {
    const workflowId = await workflowWith(ext, ext.member, {
      name: 'Promotes to power',
      trigger: { type: 'manual' },
      steps: [{
        type: 'action',
        action: 'member.role.add',
        params: {
          serverId: home.serverId,
          userId: other.user.id,
          roleId: power.data.id,
        },
      }],
      grants: ['members.write'],
    }, 'members.write');

    await runAndFail(ext, ext.member, workflowId, /may not grant permissions they do not hold/);

    const held = await db.all(
      'SELECT 1 AS ok FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?',
      [home.serverId, other.user.id, power.data.id]
    );
    assert.equal(held.length, 0, 'the role must not have been granted');
  });

  await t.test('a member who may not administer roles may not hand one out', async () => {
    const workflowId = await workflowWith(ext, extOther, {
      name: 'Promotes without standing',
      trigger: { type: 'manual' },
      steps: [{
        type: 'action',
        action: 'member.role.add',
        params: {
          serverId: home.serverId,
          userId: member.user.id,
          roleId: moderator.data.id,
        },
      }],
      grants: ['members.write'],
    }, 'members.write');

    await runAndFail(ext, extOther, workflowId, /may not administer roles/);
  });

  await t.test('a workflow whose owner is not a member of the community is refused', async () => {
    const workflowId = await workflowWith(ext, ext.stranger, {
      name: 'Counts a community it does not belong to',
      trigger: { type: 'manual' },
      steps: [{
        type: 'action',
        action: 'member.count',
        params: { serverId: home.serverId },
      }],
      grants: ['members.read'],
    }, 'members.read');

    await runAndFail(ext, ext.stranger, workflowId, /not a member of that community/);
  });

  await t.test('a workflow may not notify the webhooks of a community it does not belong to', async () => {
    const workflowId = await workflowWith(ext, ext.stranger, {
      name: 'Notifies a webhook',
      trigger: { type: 'manual' },
      steps: [{
        type: 'action',
        action: 'webhook.notify',
        params: { serverId: home.serverId, eventType: 'message.created', payload: { hello: 'there' } },
      }],
      grants: ['webhooks.manage'],
    }, 'webhooks.manage');

    await runAndFail(ext, ext.stranger, workflowId, /not a member of that community/);
  });

  await t.test('the owner of the community may still use the action', async () => {
    const workflowId = await workflowWith(ext, ext.admin, {
      name: 'Promotes as the owner',
      trigger: { type: 'manual' },
      steps: [{
        type: 'action',
        action: 'member.role.add',
        params: {
          serverId: home.serverId,
          userId: other.user.id,
          roleId: power.data.id,
        },
      }],
      grants: ['members.write'],
    }, 'members.write');

    await runAndSucceed(ext, ext.admin, workflowId);
  });
});

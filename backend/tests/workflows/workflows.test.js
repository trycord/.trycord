// Workflows: what they do when they are triggered, what they refuse to do,
// and what they leave behind.
//
// The claims being measured: a trigger wakes the workflow and the action
// runs; a condition that does not hold stops it; a workflow that is woken by
// its own output stops; a retried trigger does not do the work twice; a dry
// run does nothing and says what it would have done; a failing action is
// recorded as a failure and the run does not claim success; and a workflow
// cannot do anything its grants do not cover.
//
// The tests that wake a workflow by a message live in instances of their
// own. Two workflows that answer the same event wake each other - that is
// what the hop budget is for - and a test that measures one workflow's
// output should not be measuring another one's at the same time.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { start, messagesIn, community } = require('../extensions/support');

test('a trigger wakes the workflow and the action runs', async (t) => {
  const { db, admin, ext, close } = await start();
  t.after(() => close());

  const home = await community(admin, 'Workflow community');

  await t.test('the run happens and is recorded', async () => {
    const created = await ext.admin.post('/api/extensions/workflows', {
      name: 'Answers a message',
      trigger: { type: 'event', event: 'message.created' },
      steps: [{
        type: 'action',
        action: 'message.post',
        params: { channelId: home.channelId, content: 'a message was posted' },
      }],
      grants: ['messages.write'],
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.deepEqual(created.data.workflow.grants, ['messages.write']);

    const res = await ext.admin.post('/api/extensions/events', {
      type: 'message.created',
      payload: { id: 'message-1', serverId: home.serverId, channelId: home.channelId },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.event, 'message.created');
    assert.equal(res.data.dispatched.length, 1);
    assert.equal(res.data.dispatched[0].status, 'succeeded');

    const posted = await messagesIn(db, home.channelId);
    assert.equal(posted.length, 1, 'the action should have posted a message');
    assert.equal(posted[0].content, 'a message was posted');

    const run = await ext.admin.get('/api/extensions/workflows/runs/' + res.data.dispatched[0].runId);
    assert.equal(run.status, 200);
    assert.equal(run.data.run.status, 'succeeded');
    assert.equal(run.data.run.triggerEvent, 'message.created');
    assert.equal(run.data.steps.length, 1);
    assert.equal(run.data.steps[0].status, 'succeeded');
    assert.equal(run.data.steps[0].capability, 'messages.write');
    assert.ok(run.data.run.durationMs !== null, 'the run should record how long it took');
  });

  await t.test('a condition that does not hold stops the action', async () => {
    const other = await community(admin, 'Conditional community');
    const created = await ext.admin.post('/api/extensions/workflows', {
      name: 'Only answers questions',
      trigger: { type: 'event', event: 'message.updated' },
      conditions: [{ field: 'content', op: 'contains', value: 'question' }],
      steps: [{
        type: 'action',
        action: 'message.post',
        params: { channelId: other.channelId, content: 'here is an answer' },
      }],
      grants: ['messages.write'],
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));

    const res = await ext.admin.post('/api/extensions/events', {
      type: 'message.updated',
      payload: { id: 'message-2', serverId: other.serverId, channelId: other.channelId, content: 'just a note' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.dispatched.find((d) => d.workflowId === created.data.workflow.id).status, 'skipped');
    assert.equal((await messagesIn(db, other.channelId)).length, 0, 'nothing should have been posted');

    const matched = await ext.admin.post('/api/extensions/events', {
      type: 'message.updated',
      payload: { id: 'message-3', serverId: other.serverId, channelId: other.channelId, content: 'is this a question?' },
    });
    assert.equal(matched.data.dispatched.find((d) => d.workflowId === created.data.workflow.id).status, 'succeeded');
    assert.equal((await messagesIn(db, other.channelId)).length, 1, 'the action should have run');
  });
});

test('a workflow woken by its own output stops', async (t) => {
  const { db, admin, ext, close } = await start();
  t.after(() => close());

  const loop = await community(admin, 'Loop community');
  const created = await ext.admin.post('/api/extensions/workflows', {
    name: 'Answers every message',
    trigger: { type: 'event', event: 'message.created' },
    steps: [{
      type: 'action',
      action: 'message.post',
      params: { channelId: loop.channelId, content: 'and another one' },
    }],
    grants: ['messages.write'],
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const workflowId = created.data.workflow.id;

  const res = await ext.admin.post('/api/extensions/events', {
    type: 'message.created',
    payload: { id: 'loop-1', serverId: loop.serverId, channelId: loop.channelId },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));

  // The message the workflow posted woke it again, and it did not run
  // again: exactly one message, not an endless conversation with itself.
  const posted = await messagesIn(db, loop.channelId);
  assert.equal(posted.length, 1, 'the workflow should have posted exactly one message');

  const runs = await ext.admin.get('/api/extensions/workflows/' + workflowId + '/runs');
  assert.equal(runs.status, 200);
  const skipped = runs.data.runs.filter((r) => r.status === 'skipped');
  assert.equal(skipped.length, 1, 'the self-trigger should have been recorded as skipped');
  assert.match(skipped[0].reason, /own output/);
});

test('a retried trigger does not do the work twice', async (t) => {
  const { db, admin, ext, close } = await start();
  t.after(() => close());

  const again = await community(admin, 'Idempotency community');
  const created = await ext.admin.post('/api/extensions/workflows', {
    name: 'Answers once',
    trigger: { type: 'event', event: 'message.created' },
    steps: [{
      type: 'action',
      action: 'message.post',
      params: { channelId: again.channelId, content: 'only once' },
    }],
    grants: ['messages.write'],
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));

  const payload = { id: 'same-event', serverId: again.serverId, channelId: again.channelId };
  const first = await ext.admin.post('/api/extensions/events', { type: 'message.created', payload });
  const second = await ext.admin.post('/api/extensions/events', { type: 'message.created', payload });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.data.dispatched[0].runId, second.data.dispatched[0].runId,
    'the retried event should resolve to the run that already happened');
  assert.equal((await messagesIn(db, again.channelId)).length, 1, 'the message should have been posted once');
});

test('what a workflow may do, and what it leaves behind', async (t) => {
  const { db, admin, member, ext, close } = await start();
  t.after(() => close());

  await t.test('a dry run does nothing and says what it would have done', async () => {
    const dry = await community(admin, 'Dry run community');
    const created = await ext.admin.post('/api/extensions/workflows', {
      name: 'Would answer',
      trigger: { type: 'manual' },
      steps: [{
        type: 'action',
        action: 'message.post',
        params: { channelId: dry.channelId, content: 'not really' },
      }],
      grants: ['messages.write'],
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));

    const res = await ext.admin.post('/api/extensions/workflows/' + created.data.workflow.id + '/dry-run', {});
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.run.dryRun, true);
    assert.equal(res.data.plan.length, 1);
    assert.equal(res.data.plan[0].action, 'message.post');
    assert.equal(res.data.plan[0].capability, 'messages.write');
    assert.ok(res.data.plan[0].description, 'the plan should say what the step does');

    assert.equal((await messagesIn(db, dry.channelId)).length, 0, 'a dry run must not post anything');
  });

  await t.test('a failing action is recorded as a failure, and the run does not claim success', async () => {
    const broken = await community(admin, 'Failing community');
    const created = await ext.admin.post('/api/extensions/workflows', {
      name: 'Posts nowhere',
      trigger: { type: 'manual' },
      steps: [{
        type: 'action',
        action: 'message.post',
        params: { channelId: 'no-such-channel', content: 'this cannot be posted' },
      }],
      grants: ['messages.write'],
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));

    const res = await ext.admin.post('/api/extensions/workflows/' + created.data.workflow.id + '/run', {});
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.run.status, 'failed');
    assert.ok(res.data.run.reason, 'the run should say why it failed');

    const detail = await ext.admin.get('/api/extensions/workflows/runs/' + res.data.run.id);
    const step = detail.data.steps[0];
    assert.equal(step.status, 'failed');
    assert.ok(step.error, 'the step should record the error');
    assert.equal((await messagesIn(db, broken.channelId)).length, 0);
  });

  await t.test('a workflow cannot do anything its grants do not cover', async () => {
    const home = await community(member, 'Member community');
    const created = await ext.member.post('/api/extensions/workflows', {
      name: 'Counts members',
      trigger: { type: 'manual' },
      steps: [{
        type: 'action',
        action: 'member.count',
        params: { serverId: home.serverId },
      }],
      grants: ['members.read'],
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.deepEqual(created.data.workflow.grants, [],
      'a member may not grant a workflow a capability they do not hold');
    assert.deepEqual(created.data.grants.refused.map((g) => g.capability), ['members.read']);
    assert.match(created.data.grants.refused[0].reason, /administrator/);

    const res = await ext.member.post('/api/extensions/workflows/' + created.data.workflow.id + '/run', {});
    assert.equal(res.status, 200);
    assert.equal(res.data.run.status, 'failed');
    const detail = await ext.member.get('/api/extensions/workflows/runs/' + res.data.run.id);
    assert.match(detail.data.steps[0].error, /has not been granted the capability "members.read"/);
  });

  await t.test('an administrator may grant a workflow a capability', async () => {
    const home = await community(member, 'Granted community');
    const created = await ext.member.post('/api/extensions/workflows', {
      name: 'Counts members once granted',
      trigger: { type: 'manual' },
      steps: [{
        type: 'action',
        action: 'member.count',
        params: { serverId: home.serverId },
      }],
      grants: ['members.read'],
    });
    assert.equal(created.status, 201);

    const granted = await ext.admin.post('/api/extensions/workflows/' + created.data.workflow.id + '/grants', {
      capability: 'members.read',
      reason: 'the operator agreed',
    });
    assert.equal(granted.status, 200, JSON.stringify(granted.data));
    assert.ok(granted.data.workflow.grants.includes('members.read'));

    const res = await ext.member.post('/api/extensions/workflows/' + created.data.workflow.id + '/run', {});
    assert.equal(res.status, 200);
    assert.equal(res.data.run.status, 'succeeded');
  });

  await t.test('a workflow belongs to the person who made it', async () => {
    const created = await ext.member.post('/api/extensions/workflows', {
      name: 'Mine',
      trigger: { type: 'manual' },
      steps: [{ type: 'action', action: 'log', params: { message: 'mine' } }],
      grants: [],
    });
    assert.equal(created.status, 201);

    const refused = await ext.stranger.post('/api/extensions/workflows/' + created.data.workflow.id + '/run', {});
    assert.equal(refused.status, 403, JSON.stringify(refused.data));
    assert.equal(refused.data.error.code, 'PERMISSION_DENIED');

    const byAdmin = await ext.admin.post('/api/extensions/workflows/' + created.data.workflow.id + '/run', {});
    assert.equal(byAdmin.status, 200, 'an administrator may run any workflow');
  });

  await t.test('a run waits for an approval before it carries on', async () => {
    const approved = await community(admin, 'Approval community');
    const created = await ext.admin.post('/api/extensions/workflows', {
      name: 'Asks first',
      trigger: { type: 'manual' },
      steps: [
        { type: 'approval', approvers: ['admin'], comment: 'may I?' },
        {
          type: 'action',
          action: 'message.post',
          params: { channelId: approved.channelId, content: 'approved and posted' },
        },
      ],
      grants: ['messages.write'],
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));

    const res = await ext.admin.post('/api/extensions/workflows/' + created.data.workflow.id + '/run', {});
    assert.equal(res.status, 200);
    assert.equal(res.data.run.status, 'awaiting_approval');
    assert.equal((await messagesIn(db, approved.channelId)).length, 0, 'nothing should have run yet');

    const decision = await ext.admin.post('/api/extensions/workflows/runs/' + res.data.run.id + '/approve', {
      approved: true,
      comment: 'go ahead',
    });
    assert.equal(decision.status, 200, JSON.stringify(decision.data));
    assert.equal(decision.data.status, 'succeeded');
    assert.equal((await messagesIn(db, approved.channelId)).length, 1, 'the rest of the run should have happened');
  });

  await t.test('the run history is readable', async () => {
    const list = await ext.admin.get('/api/extensions/workflows');
    assert.equal(list.status, 200);
    assert.ok(list.data.workflows.length > 0);

    const withRuns = list.data.workflows.find((w) => w.steps.length > 0);
    const runs = await ext.admin.get('/api/extensions/workflows/' + withRuns.id + '/runs');
    assert.equal(runs.status, 200);
    assert.ok(Array.isArray(runs.data.runs));
    assert.ok(runs.data.runs.length > 0);
  });
});

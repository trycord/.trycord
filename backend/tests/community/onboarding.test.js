// Community onboarding.
//
// A community that greets nobody is a community that loses people. The
// onboarding is what it says to somebody who has just arrived.
//
// The delicate part is the authority an answer carries. An answer may assign
// a role, and a role is authority, so:
//
//   - the picker only offers the roles an answer may actually give;
//   - an answer that would give a privileged role is refused, and the
//     refusal names the role and the reason;
//   - the check happens twice - when the question is written, and again when
//     the answer is recorded, because a role that was ordinary then may be
//     the owner's role now.
//
// And the rest of it has to work: the questions, the answers, the channels
// an answer reveals, and a member changing their mind later.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser } = require('../helpers/instance');

async function community(api, name) {
  const res = await api.post('/api/servers', {
    name: name || 'Onboarding community',
    description: 'A community that greets its members.',
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  if (process.env.ONBOARDING_VERBOSE) {
    console.error('the community id is', res.data.serverId, 'and the answer has',
      Object.keys(res.data).join(', '));
  }
  return res.data.serverId;
}

test('community onboarding', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const member = await registerUser(instance, 'member');
  const serverId = await community(owner);

  // A member of the community, so they may answer.
  const invite = await owner.post('/api/servers/' + serverId + '/invites', {});
  assert.equal(invite.status, 200, JSON.stringify(invite.data));
  const joined = await member.post('/api/invites/' + invite.data.code + '/join', {});
  assert.equal(joined.status, 200, JSON.stringify(joined.data));

  // An ordinary role, and a privileged one. A new community has only the
  // baseline role, so both are made here.
  const ordinary = (await owner.post('/api/servers/' + serverId + '/roles', {
    name: 'Regular', permissions: ['SEND_MESSAGES'],
  })).data;
  const moderator = (await owner.post('/api/servers/' + serverId + '/roles', {
    name: 'Moderator', permissions: ['SEND_MESSAGES', 'MANAGE_MESSAGES'],
  })).data;
  assert.ok(ordinary && ordinary.id, 'the ordinary role was not made');
  assert.ok(moderator && moderator.id, 'the moderating role was not made');

  await t.test('the onboarding does not shadow the other community routes', async () => {
    // The onboarding is mounted under /api/servers/:serverId/onboarding,
    // and a router mounted at /api/servers/:serverId would swallow
    // everything below it - including POST /api/servers/join, which is the
    // route a reader uses to arrive in the first place. It did, and the
    // answer was "server not found".
    const invite = await owner.post('/api/servers/' + serverId + '/invites', {});
    const arrived = await registerUser(instance, 'arriving');
    const joined = await arrived.post('/api/invites/' + invite.data.code + '/join', {});
    assert.equal(joined.status, 200,
      'the join route was swallowed by the onboarding mount: ' + JSON.stringify(joined.data));
  });

  await t.test('there is no onboarding until a community makes one', async () => {
    const res = await owner.get('/api/servers/' + serverId + '/onboarding');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.onboarding.enabled, false);
    assert.deepEqual(res.data.onboarding.questions, []);
  });

  await t.test('a community saves its welcome, its rules and its questions', async () => {
    const res = await owner.put('/api/servers/' + serverId + '/onboarding', {
      enabled: true,
      welcomeTitle: 'Welcome',
      welcomeBody: 'Tell us what you are here for.',
      rules: [
        { text: 'Be kind.' },
        { text: 'No spam.' },
      ],
      defaultChannels: [],
      required: true,
      questions: [
        {
          text: 'What brings you here?',
          kind: 'single',
          required: true,
          options: [
            { label: 'To chat', roleIds: [ordinary.id] },
            { label: 'To build things', roleIds: [ordinary.id], channelIds: [] },
          ],
        },
        {
          text: 'Which do you want to see?',
          kind: 'multiple',
          required: false,
          options: [
            { label: 'The announcements' },
            { label: 'The projects' },
          ],
        },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const config = res.data.onboarding;
    assert.equal(config.enabled, true);
    assert.equal(config.welcomeTitle, 'Welcome');
    assert.equal(config.rules.length, 2);
    assert.equal(config.questions.length, 2);
    assert.equal(config.questions[0].kind, 'single');
    assert.equal(config.questions[1].kind, 'multiple');
  });

  await t.test('a privileged role may not be offered by a question', async () => {
    const res = await owner.put('/api/servers/' + serverId + '/onboarding', {
      enabled: true,
      questions: [{
        text: 'What brings you here?',
        options: [{ label: 'To moderate', roleIds: [moderator.id] }],
      }],
    });
    assert.equal(res.status, 400,
      'a question offered a role that administers the community: ' + JSON.stringify(res.data));
    assert.match(String(res.data.error && res.data.error.message), /may not be given by an onboarding answer/);
  });

  await t.test('the picker offers only the roles an answer may give', async () => {
    const res = await owner.get('/api/servers/' + serverId + '/onboarding');
    assert.equal(res.status, 200);
    const offered = (res.data.eligibleRoles || []).map((role) => role.id);
    assert.ok(offered.includes(ordinary.id), 'the ordinary role is not offered');
    assert.ok(!offered.includes(moderator.id), 'the moderating role is offered');
  });

  await t.test('the member is shown the welcome, the rules and the questions', async () => {
    const res = await member.get('/api/servers/' + serverId + '/onboarding/preview');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const preview = res.data.onboarding;
    assert.equal(preview.enabled, true);
    assert.equal(preview.welcomeTitle, 'Welcome');
    assert.equal(preview.rules.length, 2);
    assert.equal(preview.questions.length, 2);
    assert.equal(preview.outstanding, 1, 'the required question is not outstanding');
    // The member is told what an answer would do, without being given it.
    const first = preview.questions[0];
    assert.equal(first.options[0].grantsRoles, 1, 'the member is not told what the answer gives');
  });

  await t.test('a required question has to be answered', async () => {
    const questions = (await owner.get('/api/servers/' + serverId + '/onboarding')).data.onboarding.questions;
    const requiredOne = questions.find((question) => question.required);
    const res = await member.post('/api/servers/' + serverId + '/onboarding/answers', {
      answers: [{ questionId: requiredOne.id, optionIds: [] }],
    });
    assert.equal(res.status, 400, 'a required question was left unanswered');
  });

  await t.test('an answer is recorded, and the role it gives is given', async () => {
    const questions = (await owner.get('/api/servers/' + serverId + '/onboarding')).data.onboarding.questions;
    const first = questions[0];
    const option = first.options[0];
    const res = await member.post('/api/servers/' + serverId + '/onboarding/answers', {
      answers: [{ questionId: first.id, optionIds: [option.id] }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.rolesGranted.length, 1, 'the role was not given');
    assert.equal(res.data.rolesGranted[0], ordinary.id);

    const held = await member.get('/api/servers/' + serverId + '/members');
    const rows = held.data.items || held.data.members || [];
    const row = rows.find((entry) => entry.id === member.user.id);
    assert.ok(row, 'the member is not in the list: ' + JSON.stringify(held.data).slice(0, 200));
    const memberRoles = row.roles || (row.roleIds || []);
    assert.ok(memberRoles.some((role) => (role.id || role) === ordinary.id),
      'the member does not hold the role the answer gave: ' + JSON.stringify(memberRoles));
  });

  await t.test('a member may change their mind later', async () => {
    const questions = (await owner.get('/api/servers/' + serverId + '/onboarding')).data.onboarding.questions;
    const first = questions[0];
    const other = first.options[1];
    const res = await member.post('/api/servers/' + serverId + '/onboarding/answers', {
      answers: [{ questionId: first.id, optionIds: [other.id] }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));

    const mine = await member.get('/api/servers/' + serverId + '/onboarding/me');
    assert.equal(mine.status, 200);
    const answer = mine.data.answers.find((entry) => entry.questionId === first.id);
    assert.deepEqual(answer.optionIds, [other.id], 'the answer was not replaced');
  });

  await t.test('a stranger may not answer', async () => {
    const stranger = await registerUser(instance, 'stranger');
    const res = await stranger.get('/api/servers/' + serverId + '/onboarding/preview');
    assert.equal(res.status, 403, 'a stranger read the onboarding: ' + JSON.stringify(res.data));
  });

  await t.test('a member who does not manage the community may not write it', async () => {
    const res = await member.put('/api/servers/' + serverId + '/onboarding', {
      enabled: true,
    });
    assert.equal(res.status, 403, 'a member wrote the onboarding: ' + JSON.stringify(res.data));
  });

  await t.test('an answer that is not one of the options is refused', async () => {
    const questions = (await owner.get('/api/servers/' + serverId + '/onboarding')).data.onboarding.questions;
    const res = await member.post('/api/servers/' + serverId + '/onboarding/answers', {
      answers: [{ questionId: questions[0].id, optionIds: ['not-an-option'] }],
    });
    assert.equal(res.status, 400, 'an answer named an option that does not exist');
  });

  await t.test('a single-answer question takes one answer', async () => {
    const questions = (await owner.get('/api/servers/' + serverId + '/onboarding')).data.onboarding.questions;
    const first = questions.find((question) => question.kind === 'single');
    const res = await member.post('/api/servers/' + serverId + '/onboarding/answers', {
      answers: [{
        questionId: first.id,
        optionIds: first.options.map((option) => option.id),
      }],
    });
    assert.equal(res.status, 400, 'a single-answer question took two answers');
  });
});

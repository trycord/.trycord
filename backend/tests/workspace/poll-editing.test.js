// Editing a poll.
//
// The poll editor had a line in it that named a variable that was not in
// scope - the title said "Edit the poll" against a `poll` that did not
// exist - and every click on "New poll" threw a ReferenceError before the
// dialog was ever shown. The line was left over from a planned edit path,
// and the edit path was never finished.
//
// So the edit path is finished: the service has had an update all along
// without a caller and without a permission check, and the client can now
// reach it.
//
// The rules the server enforces, and the checks here:
//   - the author or a moderator may edit; nobody else may;
//   - a closed poll is not edited, because its result is on record;
//   - a poll that has answers is not edited, because the ballots were given
//     for the options as they stand;
//   - the fields the body does not carry are left as they are.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startWorkspace, createCommunity, addMember, registerUser,
} = require('./helpers');

test('editing a poll', async (t) => {
  const ws = await startWorkspace();
  t.after(() => ws.stop());

  const owner = await registerUser(ws, 'ada');
  const serverId = await createCommunity(ws, owner, 'Polls');
  const member = await addMember(ws, owner, serverId, 'bob');

  const make = async (question, options) => {
    const res = await owner.post(`/api/servers/${serverId}/polls`, { question, options });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return res.data;
  };

  await t.test('the author may edit a poll nobody has answered', async () => {
    const made = await make('What shall we build next?', ['This', 'That']);
    const res = await owner.patch(`/api/servers/${serverId}/polls/${made.id}`, {
      question: 'What shall we build next, exactly?',
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.question, 'What shall we build next, exactly?');
    // The fields the body did not carry are left as they are.
    assert.equal(res.data.options.length, 2);
    assert.equal(res.data.options[0].label, 'This');
  });

  await t.test('a member who is neither the author nor a moderator may not', async () => {
    const made = await make('A question for the others', ['Yes', 'No']);
    const res = await member.patch(`/api/servers/${serverId}/polls/${made.id}`, {
      question: 'A question somebody else wrote',
    });
    assert.equal(res.status, 403, 'a member edited a poll they do not own: '
      + JSON.stringify(res.data));
    assert.match(String(res.data.error && res.data.error.message), /author or a moderator/i);
  });

  await t.test('the poll is not changed by the refusal', async () => {
    const made = await make('A question for the others', ['Yes', 'No']);
    await member.patch(`/api/servers/${serverId}/polls/${made.id}`, {
      question: 'A question somebody else wrote',
    });
    const after = await owner.get(`/api/servers/${serverId}/polls/${made.id}`);
    assert.equal(after.data.question, 'A question for the others',
      'the poll was changed by a reader who was refused');
  });

  await t.test('a poll that has answers is not edited', async () => {
    const made = await make('A question with answers', ['Yes', 'No']);
    const voted = await member.post(`/api/servers/${serverId}/polls/${made.id}/vote`, {
      choices: [made.options[0].id],
    });
    assert.equal(voted.status, 200, JSON.stringify(voted.data));
    const res = await owner.patch(`/api/servers/${serverId}/polls/${made.id}`, {
      question: 'A different question',
    });
    assert.equal(res.status, 409, 'a poll with answers was edited: ' + JSON.stringify(res.data));
    assert.match(String(res.data.error && res.data.error.message), /answers/i);
  });

  await t.test('a closed poll is not edited', async () => {
    const made = await make('A question that is closed', ['Yes', 'No']);
    await owner.post(`/api/servers/${serverId}/polls/${made.id}/close`, {});
    const res = await owner.patch(`/api/servers/${serverId}/polls/${made.id}`, {
      question: 'A different question',
    });
    assert.equal(res.status, 409, 'a closed poll was edited: ' + JSON.stringify(res.data));
    assert.match(String(res.data.error && res.data.error.message), /closed/i);
  });

  await t.test('a poll says whether it has answers, so the client knows', async () => {
    const fresh = await make('A question with no answers', ['Yes', 'No']);
    const answered = await make('A question with answers', ['Yes', 'No']);
    const voted = await member.post(`/api/servers/${serverId}/polls/${answered.id}/vote`, {
      choices: [answered.options[0].id],
    });
    assert.equal(voted.status, 200, JSON.stringify(voted.data));

    const one = await owner.get(`/api/servers/${serverId}/polls/${fresh.id}`);
    assert.equal(one.data.hasAnswers, false, 'a poll with no answers says it has some');

    const two = await owner.get(`/api/servers/${serverId}/polls/${answered.id}`);
    assert.equal(two.data.hasAnswers, true, 'a poll with answers says it has none');
  });

  await t.test('the options are replaced when they are sent', async () => {
    const made = await make('A question with options', ['One', 'Two', 'Three']);
    const res = await owner.patch(`/api/servers/${serverId}/polls/${made.id}`, {
      options: ['Alpha', 'Beta'],
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.options.length, 2);
    assert.deepEqual(res.data.options.map((option) => option.label), ['Alpha', 'Beta']);
  });

  await t.test('a poll with one option is refused', async () => {
    const made = await make('A question with one option', ['One', 'Two']);
    const res = await owner.patch(`/api/servers/${serverId}/polls/${made.id}`, {
      options: ['Only one'],
    });
    assert.equal(res.status, 400, 'a poll with one option was accepted: ' + JSON.stringify(res.data));
  });

  await t.test('a poll of another community is not found', async () => {
    const made = await make('A question in this community', ['Yes', 'No']);
    const other = await createCommunity(ws, owner, 'Another community');
    const res = await owner.patch(`/api/servers/${other}/polls/${made.id}`, {
      question: 'A question from elsewhere',
    });
    assert.equal(res.status, 404, 'a poll of another community was edited: '
      + JSON.stringify(res.data));
  });
});

// Editing a poll.
//
// A poll may be edited while it is open and while nobody has answered it.
// The person who set it up, or somebody who manages the community's content,
// may do it - the same bar the close route uses, word for word. A poll that
// has closed is not edited, and neither is a poll that has answers: the
// first has its result on record, and the second has ballots that were given
// for the options as they stood. Both are refused with a reason rather than
// quietly ignored.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startWorkspace, createCommunity, addMember, createRole, assignRole, registerUser,
} = require('./helpers');

test('editing a poll', async (t) => {
  const ws = await startWorkspace();
  t.after(() => ws.stop());

  const owner = await registerUser(ws, 'ada');
  const serverId = await createCommunity(ws, owner, 'Polls');
  const member = await addMember(ws, owner, serverId, 'bob');
  const other = await addMember(ws, owner, serverId, 'cleo');

  const create = async (body, who) => {
    const res = await (who || owner).post(`/api/servers/${serverId}/polls`, body);
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return res.data;
  };

  const edit = async (pollId, body, who) => {
    const res = await (who || owner).patch(`/api/servers/${serverId}/polls/${pollId}`, body);
    return res;
  };

  await t.test('the person who set the poll up may edit it', async () => {
    const poll = await create({ question: 'Which day?', options: ['Monday', 'Tuesday'] });

    const edited = await edit(poll.id, {
      question: 'Which day of the week?',
      options: ['Monday', 'Tuesday', 'Wednesday'],
      scoring: 'ranked',
      allowsMultiple: true,
      isAnonymous: true,
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));

    assert.equal(edited.data.question, 'Which day of the week?');
    assert.deepEqual(
      edited.data.options.map((o) => o.label),
      ['Monday', 'Tuesday', 'Wednesday'],
      'the options are the ones the body carried'
    );
    assert.equal(edited.data.scoring, 'ranked');
    assert.equal(edited.data.allowsMultiple, true);
    assert.equal(edited.data.isAnonymous, true);
    assert.equal(edited.data.status, 'open', 'the poll is still open');
    assert.equal(edited.data.createdBy, poll.createdBy, 'the poll is still the one it was');
  });

  await t.test('a field the body does not carry is left as it was', async () => {
    const poll = await create({
      question: 'Which day?',
      options: ['Monday', 'Tuesday'],
      scoring: 'ranked',
      isAnonymous: true,
    });

    const edited = await edit(poll.id, { question: 'Which day, then?' });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    assert.equal(edited.data.question, 'Which day, then?');
    assert.deepEqual(edited.data.options.map((o) => o.label), ['Monday', 'Tuesday']);
    assert.equal(edited.data.scoring, 'ranked', 'the scoring was left alone');
    assert.equal(edited.data.isAnonymous, true, 'the anonymity was left alone');
  });

  await t.test('somebody who did not set it up, and is not a moderator, is refused', async () => {
    const poll = await create({ question: 'Which day?', options: ['Monday', 'Tuesday'] });

    const refused = await edit(poll.id, { question: 'Mine now' }, other);
    assert.equal(refused.status, 403, JSON.stringify(refused.data));
    assert.equal(refused.data.error.code, 'PERMISSION_DENIED');
    assert.match(refused.data.error.message, /author or a moderator/);

    // The poll is untouched.
    const read = await owner.get(`/api/servers/${serverId}/polls/${poll.id}`);
    assert.equal(read.data.question, 'Which day?');
  });

  await t.test('somebody who manages the community may edit a poll somebody else set up', async () => {
    const poll = await create({ question: 'Which day?', options: ['Monday', 'Tuesday'] }, member);

    const role = await createRole(owner, serverId, 'Moderators', ['MANAGE_MESSAGES']);
    await assignRole(owner, serverId, role.id, other.user.id);

    const edited = await edit(poll.id, { question: 'Which day, really?' }, other);
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    assert.equal(edited.data.question, 'Which day, really?');
  });

  await t.test('a closed poll is not edited', async () => {
    const poll = await create({ question: 'Ship it?', options: ['Yes', 'No'] });
    const closed = await owner.post(`/api/servers/${serverId}/polls/${poll.id}/close`, {});
    assert.equal(closed.status, 200, JSON.stringify(closed.data));

    const refused = await edit(poll.id, { question: 'Ship it now?' });
    assert.equal(refused.status, 409, JSON.stringify(refused.data));
    assert.equal(refused.data.error.code, 'CONFLICT');
    assert.match(refused.data.error.message, /closed/i);

    const read = await owner.get(`/api/servers/${serverId}/polls/${poll.id}`);
    assert.equal(read.data.question, 'Ship it?', 'the closed poll is untouched');
  });

  await t.test('a poll that has answers is not edited', async () => {
    const poll = await create({ question: 'Which day?', options: ['Monday', 'Tuesday'] });
    const voted = await member.post(`/api/servers/${serverId}/polls/${poll.id}/vote`, {
      choices: [poll.options[0].id],
    });
    assert.equal(voted.status, 200, JSON.stringify(voted.data));

    const refused = await edit(poll.id, { options: ['Monday', 'Tuesday', 'Wednesday'] });
    assert.equal(refused.status, 409, JSON.stringify(refused.data));
    assert.equal(refused.data.error.code, 'CONFLICT');
    assert.match(refused.data.error.message, /answers/i);

    const read = await owner.get(`/api/servers/${serverId}/polls/${poll.id}`);
    assert.equal(read.data.options.length, 2, 'the options are untouched');
    assert.equal(read.data.options[0].label, 'Monday');
  });

  await t.test('the body is checked', async () => {
    const poll = await create({ question: 'Which day?', options: ['Monday', 'Tuesday'] });

    const empty = await edit(poll.id, { question: '   ' });
    assert.equal(empty.status, 400, JSON.stringify(empty.data));
    assert.equal(empty.data.error.code, 'VALIDATION_ERROR');

    const one = await edit(poll.id, { options: ['Monday'] });
    assert.equal(one.status, 400, JSON.stringify(one.data));
    assert.equal(one.data.error.code, 'VALIDATION_ERROR');

    const blank = await edit(poll.id, { options: ['Monday', ''] });
    assert.equal(blank.status, 400, JSON.stringify(blank.data));
    assert.equal(blank.data.error.code, 'VALIDATION_ERROR');

    const scoring = await edit(poll.id, { scoring: 'apocalyptic' });
    assert.equal(scoring.status, 400, JSON.stringify(scoring.data));
    assert.equal(scoring.data.error.code, 'VALIDATION_ERROR');

    const flag = await edit(poll.id, { allowsMultiple: 'yes' });
    assert.equal(flag.status, 400, JSON.stringify(flag.data));
    assert.equal(flag.data.error.code, 'VALIDATION_ERROR');

    const read = await owner.get(`/api/servers/${serverId}/polls/${poll.id}`);
    assert.equal(read.data.question, 'Which day?', 'nothing was changed');
    assert.equal(read.data.options.length, 2);
  });

  await t.test('an option is no longer than the create route allows', async () => {
    const poll = await create({ question: 'Which day?', options: ['Monday', 'Tuesday'] });
    const long = await edit(poll.id, { options: ['Monday', 'x'.repeat(256)] });
    assert.equal(long.status, 400, JSON.stringify(long.data));
    assert.equal(long.data.error.code, 'VALIDATION_ERROR');
  });

  await t.test('a poll that is not there is not found', async () => {
    const missing = await edit('no-such-poll', { question: 'Anything' });
    assert.equal(missing.status, 404, JSON.stringify(missing.data));
    assert.equal(missing.data.error.code, 'NOT_FOUND');
  });

  await t.test('a member of another community is refused', async () => {
    const outsider = await registerUser(ws, 'mallory');
    const poll = await create({ question: 'Which day?', options: ['Monday', 'Tuesday'] });
    const refused = await edit(poll.id, { question: 'Mine now' }, outsider);
    assert.equal(refused.status, 403, JSON.stringify(refused.data));
    assert.equal(refused.data.error.code, 'NOT_A_MEMBER');
  });
});

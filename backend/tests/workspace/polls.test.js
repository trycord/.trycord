// Polls: voting, the tally, and the record of the result.
//
// Three things are under test. A vote is idempotent: the same member voting
// twice counts once. An anonymous poll does not say who voted. A ranked poll
// is scored by position, and the tie-break is the documented one.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startWorkspace, createCommunity, addMember, createRole, assignRole, registerUser,
} = require('./helpers');

test('polls', async (t) => {
  const ws = await startWorkspace();
  t.after(() => ws.stop());

  const owner = await registerUser(ws, 'ada');
  const serverId = await createCommunity(ws, owner, 'Polls');
  const member = await addMember(ws, owner, serverId, 'bob');
  const other = await addMember(ws, owner, serverId, 'cleo');

  const create = async (body) => {
    const res = await owner.post(`/api/servers/${serverId}/polls`, body);
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return res.data;
  };

  await t.test('a vote is recorded and a repeated vote replaces rather than adds', async () => {
    const poll = await create({ question: 'Which day?', options: ['Monday', 'Tuesday'] });
    const [monday, tuesday] = poll.options;

    const first = await member.post(`/api/servers/${serverId}/polls/${poll.id}/vote`, {
      choices: [monday.id],
    });
    assert.equal(first.status, 200, JSON.stringify(first.data));

    // The same member votes again, for the other day.
    const second = await member.post(`/api/servers/${serverId}/polls/${poll.id}/vote`, {
      choices: [tuesday.id],
    });
    assert.equal(second.status, 200, JSON.stringify(second.data));

    // And once more with the same answer as the first time.
    const third = await member.post(`/api/servers/${serverId}/polls/${poll.id}/vote`, {
      choices: [monday.id],
    });
    assert.equal(third.status, 200);

    const results = await owner.get(`/api/servers/${serverId}/polls/${poll.id}/results`);
    assert.equal(results.status, 200, JSON.stringify(results.data));
    const tally = results.data.results.options;
    assert.equal(tally.find((o) => o.id === monday.id).votes, 1, 'the member is counted once');
    assert.equal(tally.find((o) => o.id === tuesday.id).votes, 0, 'the earlier answer was replaced');
    assert.equal(results.data.results.ballots, 1);
    assert.equal(results.data.results.winner, monday.id);
  });

  await t.test('an anonymous poll does not expose who voted', async () => {
    const poll = await create({ question: 'Who should lead?', options: ['Ada', 'Bob'], isAnonymous: true });
    const voted = await member.post(`/api/servers/${serverId}/polls/${poll.id}/vote`, {
      choices: [poll.options[1].id],
    });
    assert.equal(voted.status, 200);

    // The person who set the poll up may see the tally while it is open, but
    // the tally does not say who cast which vote.
    const asCreator = await owner.get(`/api/servers/${serverId}/polls/${poll.id}/results`);
    assert.equal(asCreator.status, 200, JSON.stringify(asCreator.data));
    assert.deepEqual(asCreator.data.results.voters, [], 'an anonymous poll names nobody');
    assert.equal(asCreator.data.results.ballots, 1, 'the number of voters is still public');

    // A member who did not set the poll up does not see the result at all
    // while it is open.
    const asMember = await other.get(`/api/servers/${serverId}/polls/${poll.id}/results`);
    assert.equal(asMember.status, 403);
    assert.equal(asMember.data.error.code, 'PERMISSION_DENIED');
  });

  await t.test('a ranked poll is scored by position', async () => {
    const poll = await create({ question: 'Rank the ideas', options: ['A', 'B', 'C'], scoring: 'ranked' });
    const [a, b, c] = poll.options;

    // One ballot: A, B, C. Another: A, C, B.
    const one = await member.post(`/api/servers/${serverId}/polls/${poll.id}/vote`, {
      choices: [a.id, b.id, c.id],
    });
    assert.equal(one.status, 200, JSON.stringify(one.data));
    const two = await other.post(`/api/servers/${serverId}/polls/${poll.id}/vote`, {
      choices: [a.id, c.id, b.id],
    });
    assert.equal(two.status, 200, JSON.stringify(two.data));

    const results = await owner.get(`/api/servers/${serverId}/polls/${poll.id}/results`);
    assert.equal(results.status, 200, JSON.stringify(results.data));
    const tally = results.data.results.options;
    // A Borda count over three options: first choice 3, second 2, third 1.
    assert.equal(tally.find((o) => o.id === a.id).score, 6, 'A was first on both ballots');
    assert.equal(tally.find((o) => o.id === b.id).score, 3);
    assert.equal(tally.find((o) => o.id === c.id).score, 3);
    assert.equal(results.data.results.ballots, 2);

    // A is ahead on points and wins. B and C are level on points and level
    // at every position, so the documented tie-break falls to the order the
    // options were given in, and B comes before C.
    assert.equal(results.data.results.winner, a.id, 'the option with the most points wins');
    assert.deepEqual(
      results.data.results.options.map((o) => o.id),
      [a.id, b.id, c.id],
      'the tie is broken by the order of the options'
    );
  });

  await t.test('a closed poll keeps the result it had when it closed', async () => {
    const poll = await create({ question: 'Ship it?', options: ['Yes', 'No'] });
    const yes = poll.options[0].id;
    await member.post(`/api/servers/${serverId}/polls/${poll.id}/vote`, { choices: [yes] });

    const closed = await owner.post(`/api/servers/${serverId}/polls/${poll.id}/close`, {});
    assert.equal(closed.status, 200, JSON.stringify(closed.data));
    assert.equal(closed.data.results.options.find((o) => o.id === yes).votes, 1);

    // A later recount does not rewrite the record: the closed result stands.
    const after = await owner.get(`/api/servers/${serverId}/polls/${poll.id}/results`);
    assert.equal(after.status, 200);
    assert.equal(after.data.closed, true);
    assert.equal(after.data.snapshot.options.find((o) => o.id === yes).votes, 1);
    assert.equal(after.data.results.options.find((o) => o.id === yes).votes, 1);

    // A recount is computed and offered, and it leaves the record alone.
    const recounted = await owner.get(`/api/servers/${serverId}/polls/${poll.id}/results?recount=1`);
    assert.equal(recounted.status, 200);
    assert.ok(recounted.data.recount, 'the recount is a separate answer');
    assert.equal(
      recounted.data.snapshot.options.find((o) => o.id === yes).votes,
      1,
      'the recorded result is untouched by the recount'
    );

    // A closed poll does not take another vote.
    const late = await member.post(`/api/servers/${serverId}/polls/${poll.id}/vote`, { choices: [yes] });
    assert.equal(late.status, 409);
  });

  await t.test('a poll restricted to a role is closed to the members without it', async () => {
    const role = await createRole(owner, serverId, 'Voters');
    const poll = await create({
      question: 'Who votes?',
      options: ['Ada', 'Bob'],
      eligibility: 'role',
      requiredRoleId: role.id,
    });

    const refused = await member.post(`/api/servers/${serverId}/polls/${poll.id}/vote`, {
      choices: [poll.options[0].id],
    });
    assert.equal(refused.status, 403, 'a member without the role cannot vote');
    assert.equal(refused.data.error.code, 'PERMISSION_DENIED');

    await assignRole(owner, serverId, role.id, member.user.id);
    const allowed = await member.post(`/api/servers/${serverId}/polls/${poll.id}/vote`, {
      choices: [poll.options[0].id],
    });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
  });

  await t.test('a member of another community is refused', async () => {
    const outsider = await registerUser(ws, 'mallory');
    const list = await outsider.get(`/api/servers/${serverId}/polls`);
    assert.equal(list.status, 403);
    assert.equal(list.data.error.code, 'NOT_A_MEMBER');
  });
});

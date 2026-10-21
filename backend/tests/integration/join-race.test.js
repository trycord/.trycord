// Two of the same thing at once.
//
// The tables that hold "one row per person per thing" refuse the second
// insert, and that refusal is how a double tap became an error the reader
// could not explain. The live instance's log showed it: a MySQL duplicate
// entry for a voice participant, six times, for one person joining one
// channel.
//
// The rule the answers follow: a uniqueness refusal that means "the other
// one landed" is answered with what the reader would have been told anyway.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startInstance, registerUser, apiClient } = require('../helpers/instance');

test('two joins at once are answered with the same refusal as one', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const guest = await registerUser(instance, 'guest');
  const ownerApi = apiClient(instance.baseUrl, owner.token);

  const community = await ownerApi.post('/api/servers', { name: 'Races' });
  const serverId = community.data.serverId;
  const joinCode = community.data.joinCode;
  const guestApi = apiClient(instance.baseUrl, guest.token);

  // Both requests are in flight before either is answered.
  const both = await Promise.all([
    guestApi.post('/api/servers/join/' + joinCode, {}),
    guestApi.post('/api/servers/join/' + joinCode, {}),
  ]);

  for (const answer of both) {
    assert.ok(answer.status === 200 || answer.status === 400,
      'the join is answered, not crashed: ' + JSON.stringify(answer.data));
    if (answer.status === 400) {
      assert.equal(answer.data.error.code, 'ALREADY_MEMBER',
        'the second join says it is already a member');
    }
  }

  const rows = await instance.db.all(
    'SELECT id FROM server_members WHERE server_id = ? AND user_id = ?',
    [serverId, guest.user.id]
  );
  assert.equal(rows.length, 1, 'the guest is in the community once');
});

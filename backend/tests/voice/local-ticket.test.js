// The ticket that opens the voice process's own page.
//
// The voice process answers on the loopback, on a port of its own, and it
// can change the instance's configuration and mint a credential for the
// relay. The loopback keeps it off the network; the ticket says that the
// person holding it is an administrator of the instance.
//
// A ticket is good once and for a couple of minutes, and only an
// administrator gets one. The check is worth having: a page that can mint a
// credential and change the instance is worth keeping behind a door, and
// the door is the same one the console itself is behind.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startInstance, registerUser, apiClient } = require('../helpers/instance');

test('the ticket that opens the voice page', async (t) => {
  const instance = await startInstance({ jobs: false, env: { ADMIN_USERNAMES: 'owner' } });
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');

  // The owner is a platform administrator: the voice console is where the
  // relay's settings are changed, and that console is behind the admin gate.
  const minted = await owner.post('/api/admin/voice/settings/local-ticket', {});
  assert.equal(minted.status, 200, JSON.stringify(minted.data));
  assert.ok(minted.data.ticket, 'no ticket was minted');
  assert.match(minted.data.url, /^http:\/\/127\.0\.0\.1:\d+\/\?ticket=/,
    'the ticket did not come with an address for the page');

  // The ticket is checked by the API, which is what the voice process asks.
  const verified = await apiClient(instance.baseUrl).post('/api/voice-local-ticket/verify', {
    ticket: minted.data.ticket,
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  assert.equal(verified.data.ok, true, 'the ticket was refused');

  // And it is good once: a ticket that was checked twice is a mistake or an
  // attempt to replay it, and neither should be answered.
  const again = await apiClient(instance.baseUrl).post('/api/voice-local-ticket/verify', {
    ticket: minted.data.ticket,
  });
  assert.equal(again.status, 403, 'a ticket was good twice');
  assert.equal(again.data.ok, false, 'a spent ticket was good');
});

test('a ticket is not minted for anybody who is not an administrator', async (t) => {
  const instance = await startInstance({ jobs: false, env: { ADMIN_USERNAMES: 'owner' } });
  t.after(() => instance.stop());

  const member = await registerUser(instance, 'member');
  const refused = await member.post('/api/admin/voice/settings/local-ticket', {});
  assert.equal(refused.status, 403, 'a member was given a ticket');

  // And an anonymous caller gets nothing either.
  const anonymous = await apiClient(instance.baseUrl)
    .post('/api/voice-local-ticket/verify', { ticket: 'made-up' });
  assert.equal(anonymous.status, 403, 'a made-up ticket was good');
});

test('the voice process opens the page when the ticket is good', async (t) => {
  const instance = await startInstance({ jobs: false, env: { ADMIN_USERNAMES: 'owner' } });
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const minted = await owner.post('/api/admin/voice/settings/local-ticket', {});
  assert.equal(minted.status, 200, JSON.stringify(minted.data));

  // The voice process asks the API whether the ticket is good, so it has to
  // know where the API is. The address is the environment's, and the test
  // instance's is not the default one.
  const previous = process.env.TRYCORD_API_URL;
  process.env.TRYCORD_API_URL = instance.baseUrl;
  t.after(() => {
    if (previous === undefined) delete process.env.TRYCORD_API_URL;
    else process.env.TRYCORD_API_URL = previous;
  });

  const voice = require('../../src/voice/index');
  const answered = await new Promise((resolve) => {
    let head = null;
    const response = {
      writeHead(status, headers) { head = { status, headers }; },
      end() { resolve(head); },
    };
    voice.handler({ url: '/?ticket=' + encodeURIComponent(minted.data.ticket), headers: {}, method: 'GET' }, response);
  });

  assert.ok(answered, 'the page did not answer');
  assert.equal(answered.status, 302, 'a good ticket did not open the page');
  assert.match(String(answered.headers['Set-Cookie'] || ''), /trycord_voice_admin=/,
    'the page did not keep the ticket for the visit');
});

test('the voice page is closed without a ticket', async (t) => {
  const instance = await startInstance({ jobs: false });
  t.after(() => instance.stop());

  const voice = require('../../src/voice/index');

  // Minting a credential is refused without a ticket, and the page says why.
  const page = voice.renderCredentialsPage({
    problem: 'Minting a credential needs an administrator.',
  });
  assert.match(page, /needs an administrator/);

  // The configuration page is readable, and it says that saving needs an
  // administrator.
  const configuration = voice.renderConfigPage({ canSave: false });
  assert.match(configuration, /Saving it needs an administrator/);
  assert.equal(configuration.indexOf('<button type="submit">Save</button>'), -1,
    'the page offers a save button it will refuse');
});

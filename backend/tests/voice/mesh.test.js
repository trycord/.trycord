// The mesh.
//
// The in-house path: the media travels between the participants and the server
// carries the signalling. Four things are checked here: that a seat is given
// without a single SFU credential, that the instance's own relay is used when
// nothing else is configured, that a relay which does not answer stops a
// session rather than pretending to work, and that the room holds no more
// people than it says it does.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerUser } = require('../helpers/instance');
const {
  startRelay, closedPort, voiceInstance, voiceChannel, joinCommunity,
  saveSettings, providers, providerOf,
} = require('./helpers');

test('the mesh', async (t) => {
  await t.test('a seat is given without a single SFU credential', async () => {
    const relay = await startRelay();
    const { instance, owner, member } = await voiceInstance({
      env: { TRYCORD_TURN_HOST: '127.0.0.1', TRYCORD_TURN_PORT: String(relay.port) },
    });
    t.after(async () => { relay.close(); await instance.stop(); });

    const { channelId, joinCode } = await voiceChannel(owner);
    await joinCommunity(member, joinCode);

    const res = await member.post('/api/voice/channels/' + channelId + '/join', {});
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.ok(res.data.sessionId, 'the seat has a session');
    assert.equal(res.data.provider, 'mesh', 'the mesh is carrying the call');

    // The ICE list the peers are given: the instance's own relay, and no
    // credential for any SFU, because there is none.
    const urls = (res.data.iceServers || []).map((entry) => entry.urls);
    assert.ok(urls.some((url) => url.indexOf('stun:') === 0), 'a STUN server is offered');
    assert.ok(urls.some((url) => url.indexOf('turn:') === 0), 'a TURN relay is offered');
    const serialised = JSON.stringify(res.data);
    assert.ok(!/appSecret|sfuAppSecret/.test(serialised), 'no SFU credential is in the answer');
  });

  await t.test('the instance\'s own relay is used when nothing is configured', async () => {
    const port = await closedPort();
    const { instance, owner } = await voiceInstance({
      env: { TRYCORD_TURN_HOST: '127.0.0.1', TRYCORD_TURN_PORT: String(port) },
    });
    t.after(() => instance.stop());

    const caps = await owner.get('/api/voice/capabilities');
    assert.equal(caps.status, 200, JSON.stringify(caps.data));
    const ice = (caps.data.features.voiceVideo.iceServers || []).map((entry) => entry.urls);

    assert.ok(ice.indexOf('stun:127.0.0.1:' + port) !== -1,
      'the in-house STUN address is offered: ' + JSON.stringify(ice));
    assert.ok(ice.indexOf('turn:127.0.0.1:' + port) !== -1,
      'the in-house TURN address is offered: ' + JSON.stringify(ice));
  });

  await t.test('a relay that does not answer stops a session', async () => {
    const port = await closedPort();
    const { instance, owner, member } = await voiceInstance({
      env: { TRYCORD_TURN_HOST: '127.0.0.1', TRYCORD_TURN_PORT: String(port) },
    });
    t.after(() => instance.stop());

    const { channelId, joinCode } = await voiceChannel(owner);
    await joinCommunity(member, joinCode);

    const res = await member.post('/api/voice/channels/' + channelId + '/join', {});
    assert.equal(res.status, 503, JSON.stringify(res.data));
    assert.equal(res.data.error.code, 'VOICE_PROVIDER_UNREACHABLE');
    assert.match(res.data.error.message, /binding request|answered/i,
      'the refusal says what did not answer');
  });

  await t.test('the room holds no more people than it says it does', async () => {
    const relay = await startRelay();
    const { instance, owner, member } = await voiceInstance({
      env: { TRYCORD_TURN_HOST: '127.0.0.1', TRYCORD_TURN_PORT: String(relay.port) },
    });
    t.after(async () => { relay.close(); await instance.stop(); });

    const saved = await saveSettings(owner, { 'voice.mesh.maxParticipants': 2 });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));

    const { channelId, joinCode } = await voiceChannel(owner);
    await joinCommunity(member, joinCode);
    const third = await registerUser(instance, 'third');
    await joinCommunity(third, joinCode);

    const first = await member.post('/api/voice/channels/' + channelId + '/join', {});
    assert.equal(first.status, 201, JSON.stringify(first.data));
    const second = await third.post('/api/voice/channels/' + channelId + '/join', {});
    assert.equal(second.status, 201, JSON.stringify(second.data));

    const refused = await owner.post('/api/voice/channels/' + channelId + '/join', {});
    assert.equal(refused.status, 409, JSON.stringify(refused.data));
    assert.equal(refused.data.error.code, 'ROOM_FULL');
    assert.match(refused.data.error.message, /2 participants/);
  });

  await t.test('the mesh asks for no SFU credentials at all', async () => {
    const { instance, owner } = await voiceInstance();
    t.after(() => instance.stop());

    const report = await providers(owner);
    const mesh = providerOf(report, 'mesh');
    assert.ok(mesh, 'the mesh is one of the providers');
    assert.deepEqual(mesh.missing, [], 'the mesh is not waiting for anything');
    assert.deepEqual(mesh.secrets.map((secret) => secret.key), ['voice.mesh.turnCredential'],
      'the mesh has one credential, and it is the TURN one it may not need');
    assert.equal(mesh.secrets[0].set, false, 'the TURN credential is not required');
  });
});

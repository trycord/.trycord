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

// The ICE list, flattened.
//
// An entry's urls may be one address or a list of them - the browser takes
// both - so the checks read them as a list either way.
function urlsOf(entries) {
  const out = [];
  for (const entry of entries || []) {
    const urls = entry && entry.urls;
    if (Array.isArray(urls)) out.push(...urls);
    else if (urls) out.push(urls);
  }
  return out;
}

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
    const urls = urlsOf(res.data.iceServers);
    assert.ok(urls.some((url) => url.indexOf('stun:') === 0), 'a STUN server is offered');
    assert.ok(urls.some((url) => url.indexOf('turn:') === 0), 'a TURN relay is offered');
    const serialised = JSON.stringify(res.data);
    assert.ok(!/appSecret|sfuAppSecret/.test(serialised), 'no SFU credential is in the answer');
  });

  await t.test('Mesh ignores old manual ICE values and uses the instance relay', async () => {
    const port = await closedPort();
    const { instance, owner } = await voiceInstance({
      env: {
        TRYCORD_TURN_HOST: '127.0.0.1',
        TRYCORD_TURN_PORT: String(port),
        VOICE_VIDEO_MESH_STUN_URLS: 'stun:legacy.example:3478',
        VOICE_VIDEO_MESH_TURN_URL: 'turn:legacy.example:3478',
        VOICE_VIDEO_STUN_URLS: 'stun:older.example:3478',
      },
    });
    t.after(() => instance.stop());

    const refused = await saveSettings(owner, {
      'voice.mesh.stunUrls': ['stun:manual.example:3478'],
      'voice.mesh.turnUrl': 'turn:manual.example:3478',
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.data));

    const caps = await owner.get('/api/voice/capabilities');
    assert.equal(caps.status, 200, JSON.stringify(caps.data));
    const ice = urlsOf(caps.data.features.voiceVideo.iceServers);

    assert.ok(ice.indexOf('stun:127.0.0.1:' + port) !== -1,
      'the in-house STUN address is offered: ' + JSON.stringify(ice));
    assert.ok(ice.indexOf('turn:127.0.0.1:' + port) !== -1,
      'the in-house TURN address is offered: ' + JSON.stringify(ice));
    assert.equal(ice.some((url) => /legacy|older|manual/.test(url)), false,
      'old or hand-entered URLs do not replace the built-in relay');
    const voiceSettings = await owner.get('/api/admin/voice/settings');
    assert.equal(voiceSettings.status, 200, JSON.stringify(voiceSettings.data));
    assert.equal(voiceSettings.data.settings.some((field) => /mesh\.(stunUrls|turnUrl|turnUsername|turnCredential)$/.test(field.key)), false,
      'the console does not ask an administrator to enter relay details');
  });

  await t.test('the published address is the one the console names', async () => {
    const relay = await startRelay();
    const { instance, owner } = await voiceInstance({
      env: { TRYCORD_TURN_HOST: '127.0.0.1', TRYCORD_TURN_PORT: String(relay.port) },
    });
    t.after(async () => { relay.close(); await instance.stop(); });

    const saved = await saveSettings(owner, { 'voice.mesh.publicUrl': 'voice.example.org' });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));

    const caps = await owner.get('/api/voice/capabilities');
    const ice = urlsOf(caps.data.features.voiceVideo.iceServers);
    assert.ok(ice.some((url) => url.indexOf('voice.example.org') !== -1),
      'the clients are given the published address: ' + JSON.stringify(ice));
  });

  await t.test('a relay that does not answer stops a session', async () => {
    // The address is one this host cannot bind, so the relay does not start
    // and nothing answers the binding request.
    //
    // The test used to point the relay at a port nothing was listening on,
    // and the relay bound that port itself - and then answered nothing,
    // because the STUN server had never worked. The refusal it asserted was
    // the refusal of a broken server, not of an absent one. Now the server
    // answers, so the address has to be one it cannot be reached on.
    const { instance, owner, member } = await voiceInstance({
      env: { TRYCORD_TURN_HOST: '203.0.113.1', TRYCORD_TURN_PORT: '3478' },
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

  await t.test('the relay credential is handed to the session that owns it', async () => {
    const relay = await startRelay();
    const { instance, owner, member } = await voiceInstance({
      env: { TRYCORD_TURN_HOST: '127.0.0.1', TRYCORD_TURN_PORT: String(relay.port) },
    });
    t.after(async () => { relay.close(); await instance.stop(); });

    const { channelId, joinCode } = await voiceChannel(owner);
    await joinCommunity(member, joinCode);

    const joined = await member.post('/api/voice/channels/' + channelId + '/join', {});
    assert.equal(joined.status, 201, JSON.stringify(joined.data));

    const credentials = await member.post('/api/voice/credentials', {
      sessionId: joined.data.sessionId,
    });
    assert.equal(credentials.status, 200, JSON.stringify(credentials.data));
    const relay_ = (credentials.data.iceServers || []).find((entry) => String(entry.urls).indexOf('turn:') === 0);
    assert.ok(relay_, 'the relay is offered: ' + JSON.stringify(credentials.data.iceServers));
    assert.ok(relay_.username, 'the relay credential carries a username');
    assert.ok(relay_.credential, 'the relay credential carries a credential');

    // The in-house secret is not in it: what travels is something derived.
    assert.ok(relay_.credential.indexOf('change-me-in-production') === -1,
      'the in-house secret itself is not handed out');

    // And it is not handed to somebody else either.
    const stranger = await owner.post('/api/voice/credentials', {
      sessionId: joined.data.sessionId,
    });
    assert.equal(stranger.status, 404, JSON.stringify(stranger.data));
  });

  await t.test('the mesh asks for no SFU credentials at all', async () => {
    const { instance, owner } = await voiceInstance();
    t.after(() => instance.stop());

    const report = await providers(owner);
    const mesh = providerOf(report, 'mesh');
    assert.ok(mesh, 'the mesh is one of the providers');
    assert.deepEqual(mesh.missing, [], 'the mesh is not waiting for anything');
    assert.deepEqual(mesh.secrets, [], 'the mesh has no secret the operator has to enter');
  });
});

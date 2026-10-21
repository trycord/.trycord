// What the providers share.
//
// The rules that hold whichever provider is in force: that switching between
// them keeps each one's configuration, that only one of them is running, that
// a provider which is not ready cannot start a session, that the permission
// checks and the participant limit still hold, and that the settings the
// previous release used still work.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerUser } = require('../helpers/instance');
const {
  startRelay, voiceInstance, voiceChannel, joinCommunity, saveSettings, providers, providerOf,
} = require('./helpers');

test('what the providers share', async (t) => {
  await t.test('switching provider keeps each provider\'s own configuration', async () => {
    const relay = await startRelay();
    const { instance, owner } = await voiceInstance({
      env: { TRYCORD_TURN_HOST: '127.0.0.1', TRYCORD_TURN_PORT: String(relay.port) },
    });
    t.after(async () => { relay.close(); await instance.stop(); });

    await saveSettings(owner, {
      'voice.mesh.maxParticipants': 4,
    });
    await saveSettings(owner, {
      'voice.cloudflare.appId': 'cloudflare-application',
      'voice.cloudflare.maxParticipants': 12,
    });
    await saveSettings(owner, {
      'voice.sfu.endpoint': 'https://media.example/api',
      'voice.sfu.maxParticipants': 8,
    });

    // Move to one provider and back again.
    await saveSettings(owner, { 'voice.provider': 'cloudflare' });
    let report = await providers(owner);
    assert.equal(report.active, 'cloudflare');
    assert.equal(providerOf(report, 'cloudflare').maxParticipants, 12);
    assert.equal(providerOf(report, 'mesh').maxParticipants, 4);

    await saveSettings(owner, { 'voice.provider': 'mesh' });
    report = await providers(owner);
    assert.equal(report.active, 'mesh');
    assert.equal(providerOf(report, 'mesh').maxParticipants, 4);
    assert.equal(providerOf(report, 'cloudflare').maxParticipants, 12);

    assert.deepEqual(providerOf(report, 'mesh').fields.map((field) => field.key),
      ['voice.mesh.maxParticipants', 'voice.mesh.publicUrl', 'voice.mesh.turnPort',
        'voice.mesh.turnHost', 'voice.mesh.turnRealm'],
      'Mesh asks for the room limit, the published address, and the relay\'s own settings');
    const cloudflareApp = providerOf(report, 'cloudflare').fields
      .find((field) => field.key === 'voice.cloudflare.appId');
    assert.equal(cloudflareApp.value, 'cloudflare-application',
      'Cloudflare kept its own application id');
  });

  await t.test('only the selected provider is the one in force', async () => {
    const relay = await startRelay();
    const { instance, owner } = await voiceInstance({
      env: { TRYCORD_TURN_HOST: '127.0.0.1', TRYCORD_TURN_PORT: String(relay.port) },
    });
    t.after(async () => { relay.close(); await instance.stop(); });

    const report = await providers(owner);
    const inForce = report.providers.filter((provider) => provider.inForce);
    assert.equal(inForce.length, 1, 'exactly one provider is in force');
    assert.equal(inForce[0].id, 'mesh');

    for (const provider of report.providers) {
      if (provider.inForce) continue;
      assert.notEqual(provider.state, 'active',
        provider.id + ' is not in force, so it is not reported as working');
    }
  });

  await t.test('a session cannot start on a provider that is not ready', async () => {
    const { instance, owner, member } = await voiceInstance();
    t.after(() => instance.stop());

    await saveSettings(owner, { 'voice.provider': 'cloudflare' });
    const { channelId, joinCode } = await voiceChannel(owner);
    await joinCommunity(member, joinCode);

    const res = await member.post('/api/voice/channels/' + channelId + '/join', {});
    assert.equal(res.status, 503, JSON.stringify(res.data));
    assert.equal(res.data.error.code, 'VOICE_NOT_CONFIGURED');

    // The diagnostics say the same thing, in the same words.
    const report = await providers(owner);
    const cloudflare = providerOf(report, 'cloudflare');
    assert.equal(cloudflare.state, 'failed', 'the provider is not ready');
    assert.match(cloudflare.missing.join(' '), /application id is not set/);
    assert.ok(res.data.error.message.indexOf(cloudflare.missing[0]) !== -1,
      'the refusal and the diagnostics name the same thing');
  });

  await t.test('the permission checks and the participant limit still hold', async () => {
    const relay = await startRelay();
    const { instance, owner, member } = await voiceInstance({
      env: { TRYCORD_TURN_HOST: '127.0.0.1', TRYCORD_TURN_PORT: String(relay.port) },
    });
    t.after(async () => { relay.close(); await instance.stop(); });

    const { channelId, joinCode } = await voiceChannel(owner);
    await joinCommunity(member, joinCode);

    // Somebody who is not a member of the community is refused.
    const stranger = await registerUser(instance, 'stranger');
    const refused = await stranger.post('/api/voice/channels/' + channelId + '/join', {});
    assert.equal(refused.status, 403, JSON.stringify(refused.data));
    assert.equal(refused.data.error.code, 'NOT_A_MEMBER');

    // A member is let in.
    const allowed = await member.post('/api/voice/channels/' + channelId + '/join', {});
    assert.equal(allowed.status, 201, JSON.stringify(allowed.data));

    // Screen sharing needs the screen-sharing permission, which @everyone does
    // not hold.
    const screen = await member.post('/api/voice/channels/' + channelId + '/screen', {});
    assert.equal(screen.status, 403, JSON.stringify(screen.data));
    assert.equal(screen.data.error.code, 'PERMISSION_DENIED');
  });

  await t.test('a call that is running keeps the provider it started on', async () => {
    const relay = await startRelay();
    const { instance, owner, member } = await voiceInstance({
      env: { TRYCORD_TURN_HOST: '127.0.0.1', TRYCORD_TURN_PORT: String(relay.port) },
    });
    t.after(async () => { relay.close(); await instance.stop(); });

    const { channelId, joinCode } = await voiceChannel(owner);
    await joinCommunity(member, joinCode);

    const joined = await member.post('/api/voice/channels/' + channelId + '/join', {});
    assert.equal(joined.status, 201, JSON.stringify(joined.data));
    assert.equal(joined.data.provider, 'mesh');

    // The instance is pointed at another provider while the call is running.
    await saveSettings(owner, { 'voice.provider': 'cloudflare' });

    // The call is still on the provider it started on.
    const session = await member.get('/api/voice/channels/' + channelId + '/session');
    assert.equal(session.status, 200, JSON.stringify(session.data));
    assert.equal(session.data.provider, 'mesh',
      'the running call is still on the provider it started on');

    // Somebody who joins that call joins the call that is running.
    const other = await registerUser(instance, 'other');
    await joinCommunity(other, joinCode);
    const withTheCall = await other.post('/api/voice/channels/' + channelId + '/join', {});
    assert.equal(withTheCall.status, 201, JSON.stringify(withTheCall.data));
    assert.equal(withTheCall.data.provider, 'mesh',
      'the running call carries the new participant as well');

    // A new call elsewhere would start on the provider now in force, and that
    // provider is not ready: it is refused, and the refusal says what is
    // missing.
    const elsewhere = await voiceChannel(owner, 'Another Voice Test');
    const refused = await member.post('/api/voice/channels/' + elsewhere.channelId + '/join', {});
    assert.equal(refused.status, 503, JSON.stringify(refused.data));
    assert.equal(refused.data.error.code, 'VOICE_NOT_CONFIGURED');
    assert.match(refused.data.error.message, /application id is not set/);
  });

  await t.test('Cloudflare settings migrate and retired Mesh settings are refused', async () => {
    const { instance, owner } = await voiceInstance();
    t.after(() => instance.stop());

    // The old keys, saved as an older console would have saved them.
    const saved = await saveSettings(owner, {
      'voice.sfuAppId': 'the-old-application-id',
      'voice.maxParticipants': 9,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));

    const report = await providers(owner);

    const cloudflare = providerOf(report, 'cloudflare');
    const appId = cloudflare.fields.find((field) => field.key === 'voice.cloudflare.appId');
    assert.equal(appId.value, 'the-old-application-id',
      'the old application id is the value the new key takes');
    assert.equal(appId.source, 'legacy', 'the report says where the value came from');
    assert.equal(appId.legacy, 'voice.sfuAppId');

    const mesh = providerOf(report, 'mesh');
    assert.equal(mesh.maxParticipants, 9, 'the old participant limit is the one in force');
    assert.deepEqual(mesh.fields.map((field) => field.key),
      ['voice.mesh.maxParticipants', 'voice.mesh.publicUrl', 'voice.mesh.turnPort',
        'voice.mesh.turnHost', 'voice.mesh.turnRealm'],
      'Mesh asks for the room limit, the published address, and the relay\'s own settings');

    const retired = await saveSettings(owner, { 'voice.mesh.turnUrl': 'turn:legacy.example:3478' });
    assert.equal(retired.status, 400);
    assert.match(retired.data.error.message, /built-in relay|manual ICE/i);

    // The first save of the provider's own configuration takes over.
    const written = await saveSettings(owner, { 'voice.cloudflare.appId': 'a-new-application-id' });
    assert.equal(written.status, 200, JSON.stringify(written.data));

    const after = await providers(owner);
    const moved = providerOf(after, 'cloudflare').fields
      .find((field) => field.key === 'voice.cloudflare.appId');
    assert.equal(moved.value, 'a-new-application-id');
    assert.equal(moved.source, 'instance', 'the new key is the one in force now');
    assert.equal(moved.legacy, null, 'the older setting is not consulted any more');
  });
});

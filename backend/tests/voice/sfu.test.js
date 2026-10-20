// The third-party SFU.
//
// A media server the operator runs, reached over HTTP with the documented
// session API. What is checked here is that an endpoint which is not a URL is
// refused rather than dialled, that a check which fails leaves the provider
// degraded rather than working, and that the token never appears in an answer.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  voiceInstance, voiceChannel, joinCommunity, saveSettings, providers, providerOf,
} = require('./helpers');

test('the third-party SFU', async (t) => {
  await t.test('an endpoint that is not a URL is refused', async () => {
    const { instance, owner, member } = await voiceInstance();
    t.after(() => instance.stop());

    await saveSettings(owner, {
      'voice.provider': 'sfu',
      'voice.sfu.endpoint': 'not-a-url',
    });
    const { channelId, joinCode } = await voiceChannel(owner);
    await joinCommunity(member, joinCode);

    const res = await member.post('/api/voice/channels/' + channelId + '/join', {});
    assert.equal(res.status, 503, JSON.stringify(res.data));
    assert.equal(res.data.error.code, 'VOICE_NOT_CONFIGURED');
    assert.match(res.data.error.message, /endpoint is not a URL/,
      'the refusal names the endpoint: ' + res.data.error.message);
  });

  await t.test('a missing endpoint is refused', async () => {
    const { instance, owner, member } = await voiceInstance();
    t.after(() => instance.stop());

    await saveSettings(owner, { 'voice.provider': 'sfu' });
    const { channelId, joinCode } = await voiceChannel(owner);
    await joinCommunity(member, joinCode);

    const res = await member.post('/api/voice/channels/' + channelId + '/join', {});
    assert.equal(res.status, 503, JSON.stringify(res.data));
    assert.match(res.data.error.message, /endpoint is not set/,
      'the refusal names the endpoint: ' + res.data.error.message);
  });

  await t.test('a check that fails leaves the provider degraded, not working', async () => {
    const { instance, owner } = await voiceInstance();
    t.after(() => instance.stop());

    await saveSettings(owner, {
      'voice.provider': 'sfu',
      // Nothing is listening on this port, so the media server cannot answer.
      'voice.sfu.endpoint': 'http://127.0.0.1:9',
    });

    const check = await owner.post('/api/voice/providers/sfu/check', {});
    assert.equal(check.status, 200, JSON.stringify(check.data));
    assert.equal(check.data.ok, false, 'the check did not find a media server');
    assert.ok(check.data.detail, 'the check says what it found');

    const report = await providers(owner);
    const sfu = providerOf(report, 'sfu');
    assert.equal(sfu.state, 'degraded', 'a provider that did not answer is degraded');
    assert.notEqual(sfu.state, 'active', 'it is not reported as working');
  });

  await t.test('the token is never in an answer', async () => {
    const { instance, owner } = await voiceInstance();
    t.after(() => instance.stop());

    await saveSettings(owner, {
      'voice.provider': 'sfu',
      'voice.sfu.endpoint': 'http://127.0.0.1:9',
      'voice.sfu.token': 'a-token-that-must-never-be-returned',
    });

    const report = await providers(owner);
    assert.ok(JSON.stringify(report).indexOf('a-token-that-must-never-be-returned') === -1,
      'the provider report does not carry the token');

    const sfu = providerOf(report, 'sfu');
    const secret = sfu.secrets.find((entry) => entry.key === 'voice.sfu.token');
    assert.equal(secret.set, true, 'the report says the token is set');
    assert.equal(secret.value, undefined, 'the report does not carry the value');

    const caps = await owner.get('/api/voice/capabilities');
    assert.ok(JSON.stringify(caps.data).indexOf('a-token-that-must-never-be-returned') === -1,
      'the capability answer does not carry the token');
  });
});

// Cloudflare Realtime.
//
// The SFU integration that already existed: a real API at
// rtc.live.cloudflare.com that the instance creates sessions on. What is
// checked here is that it is wired to the provider that is in force, that a
// half-configured provider is refused with a list of what is missing, that the
// health check really reaches the other end, and that the application secret
// never appears in an answer.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  voiceInstance, voiceChannel, joinCommunity, saveSettings, providers, providerOf,
} = require('./helpers');

// A fetch that answers for the Cloudflare endpoint and passes everything else
// through, so the rest of the instance behaves as it normally does.
function stubCloudflare(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const address = String(url);
    if (address.indexOf('rtc.live.cloudflare.com') === -1) return original(url, options);
    calls.push({ url: address, options: options || {} });
    return handler(calls.length, options || {});
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('Cloudflare Realtime', async (t) => {
  await t.test('a session is refused when the application id is missing', async () => {
    const { instance, owner, member } = await voiceInstance();
    t.after(() => instance.stop());

    await saveSettings(owner, { 'voice.provider': 'cloudflare' });
    const { channelId, joinCode } = await voiceChannel(owner);
    await joinCommunity(member, joinCode);

    const res = await member.post('/api/voice/channels/' + channelId + '/join', {});
    assert.equal(res.status, 503, JSON.stringify(res.data));
    assert.equal(res.data.error.code, 'VOICE_NOT_CONFIGURED');
    assert.match(res.data.error.message, /application id is not set/,
      'the refusal names what is missing: ' + res.data.error.message);
    assert.match(res.data.error.message, /application secret is not set/,
      'the refusal names what is missing: ' + res.data.error.message);
  });

  await t.test('a session is refused when only the application id is set', async () => {
    const { instance, owner, member } = await voiceInstance();
    t.after(() => instance.stop());

    await saveSettings(owner, {
      'voice.provider': 'cloudflare',
      'voice.cloudflare.appId': 'application-under-test',
    });
    const { channelId, joinCode } = await voiceChannel(owner);
    await joinCommunity(member, joinCode);

    const res = await member.post('/api/voice/channels/' + channelId + '/join', {});
    assert.equal(res.status, 503, JSON.stringify(res.data));
    assert.match(res.data.error.message, /application secret is not set/,
      'the refusal names the one thing that is missing: ' + res.data.error.message);
    assert.ok(!/application id is not set/.test(res.data.error.message),
      'the refusal does not name the thing that is set');
  });

  await t.test('the health check reaches the endpoint and reports what it found', async () => {
    const { instance, owner } = await voiceInstance();
    t.after(() => instance.stop());

    await saveSettings(owner, {
      'voice.provider': 'cloudflare',
      'voice.cloudflare.appId': 'application-under-test',
      'voice.cloudflare.appSecret': 'a-secret-that-must-never-be-returned',
    });

    const stub = stubCloudflare(() => jsonResponse(200, { sessionId: 'session-1' }));
    t.after(() => stub.restore());

    const res = await owner.post('/api/voice/providers/cloudflare/check', {});
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.ok, true, 'the check found a working endpoint');
    assert.ok(stub.calls.length >= 1, 'the check actually called the endpoint');
    assert.match(stub.calls[0].url, /rtc\.live\.cloudflare\.com\/v1\/apps\/application-under-test\/sessions\/new/,
      'the check called the sessions endpoint: ' + stub.calls[0].url);
    assert.equal(stub.calls[0].options.headers.Authorization, 'Bearer a-secret-that-must-never-be-returned',
      'the check authenticated with the application secret');
  });

  await t.test('an endpoint that refuses the credentials is not reported as working', async () => {
    const { instance, owner } = await voiceInstance();
    t.after(() => instance.stop());

    await saveSettings(owner, {
      'voice.provider': 'cloudflare',
      'voice.cloudflare.appId': 'application-under-test',
      'voice.cloudflare.appSecret': 'a-secret-that-must-never-be-returned',
    });

    const stub = stubCloudflare(() => jsonResponse(401, { error: { errorCode: 10001 } }));
    t.after(() => stub.restore());

    const res = await owner.post('/api/voice/providers/cloudflare/check', {});
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, false, 'a refused credential is not a working endpoint');
    assert.match(res.data.detail, /refused the application secret/);

    const report = await providers(owner);
    const cloudflare = providerOf(report, 'cloudflare');
    assert.equal(cloudflare.state, 'degraded', 'a provider that did not answer is degraded');
    assert.notEqual(cloudflare.state, 'active');
  });

  await t.test('the application secret is never in an answer', async () => {
    const { instance, owner } = await voiceInstance();
    t.after(() => instance.stop());

    await saveSettings(owner, {
      'voice.provider': 'cloudflare',
      'voice.cloudflare.appId': 'application-under-test',
      'voice.cloudflare.appSecret': 'a-secret-that-must-never-be-returned',
    });

    const stub = stubCloudflare(() => jsonResponse(200, { sessionId: 'session-1' }));
    t.after(() => stub.restore());

    const report = await providers(owner);
    const serialised = JSON.stringify(report);
    assert.ok(serialised.indexOf('a-secret-that-must-never-be-returned') === -1,
      'the provider report does not carry the secret');
    assert.ok(/appSecret/.test(serialised), 'the report names the credential');

    const cloudflare = providerOf(report, 'cloudflare');
    const secret = cloudflare.secrets.find((entry) => entry.key === 'voice.cloudflare.appSecret');
    assert.equal(secret.set, true, 'the report says the credential is set');
    assert.equal(secret.value, undefined, 'the report does not carry the value');

    const caps = await owner.get('/api/voice/capabilities');
    assert.ok(JSON.stringify(caps.data).indexOf('a-secret-that-must-never-be-returned') === -1,
      'the capability answer does not carry the secret');
  });
});

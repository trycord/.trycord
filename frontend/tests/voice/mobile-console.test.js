// The Voice and video console on the phone.
//
// The phone shows the same section the desktop does, so the two have to agree
// about which fields belong to which provider, about what a credential looks
// like, and about what a connectivity check says. The rules themselves are
// shared; what is checked here is that this client applies them.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from '../helpers/dom-stub.js';

installDomStub();

const { voiceBody } = await import('../../mobile/js/views/voice.js');

// The answer the console reads.
const REPORT = {
  enabled: true,
  active: 'mesh',
  screenSharing: true,
  stageChannels: true,
  maxParticipants: 6,
  providers: [
    {
      id: 'mesh',
      label: 'Mesh',
      summary: 'The in-house peer-to-peer path.',
      note: 'The media travels between every participant, so a room is small.',
      inForce: true,
      state: 'active',
      missing: [],
      problems: [],
      maxParticipants: 6,
      fields: [
        { key: 'voice.mesh.maxParticipants', name: 'maxParticipants', type: 'integer', label: 'Participants per mesh room', description: 'The room is small.', value: 6, source: 'default', legacy: null },
      ],
      secrets: [],
      check: { ok: true, detail: 'The address answered a binding request.', at: 1 },
    },
    {
      id: 'cloudflare',
      label: 'Cloudflare Realtime',
      summary: 'The Cloudflare SFU.',
      note: 'The application secret never reaches a browser.',
      inForce: false,
      state: 'failed',
      missing: ['the Cloudflare application id is not set'],
      problems: ['the Cloudflare application id is not set'],
      maxParticipants: 25,
      fields: [
        { key: 'voice.cloudflare.appId', name: 'appId', type: 'string', label: 'Cloudflare application id', description: 'From the dashboard.', value: '', source: 'default', legacy: null },
      ],
      secrets: [
        { key: 'voice.cloudflare.appSecret', name: 'appSecret', type: 'secret', label: 'Cloudflare application secret', description: 'Stored encrypted.', set: true, source: 'instance', legacy: null },
      ],
      check: null,
    },
  ],
};

const CLOUDFLARE_REPORT = {
  ...REPORT,
  active: 'cloudflare',
  providers: REPORT.providers.map((provider) => ({
    ...provider,
    inForce: provider.id === 'cloudflare',
  })),
};

function find(node, predicate, found = []) {  if (!node) return found;
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

function byName(node, name) {
  const found = find(node, (candidate) => candidate.getAttribute
    && candidate.getAttribute('name') === name);
  return found.length ? found[0] : null;
}

function byText(node, needle) {
  const found = find(node, (candidate) => candidate.tagName === 'BUTTON'
    && (candidate.textContent || '').indexOf(needle) !== -1);
  return found.length ? found[0] : null;
}

test('the voice console on the phone', async () => {
  await test('a provider shows only its own fields, plus the shared ones', async () => {
    installFetchStub({
      'http://localhost/api/voice/providers': { json: REPORT },
      'http://localhost/api/admin/voice/settings': { json: { ok: true, changed: [] } },
    });

    const body = voiceBody();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const text = body.textContent || '';
    assert.match(text, /Voice and video/, 'the shared switch is shown');
    assert.match(text, /Screen sharing/);
    assert.match(text, /Participants per channel/);

    assert.ok(byName(body, 'voice.mesh.maxParticipants'),
      'the fields of the provider in force are shown');
    assert.equal(byName(body, 'voice.mesh.stunUrls'), null,
      'the built-in relay asks for no STUN server');
    assert.equal(byName(body, 'voice.mesh.turnCredential'), null,
      'the built-in relay needs no manual credentials');
    assert.equal(byName(body, 'voice.cloudflare.appId'), null,
      'the fields of a provider that is not in force are not shown');
  });

  await test('a credential is masked and can be replaced', async () => {
    const calls = installFetchStub({
      'http://localhost/api/voice/providers': { json: CLOUDFLARE_REPORT },
      'http://localhost/api/admin/voice/settings': { json: { ok: true, changed: [] } },
    });

    const body = voiceBody();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const input = byName(body, 'voice.cloudflare.appSecret');
    assert.ok(input, 'the credential has a field');
    assert.equal(input.getAttribute('type'), 'password', 'the field is masked');
    assert.equal(input.value, '', 'the field holds no value');

    input.value = 'a-new-credential';
    const replace = byText(body, 'Replace');
    assert.ok(replace, 'the credential can be replaced');
    replace.click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const saved = calls.filter((call) => call.url.indexOf('/api/admin/voice/settings') !== -1);
    assert.ok(saved.length, 'the replacement was saved');
    assert.equal(saved[saved.length - 1].body['voice.cloudflare.appSecret'], 'a-new-credential');
  });

  await test('the result of a connectivity check is shown', async () => {
    const calls = installFetchStub({
      'http://localhost/api/voice/providers': { json: REPORT },
      'http://localhost/api/admin/voice/settings': { json: { ok: true, changed: [] } },
      'http://localhost/api/voice/providers/mesh/check': {
        json: { provider: 'mesh', ok: false, detail: 'Nothing answered a binding request.', checkedAt: 2, missing: [] },
      },
    });

    const body = voiceBody();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const test_ = byText(body, 'Test');
    assert.ok(test_, 'a provider can be tested');
    test_.click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(calls.some((call) => call.url.indexOf('/api/voice/providers/mesh/check') !== -1),
      'the check was made');

    const said = (document.body.textContent || '');
    assert.match(said, /did not answer/, 'the result says what the check found');
    assert.match(said, /Nothing answered a binding request/, 'the detail is shown');
  });
});

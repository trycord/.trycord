// The Voice and video console.
//
// The console is where an operator finds out whether voice works. Three
// things are checked here, because each of them was wrong in one way or
// another before: that a provider shows only its own fields, that a credential
// is managed rather than typed, and that the result of a connectivity check is
// actually shown rather than swallowed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from '../helpers/dom-stub.js';

installDomStub();

const { adminVoice } = await import('../../js/features/voice.js');

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
        { key: 'voice.mesh.stunUrls', name: 'stunUrls', type: 'list', label: 'STUN servers for the mesh', description: 'Comma-separated.', value: [], source: 'default', legacy: null },
        { key: 'voice.mesh.turnUrl', name: 'turnUrl', type: 'string', label: 'TURN server for the mesh', description: 'Relays media.', value: '', source: 'default', legacy: null },
      ],
      secrets: [
        { key: 'voice.mesh.turnCredential', name: 'turnCredential', type: 'secret', label: 'TURN credential for the mesh', description: 'The password half of a static TURN credential.', set: false, source: 'default', legacy: null },
      ],
      check: { ok: true, detail: 'The address answered a binding request.', at: 1 },
    },
    {
      id: 'cloudflare',
      label: 'Cloudflare Realtime',
      summary: 'The Cloudflare SFU.',
      note: 'The application secret never reaches a browser.',
      inForce: false,
      state: 'configured',
      missing: ['the Cloudflare application id is not set'],
      problems: ['the Cloudflare application id is not set'],
      maxParticipants: 25,
      fields: [
        { key: 'voice.cloudflare.appId', name: 'appId', type: 'string', label: 'Cloudflare application id', description: 'From the dashboard.', value: '', source: 'default', legacy: null },
        { key: 'voice.cloudflare.endpoint', name: 'endpoint', type: 'string', label: 'Cloudflare Realtime endpoint', description: 'Where the sessions are created.', value: 'https://rtc.live.cloudflare.com/v1', source: 'default', legacy: null },
      ],
      secrets: [
        { key: 'voice.cloudflare.appSecret', name: 'appSecret', type: 'secret', label: 'Cloudflare application secret', description: 'Stored encrypted.', set: true, source: 'instance', legacy: null },
      ],
      check: null,
    },
    {
      id: 'sfu',
      label: 'Third-party SFU',
      summary: 'A media server the operator runs.',
      note: 'The token is used by the server only.',
      inForce: false,
      state: 'configured',
      missing: ['the media server endpoint is not set'],
      problems: ['the media server endpoint is not set'],
      maxParticipants: 25,
      fields: [
        { key: 'voice.sfu.endpoint', name: 'endpoint', type: 'string', label: 'Third-party SFU endpoint', description: 'The base URL.', value: '', source: 'default', legacy: null },
      ],
      secrets: [
        { key: 'voice.sfu.token', name: 'token', type: 'secret', label: 'Third-party SFU token', description: 'Stored encrypted.', set: false, source: 'default', legacy: null },
      ],
      check: null,
    },
  ],
};

function find(node, predicate, found = []) {
  if (!node) return found;
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

function byLabel(node, label) {
  const found = find(node, (candidate) => candidate.getAttribute
    && candidate.getAttribute('aria-label') === label);
  return found.length ? found[0] : null;
}

function text(node) {
  return node.textContent || '';
}

test('the voice console', async () => {
  await test('a provider shows only its own fields, plus the shared ones', async () => {
    installFetchStub({
      'http://localhost/api/voice/providers': { json: REPORT },
      'http://localhost/api/admin/settings': { json: { ok: true, changed: [] } },
    });

    const view = adminVoice();
    await view.onMount();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const body = text(view.node);

    // The fields of the provider in force.
    assert.match(body, /STUN servers for the mesh/, 'the mesh\'s own fields are shown');
    assert.match(body, /TURN server for the mesh/);

    // The shared controls.
    assert.match(body, /Voice and video/, 'the shared switch is shown');
    assert.match(body, /Screen sharing/);
    assert.match(body, /Participants per channel/);

    // The fields of the providers that are not in force.
    assert.equal(byLabel(view.node, 'Cloudflare application id'), null,
      'the fields of a provider that is not in force are not shown');
    assert.equal(byLabel(view.node, 'Third-party SFU endpoint'), null,
      'the fields of a provider that is not in force are not shown');
    assert.ok(byLabel(view.node, 'STUN servers for the mesh'),
      'the fields of the provider in force are shown');

    // The provider is chosen first, and the choice is offered.
    assert.match(body, /Cloudflare Realtime/, 'the other providers are offered');
    assert.match(body, /Third-party SFU/);
  });

  await test('a credential is masked, and can be replaced and cleared', async () => {
    const calls = installFetchStub({
      'http://localhost/api/voice/providers': { json: REPORT },
      'http://localhost/api/admin/settings': { json: { ok: true, changed: [] } },
    });

    const view = adminVoice();
    await view.onMount();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const input = byLabel(view.node, 'New value for TURN credential for the mesh');
    assert.ok(input, 'the credential has a field');
    assert.equal(input.getAttribute('type'), 'password', 'the field is masked');
    assert.equal(input.value, '', 'the field holds no value: a saved secret is never sent to the client');

    assert.ok(byLabel(view.node, 'Replace TURN credential for the mesh'), 'the credential can be replaced');
    assert.ok(byLabel(view.node, 'Clear TURN credential for the mesh'), 'the credential can be cleared');

    // Replacing it writes the new value and nothing else.
    input.value = 'a-new-credential';
    byLabel(view.node, 'Replace TURN credential for the mesh').click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const saved = calls.filter((call) => call.url.indexOf('/api/admin/settings') !== -1);
    assert.ok(saved.length, 'the replacement was saved');
    const body = saved[saved.length - 1].body;
    assert.equal(body['voice.mesh.turnCredential'], 'a-new-credential');

    // Clearing it is a deliberate act, and it is confirmed before it happens.
    const before = calls.filter((call) => call.url.indexOf('/api/admin/settings') !== -1).length;
    byLabel(view.node, 'Clear TURN credential for the mesh').click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const dialog = document.body.querySelector('.dialog');
    assert.ok(dialog, 'clearing a credential asks first');
    const buttons = find(dialog, (node) => node.tagName === 'BUTTON' && text(node).indexOf('Clear it') !== -1);
    assert.ok(buttons.length, 'the dialog offers the clear');
    buttons[0].click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const after = calls.filter((call) => call.url.indexOf('/api/admin/settings') !== -1);
    assert.ok(after.length > before, 'the clear was saved');
    assert.equal(after[after.length - 1].body['voice.mesh.turnCredential'], null,
      'the clear is written as an explicit removal');
  });

  await test('the result of a connectivity check is shown', async () => {
    const calls = installFetchStub({
      'http://localhost/api/voice/providers': { json: REPORT },
      'http://localhost/api/admin/settings': { json: { ok: true, changed: [] } },
      'http://localhost/api/voice/providers/mesh/check': {
        json: { provider: 'mesh', ok: false, detail: 'Nothing answered a binding request.', checkedAt: 2, missing: [] },
      },
    });

    const view = adminVoice();
    await view.onMount();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const button = byLabel(view.node, 'Test the connection to Mesh');
    assert.ok(button, 'the mesh can be tested');
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.ok(calls.some((call) => call.url.indexOf('/api/voice/providers/mesh/check') !== -1),
      'the check was made');

    const statuses = find(view.node, (node) => node.getAttribute
      && node.getAttribute('role') === 'status');
    assert.ok(statuses.length, 'the result is announced');
    const said = statuses.map((node) => text(node)).join(' ');
    assert.match(said, /did not answer/, 'the result says what the check found: ' + said);
    assert.match(said, /Nothing answered a binding request/, 'the detail is shown: ' + said);
  });

  await test('a provider that is not ready says what is missing', async () => {
    installFetchStub({
      'http://localhost/api/voice/providers': { json: REPORT },
      'http://localhost/api/admin/settings': { json: { ok: true, changed: [] } },
    });

    const view = adminVoice();
    await view.onMount();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const body = text(view.node);
    assert.match(body, /the Cloudflare application id is not set/,
      'the diagnostics name what a provider is waiting for');
    assert.match(body, /not answering|configured/, 'the state is shown');
  });
});

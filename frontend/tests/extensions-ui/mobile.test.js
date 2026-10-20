// The extension console, on a phone.
//
// The phone is not a smaller desk: the sections are the same, but the shape
// is a list and a sheet. These checks are about the parts that have to be the
// same on both: the consent, the answer that has to be given before an install
// is sent, and the switch that has to ask before it is turned on.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub, waitFor } from '../helpers/dom-stub.js';

installDomStub();

// The phone's sheet asks the browser for the next frame. Node has no such
// thing, so the check gives it one.
if (!globalThis.requestAnimationFrame) {
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
}

const { State } = await import('../../packages/store.js');
const { renderExtensions } = await import('../../mobile/js/views/extensions.js');

// -- finding things -------------------------------------------------------------

function findAll(node, predicate, found = []) {
  if (!node) return found;
  if (Array.isArray(node)) {
    for (const entry of node) findAll(entry, predicate, found);
    return found;
  }
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) findAll(child, predicate, found);
  return found;
}

function classed(word) {
  return (node) => {
    const value = node.getAttribute && node.getAttribute('class');
    return !!value && value.split(/\s+/).indexOf(word) !== -1;
  };
}

function byLabel(node, label) {
  return findAll(node, (entry) => entry.getAttribute('aria-label') === label);
}

function sheets() {
  return findAll(document.body, classed('m-sheet'));
}

function sheetWith(text) {
  return sheets().filter((node) => String(node.textContent || '').indexOf(text) !== -1)[0] || null;
}

function checkboxes(node) {
  return findAll(node, (entry) => entry.tagName === 'INPUT' && entry.getAttribute('type') === 'checkbox');
}

function tabOf(view, name) {
  const button = byLabel(view.node, 'Show the ' + name.toLowerCase() + ' section')[0];
  assert.ok(button, 'the console has no ' + name + ' section');
  button.click();
  return button;
}

// -- the fixtures ----------------------------------------------------------------

const PACKAGE = {
  id: 'example.notes',
  name: 'Quiet Notes',
  version: '1.2.0',
  description: 'Keeps a quiet note on every message.',
  author: 'Example',
  requestedCapabilities: ['messages.read', 'messages.write'],
  trusted: false,
  reviewStatus: 'approved',
  signature: { status: 'verified' },
  installable: true,
  reason: null,
};

const ENTRY = {
  id: PACKAGE.id,
  name: PACKAGE.name,
  version: PACKAGE.version,
  description: PACKAGE.description,
  author: PACKAGE.author,
  requestedCapabilities: PACKAGE.requestedCapabilities,
  trusted: false,
  reviewStatus: PACKAGE.reviewStatus,
  signature: PACKAGE.signature,
  installable: true,
  reason: null,
};

const WORKFLOW = {
  id: 'w1',
  name: 'Morning note',
  ownerId: 'u1',
  state: 'active',
  version: 1,
  trigger: { type: 'manual' },
  conditions: [],
  steps: [{ type: 'action', action: 'message.send', params: {} }],
  grants: ['messages.write'],
};

const BASE = 'http://localhost/api/extensions';

function routes(extra) {
  return Object.assign({
    [BASE + '/registry']: { json: { registry: { source: 'builtin', available: true, extensions: [ENTRY] } } },
    [BASE + '/registry/' + PACKAGE.id]: { json: { package: PACKAGE } },
  }, extra || {});
}

// -- the tests --------------------------------------------------------------------

test('the phone lists what the registry offers', async () => {
  State.user = { id: 'u1', isAdmin: true };
  const calls = installFetchStub(routes());

  const view = renderExtensions({ page: { id: 'extensions' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();

  assert.match(view.node.textContent, /Quiet Notes/, 'the registry did not list the package');
  assert.ok(calls.some((call) => call.url === BASE + '/registry'), 'the registry was never read');
});

test('the phone asks for the consent before it installs', async () => {
  State.user = { id: 'u1', isAdmin: true };
  const calls = installFetchStub(routes({
    [BASE + '/install']: { json: { extension: {}, granted: ['messages.read'], refused: [] } },
  }));

  const view = renderExtensions({ page: { id: 'extensions' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();

  const entry = findAll(view.node, (node) => node.tagName === 'BUTTON'
    && /Quiet Notes/.test(String(node.textContent || '')))[0];
  assert.ok(entry, 'the package is not on offer');
  entry.click();

  const sheet = await waitFor(() => {
    const found = sheetWith('Install ' + PACKAGE.id);
    if (!found) return null;
    return /Messages · Read/.test(String(found.textContent || '')) ? found : null;
  });
  assert.ok(sheet, 'the consent did not open');
  assert.match(sheet.textContent, /Messages · Write/, 'the consent did not show the second capability');

  const send = findAll(sheet, classed('m-btn--primary'))[0];
  assert.ok(send, 'the consent has no way to install');
  assert.equal(send.disabled, true, 'the install is offered before the consent is answered');

  send.click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.some((call) => call.url === BASE + '/install'), false,
    'the install was sent without an answer');

  const boxes = checkboxes(sheet);
  assert.equal(boxes.length, 2, 'the consent did not offer one box per requested capability');
  boxes[0].checked = true;
  boxes[0].dispatch('change');
  send.click();

  const posted = await waitFor(() => calls.find((call) => call.url === BASE + '/install'));
  assert.ok(posted, 'the install was never sent');
  assert.deepEqual(posted.body.grants, ['messages.read'],
    'the install granted something other than the answer');
});

test('the phone asks before it lets code run on the server', async () => {
  State.user = { id: 'u1', isAdmin: true };
  const calls = installFetchStub(routes({
    [BASE + '/policy']: {
      json: {
        policy: {
          registryMode: 'builtin',
          registryUrl: null,
          allowlist: [],
          allowUnreviewed: false,
          requireSignature: false,
          allowTrusted: false,
          signingKeys: {},
        },
      },
    },
  }));

  const view = renderExtensions({ page: { id: 'extensions' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();
  tabOf(view, 'Policy');

  const control = await waitFor(() => byLabel(view.node, 'Allow code from packages')[0]);
  assert.ok(control, 'the phone has no switch about server-side code');
  assert.match(view.node.textContent, /runs it inside this instance's server process/,
    'the switch does not say what turning it on does');

  control.click();
  const confirm = await waitFor(() => {
    const found = sheets().filter((node) => String(node.textContent || '').indexOf('Allow extensions that run code on the server?') !== -1)[0];
    if (!found) return null;
    return findAll(found, classed('m-btn--danger'))[0];
  });
  assert.ok(confirm, 'the dangerous switch was turned on without asking');
  assert.equal(calls.some((call) => call.options.method === 'PUT'), false,
    'the policy was saved before the switch was confirmed');

  confirm.click();
  const saved = await waitFor(() => calls.find((call) => call.options.method === 'PUT' && call.url === BASE + '/policy'));
  assert.ok(saved, 'the confirmed switch was never saved');
  assert.equal(saved.body.allowTrusted, true, 'the switch was saved as something else');
});

test('a dry run on the phone says that nothing was done', async () => {
  State.user = { id: 'u1', isAdmin: true };
  installFetchStub(routes({
    [BASE + '/workflows']: { json: { workflows: [WORKFLOW] } },
    [BASE + '/workflows/w1']: { json: { workflow: WORKFLOW } },
    [BASE + '/workflows/w1/runs']: { json: { runs: [] } },
    [BASE + '/workflows/w1/dry-run']: {
      json: {
        run: { id: 'r8', status: 'succeeded', dryRun: true },
        plan: [{
          index: 0,
          type: 'action',
          action: 'message.send',
          capability: 'messages.write',
          status: 'planned',
          description: 'Sends a message',
          permitted: true,
          note: null,
        }],
      },
    },
  }));

  const view = renderExtensions({ page: { id: 'extensions' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();
  tabOf(view, 'Workflows');

  const entry = await waitFor(() => findAll(view.node, (node) => node.tagName === 'BUTTON'
    && /Morning note/.test(String(node.textContent || '')))[0]);
  assert.ok(entry, 'the workflow is not listed');
  entry.click();

  const dry = await waitFor(() => findAll(document.body, (node) => node.tagName === 'BUTTON'
    && String(node.textContent || '').trim() === 'Dry run')[0]);
  assert.ok(dry, 'there is no way to see what a run would do');
  dry.click();

  const sheet = await waitFor(() => {
    const found = sheetWith('What a run would do');
    if (!found) return null;
    return /Nothing was done/.test(String(found.textContent || '')) ? found : null;
  });
  assert.ok(sheet, 'the dry run said nothing');
  assert.match(sheet.textContent, /message\.send/, 'the dry run did not say what would have happened');
});

test('the phone does not offer an install to an account that may not install', async () => {
  State.user = { id: 'u2', isAdmin: false };
  installFetchStub(routes());

  const view = renderExtensions({ page: { id: 'extensions' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();

  const labels = findAll(view.node, (node) => node.getAttribute('aria-label')).map((node) => node.getAttribute('aria-label'));
  assert.equal(labels.some((label) => label.indexOf('Show the installed section') === 0), false,
    'the installed list is offered to an account that may not see it');
  assert.equal(labels.some((label) => label.indexOf('Show the policy section') === 0), false,
    'the policy is offered to an account that may not change it');
});

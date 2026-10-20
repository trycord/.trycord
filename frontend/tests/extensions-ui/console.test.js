// The extension console.
//
// The console is the only place an operator can install an extension, grant it
// a capability, take one back, decide what may be installed at all, and watch
// a workflow run. These checks are about the parts of it that are easy to get
// wrong: the consent, the grants, the dangerous switch, and the promise that a
// dry run does nothing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub, waitFor } from '../helpers/dom-stub.js';

installDomStub();

const { State } = await import('../../packages/store.js');
const { renderExtensions } = await import('../../js/features/extensions.js');

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

function tabOf(view, name) {
  const button = byLabel(view.node, 'Show the ' + name + ' section')[0];
  assert.ok(button, 'the console has no ' + name + ' section');
  button.click();
  return button;
}

function checkboxes(node) {
  return findAll(node, (entry) => entry.tagName === 'INPUT' && entry.getAttribute('type') === 'checkbox');
}

function dialogs() {
  return findAll(document.body, classed('dialog'));
}

function dialogWith(text) {
  return dialogs().filter((node) => String(node.textContent || '').indexOf(text) !== -1)[0] || null;
}

// -- the fixtures ----------------------------------------------------------------

const PACKAGE = {
  id: 'example.notes',
  name: 'Quiet Notes',
  version: '1.2.0',
  description: 'Keeps a quiet note on every message.',
  author: 'Example',
  maintainers: ['Example'],
  homepage: 'https://example.org/notes',
  entryPoint: 'notes.js',
  requestedCapabilities: ['messages.read', 'messages.write'],
  trusted: false,
  compatibility: { trycord: '>=3.0' },
  dependencies: {},
  reviewStatus: 'approved',
  signature: { keyId: 'k1', status: 'verified' },
  installable: true,
  reason: null,
};

const ENTRY = {
  id: PACKAGE.id,
  name: PACKAGE.name,
  version: PACKAGE.version,
  description: PACKAGE.description,
  author: PACKAGE.author,
  maintainers: PACKAGE.maintainers,
  homepage: PACKAGE.homepage,
  requestedCapabilities: PACKAGE.requestedCapabilities,
  trusted: false,
  reviewStatus: PACKAGE.reviewStatus,
  signature: PACKAGE.signature,
  installable: true,
  reason: null,
  invalid: null,
};

const INSTALLED = {
  id: PACKAGE.id,
  name: PACKAGE.name,
  version: PACKAGE.version,
  description: PACKAGE.description,
  author: PACKAGE.author,
  requestedCapabilities: ['messages.read', 'messages.write'],
  trusted: false,
  reviewStatus: 'approved',
  signature: PACKAGE.signature,
  state: 'enabled',
  grants: ['messages.read'],
};

const WORKFLOW = {
  id: 'w1',
  name: 'Morning note',
  description: 'Says good morning.',
  ownerId: 'u1',
  state: 'active',
  version: 2,
  trigger: { type: 'schedule', everyMs: 3600000 },
  conditions: [],
  steps: [
    { type: 'action', action: 'message.send', params: { channelId: 'c1', content: 'good morning' } },
  ],
  grants: ['messages.write'],
  limits: {},
  onError: 'stop',
  source: 'user',
  extensionId: null,
};

const RUN = {
  id: 'r1',
  workflowId: 'w1',
  status: 'failed',
  reason: 'the run failed',
  dryRun: false,
  startedAt: '2026-02-01T09:00:00.000Z',
  durationMs: 1200,
};

const RUN_STEPS = [
  {
    id: 's1',
    runId: 'r1',
    index: 0,
    type: 'action',
    action: 'message.send',
    capability: 'messages.write',
    status: 'failed',
    error: 'the channel is gone',
    durationMs: 40,
  },
];

const BASE = 'http://localhost/api/extensions';

function registryRoutes(extra) {
  return Object.assign({
    [BASE + '/registry']: { json: { registry: { source: 'builtin', available: true, extensions: [ENTRY] } } },
    [BASE + '/registry/' + PACKAGE.id]: { json: { package: PACKAGE } },
  }, extra || {});
}

// -- the tests --------------------------------------------------------------------

test('the registry lists what is on offer', async () => {
  State.user = { id: 'u1', isAdmin: true };
  const calls = installFetchStub(registryRoutes());

  const view = renderExtensions({ page: { id: 'extensions' }, params: {}, rest: [] });
  await view.onMount();

  assert.match(view.node.textContent, /Quiet Notes/,
    'the registry did not list the package');
  assert.match(view.node.textContent, /asks for 2 capabilities/,
    'the registry did not say what the package asks for');
  assert.ok(calls.some((call) => call.url === BASE + '/registry'),
    'the registry was never read');
});

test('the consent screen shows what the package asks for', async () => {
  State.user = { id: 'u1', isAdmin: true };
  installFetchStub(registryRoutes());

  const view = renderExtensions({ page: { id: 'extensions' }, params: {}, rest: [] });
  await view.onMount();

  const install = byLabel(view.node, 'Install Quiet Notes')[0];
  assert.ok(install, 'there is no way to install the package');
  install.click();

  const dialog = await waitFor(() => {
    const found = dialogWith('Install ' + PACKAGE.id);
    if (!found) return null;
    return /Messages · Read/.test(String(found.textContent || '')) ? found : null;
  });
  assert.ok(dialog, 'the consent screen did not open');
  const text = String(dialog.textContent || '');
  assert.match(text, /Quiet Notes/, 'the consent did not name the package');
  assert.match(text, /Messages · Read/, 'the consent did not show a requested capability');
  assert.match(text, /Messages · Write/, 'the consent did not show the second requested capability');
  assert.match(text, /Reviewed/, 'the consent did not show the review status');
  assert.match(text, /signed/, 'the consent did not show the signature status');
  assert.match(text, /3\.0/, 'the consent did not show the compatibility');
});

test('an install is not sent without a grant list', async () => {
  State.user = { id: 'u1', isAdmin: true };
  const calls = installFetchStub(registryRoutes({
    [BASE + '/install']: { json: { extension: INSTALLED, granted: ['messages.read'], refused: [] } },
  }));

  const view = renderExtensions({ page: { id: 'extensions' }, params: {}, rest: [] });
  await view.onMount();
  byLabel(view.node, 'Install Quiet Notes')[0].click();

  const dialog = await waitFor(() => dialogWith('Install ' + PACKAGE.id));
  const send = findAll(dialog, classed('btn--primary'))[0];
  assert.ok(send, 'the consent screen has no way to install');
  assert.equal(send.disabled, true, 'the install is offered before the consent is answered');

  send.click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.some((call) => call.url === BASE + '/install'), false,
    'the install was sent without an answer');

  // The answer: one of the two capabilities.
  const boxes = checkboxes(dialog);
  assert.equal(boxes.length, 2, 'the consent did not offer one box per requested capability');
  boxes[0].checked = true;
  boxes[0].dispatch('change');

  send.click();
  const posted = await waitFor(() => calls.find((call) => call.url === BASE + '/install'));
  assert.ok(posted, 'the install was never sent');
  assert.ok(Array.isArray(posted.body.grants), 'the install carried no grant list');
  assert.deepEqual(posted.body.grants, ['messages.read'],
    'the install granted something other than the answer');
});

test('a capability that is not granted is not offered', async () => {
  State.user = { id: 'u1', isAdmin: true };
  installFetchStub(registryRoutes({
    [BASE + '/installed']: { json: { extensions: [INSTALLED] } },
  }));

  const view = renderExtensions({ page: { id: 'extensions' }, params: {}, rest: [] });
  await view.onMount();
  tabOf(view, 'installed');

  const card = await waitFor(() => findAll(view.node, (node) => String(node.textContent || '').indexOf('Quiet Notes') !== -1)[0]);
  assert.ok(card, 'the installed extension was not listed');

  // The package asked for two; one is granted. The other may be granted, and
  // nothing that was never asked for is on offer.
  const pickers = findAll(view.node, (node) => node.tagName === 'SELECT'
    && String(node.getAttribute('aria-label') || '').indexOf('The capability to grant') === 0);
  assert.equal(pickers.length, 1, 'the console did not offer the capability that is still missing');
  const options = pickers[0].children.map((option) => option.value);
  assert.deepEqual(options, ['messages.write'],
    'the console offered a capability that was not asked for, or one that is already held');
});

test('a revoked capability stops the extension', async () => {
  State.user = { id: 'u1', isAdmin: true };
  const calls = installFetchStub(registryRoutes({
    [BASE + '/installed']: { json: { extensions: [INSTALLED] } },
    [BASE + '/' + PACKAGE.id + '/grants/messages.read']: { json: { grant: { capability: 'messages.read' } } },
  }));

  const view = renderExtensions({ page: { id: 'extensions' }, params: {}, rest: [] });
  await view.onMount();
  tabOf(view, 'installed');
  await waitFor(() => findAll(view.node, (node) => String(node.textContent || '').indexOf('Quiet Notes') !== -1)[0]);

  const take = byLabel(view.node, 'Take back Messages · Read from Quiet Notes')[0];
  assert.ok(take, 'there is no way to take a capability back');

  take.click();
  const confirm = await waitFor(() => {
    const found = dialogs().filter((node) => String(node.textContent || '').indexOf('Take this capability back?') !== -1)[0];
    if (!found) return null;
    return findAll(found, classed('btn--danger'))[0];
  });
  assert.ok(confirm, 'taking a capability back asked nothing');
  confirm.click();

  const revoked = await waitFor(() => calls.find((call) => call.options.method === 'DELETE'
    && call.url === BASE + '/' + PACKAGE.id + '/grants/messages.read'));
  assert.ok(revoked, 'the capability was never taken back');
});

test('the policy is read and saved', async () => {
  State.user = { id: 'u1', isAdmin: true };
  const calls = installFetchStub(registryRoutes({
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

  const view = renderExtensions({ page: { id: 'extensions' }, params: {}, rest: [] });
  await view.onMount();
  tabOf(view, 'policy');

  const picker = await waitFor(() => findAll(view.node, (node) => node.tagName === 'SELECT'
    && node.getAttribute('aria-label') === 'Where packages come from')[0]);
  assert.ok(picker, 'the policy did not say where packages come from');
  assert.equal(picker.value, 'builtin', 'the policy was not read');

  picker.value = 'mirror';
  picker.dispatch('change');

  const saved = await waitFor(() => calls.find((call) => call.options.method === 'PUT' && call.url === BASE + '/policy'));
  assert.ok(saved, 'the policy was never saved');
  assert.equal(saved.body.registryMode, 'mirror', 'the policy was saved as something else');
});

test('the dangerous switch says what it does, and asks before it is turned on', async () => {
  State.user = { id: 'u1', isAdmin: true };
  const calls = installFetchStub(registryRoutes({
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

  const view = renderExtensions({ page: { id: 'extensions' }, params: {}, rest: [] });
  await view.onMount();
  tabOf(view, 'policy');

  const control = await waitFor(() => byLabel(view.node, 'Allow extensions that run code on the server')[0]);
  assert.ok(control, 'the console has no switch about server-side code');
  assert.match(view.node.textContent, /runs it inside this instance's server process/,
    'the switch does not say what turning it on does');

  control.click();
  const confirm = await waitFor(() => {
    const found = dialogs().filter((node) => String(node.textContent || '').indexOf('Allow extensions that run code on the server?') !== -1)[0];
    if (!found) return null;
    return findAll(found, classed('btn--danger'))[0];
  });
  assert.ok(confirm, 'the dangerous switch was turned on without asking');
  assert.equal(calls.some((call) => call.options.method === 'PUT'), false,
    'the policy was saved before the switch was confirmed');

  confirm.click();
  const saved = await waitFor(() => calls.find((call) => call.options.method === 'PUT' && call.url === BASE + '/policy'));
  assert.ok(saved, 'the confirmed switch was never saved');
  assert.equal(saved.body.allowTrusted, true, 'the switch was saved as something else');
});

test('a workflow runs', async () => {
  State.user = { id: 'u1', isAdmin: true };
  const calls = installFetchStub(registryRoutes({
    [BASE + '/workflows']: { json: { workflows: [WORKFLOW] } },
    [BASE + '/workflows/w1']: { json: { workflow: WORKFLOW } },
    [BASE + '/workflows/w1/runs']: { json: { runs: [] } },
    [BASE + '/workflows/w1/run']: { json: { run: { id: 'r9', status: 'succeeded' } } },
  }));

  const view = renderExtensions({ page: { id: 'extensions' }, params: {}, rest: [] });
  await view.onMount();
  tabOf(view, 'workflows');

  const run = await waitFor(() => byLabel(view.node, 'Run Morning note now')[0]);
  assert.ok(run, 'there is no way to run the workflow');
  run.click();

  const sent = await waitFor(() => calls.find((call) => call.options.method === 'POST'
    && call.url === BASE + '/workflows/w1/run'));
  assert.ok(sent, 'the workflow was never run');
});

test('a dry run does nothing and says what it would have done', async () => {
  State.user = { id: 'u1', isAdmin: true };
  const calls = installFetchStub(registryRoutes({
    [BASE + '/workflows']: { json: { workflows: [WORKFLOW] } },
    [BASE + '/workflows/w1']: { json: { workflow: WORKFLOW } },
    [BASE + '/workflows/w1/runs']: { json: { runs: [] } },
    [BASE + '/workflows/w1/dry-run']: {
      json: {
        run: { id: 'r8', status: 'succeeded', dryRun: true },
        plan: [
          {
            index: 0,
            type: 'action',
            action: 'message.send',
            capability: 'messages.write',
            status: 'planned',
            description: 'Sends a message',
            permitted: true,
            note: null,
          },
        ],
      },
    },
  }));

  const view = renderExtensions({ page: { id: 'extensions' }, params: {}, rest: [] });
  await view.onMount();
  tabOf(view, 'workflows');

  const dry = await waitFor(() => byLabel(view.node, 'See what a run of Morning note would do, without doing it')[0]);
  assert.ok(dry, 'there is no way to see what a run would do');
  dry.click();

  const dialog = await waitFor(() => {
    const found = dialogWith('What a run would do');
    if (!found) return null;
    return /Nothing was done/.test(String(found.textContent || '')) ? found : null;
  });
  assert.ok(dialog, 'the dry run said nothing');
  const text = String(dialog.textContent || '');
  assert.match(text, /Nothing was done/, 'the dry run did not say that nothing was done');
  assert.match(text, /message\.send/, 'the dry run did not say what would have happened');
  assert.equal(calls.some((call) => call.options.method === 'POST' && call.url === BASE + '/workflows/w1/run'), false,
    'the dry run ran the workflow');
});

test('a run that is waiting can be approved', async () => {
  State.user = { id: 'u1', isAdmin: true };
  const waiting = Object.assign({}, RUN, { status: 'awaiting_approval', reason: 'waiting for an approval' });
  const calls = installFetchStub(registryRoutes({
    [BASE + '/workflows']: { json: { workflows: [WORKFLOW] } },
    [BASE + '/workflows/w1']: { json: { workflow: WORKFLOW } },
    [BASE + '/workflows/w1/runs']: { json: { runs: [waiting] } },
    [BASE + '/workflows/runs/r1']: { json: { run: waiting, steps: [] } },
    [BASE + '/workflows/runs/r1/approve']: { json: { ok: true, status: 'succeeded' } },
  }));

  const view = renderExtensions({ page: { id: 'extensions' }, params: {}, rest: [] });
  await view.onMount();
  tabOf(view, 'workflows');

  const approve = await waitFor(() => byLabel(view.node, 'Approve the run of Morning note that is waiting')[0]);
  assert.ok(approve, 'a waiting run was not offered for approval');
  approve.click();

  const confirm = await waitFor(() => {
    const found = dialogs().filter((node) => String(node.textContent || '').indexOf('Approve this run?') !== -1)[0];
    if (!found) return null;
    return findAll(found, classed('btn--primary'))[0];
  });
  assert.ok(confirm, 'approving a run asked nothing');
  confirm.click();

  const sent = await waitFor(() => calls.find((call) => call.options.method === 'POST'
    && call.url === BASE + '/workflows/runs/r1/approve'));
  assert.ok(sent, 'the run was never approved');
  assert.equal(sent.body.approved, true, 'the run was not approved');
});

test('the history shows the reason a step failed', async () => {
  State.user = { id: 'u1', isAdmin: true };
  installFetchStub(registryRoutes({
    [BASE + '/workflows']: { json: { workflows: [WORKFLOW] } },
    [BASE + '/workflows/w1']: { json: { workflow: WORKFLOW } },
    [BASE + '/workflows/w1/runs']: { json: { runs: [RUN] } },
    [BASE + '/workflows/runs/r1']: { json: { run: RUN, steps: RUN_STEPS } },
  }));

  const view = renderExtensions({ page: { id: 'extensions' }, params: {}, rest: [] });
  await view.onMount();
  tabOf(view, 'workflows');

  await waitFor(() => byLabel(view.node, 'See the steps of the run of Morning note')[0]);
  byLabel(view.node, 'See the steps of the run of Morning note')[0].click();

  const dialog = await waitFor(() => {
    const found = dialogWith('One run');
    if (!found) return null;
    return /the channel is gone/.test(String(found.textContent || '')) ? found : null;
  });
  assert.ok(dialog, 'the run did not open');
  const text = String(dialog.textContent || '');
  assert.match(text, /the channel is gone/, 'the history did not say why the step failed');
  assert.match(text, /the run failed/, 'the history did not say why the run ended');
});

test('the controls an account may not use are not offered', async () => {
  State.user = { id: 'u2', isAdmin: false };
  installFetchStub(registryRoutes({
    [BASE + '/workflows']: { json: { workflows: [] } },
  }));

  const view = renderExtensions({ page: { id: 'extensions' }, params: {}, rest: [] });
  await view.onMount();

  const labels = findAll(view.node, (node) => node.getAttribute('aria-label')).map((node) => node.getAttribute('aria-label'));
  assert.equal(labels.some((label) => label.indexOf('Show the installed section') === 0), false,
    'the installed list is offered to an account that may not see it');
  assert.equal(labels.some((label) => label.indexOf('Show the policy section') === 0), false,
    'the policy is offered to an account that may not change it');
  assert.equal(byLabel(view.node, 'Install Quiet Notes').length, 0,
    'an install is offered to an account that may not install');
});

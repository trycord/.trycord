// The incident timeline.
//
// An operator posts an incident with a status, a summary and a note under it,
// and moves it on as it is looked at, understood, watched and closed. What is
// written is what the status page shows, so the reader's view shows exactly
// what the operator wrote and nothing else.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub, waitFor } from './helpers/dom-stub.js';

installDomStub();

const { setToken } = await import('../packages/api.js');
const { adminIncidents } = await import('../js/features/adminIncidents.js');
const { renderStatus } = await import('../js/features/status.js');

function find(node, predicate, found = []) {
  if (!node) return found;
  if (Array.isArray(node)) {
    for (const entry of node) find(entry, predicate, found);
    return found;
  }
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

function classed(word) {
  return (node) => {
    const value = node.getAttribute && node.getAttribute('class');
    return !!value && value.split(/\s+/).indexOf(word) !== -1;
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const INCIDENT = {
  id: 'i1',
  kind: 'incident',
  status: 'investigating',
  title: 'Messages are slow to arrive',
  summary: 'Some messages are taking longer than usual to arrive.',
  body: 'We are looking at it.',
  startedAt: '2026-02-01T09:00:00.000Z',
};

test('an operator writes an incident and it is listed', async () => {
  setToken('reader-a');
  const calls = installFetchStub({
    'http://localhost/api/incidents?limit=100': { json: [] },
    'http://localhost/api/incidents': { json: INCIDENT },
  });

  const view = adminIncidents();
  await view.onMount();

  const form = find(view.node, (node) => node.tagName === 'FORM')[0];
  assert.ok(form, 'the console has no form to write an incident in');
  const selects = find(form, (node) => node.tagName === 'SELECT');
  selects[0].value = 'incident';
  selects[1].value = 'investigating';
  const fields = find(form, (node) => node.tagName === 'INPUT' || node.tagName === 'TEXTAREA');
  fields[0].value = INCIDENT.title;
  fields[1].value = INCIDENT.summary;
  fields[2].value = INCIDENT.body;

  form.submit();

  const posted = await waitFor(() => calls.find((call) => call.url.indexOf('/api/incidents') !== -1
    && call.options.method === 'POST'));
  assert.ok(posted, 'the incident was never posted');
  assert.equal(posted.body.title, INCIDENT.title);
  assert.equal(posted.body.summary, INCIDENT.summary);
  assert.equal(posted.body.status, 'investigating');
});

test('an operator can close an incident', async () => {
  setToken('reader-a');
  const calls = installFetchStub({
    'http://localhost/api/incidents?limit=100': { json: [INCIDENT] },
    'http://localhost/api/incidents/i1': { json: Object.assign({}, INCIDENT, { status: 'resolved' }) },
  });

  const view = adminIncidents();
  await view.onMount();

  const close = await waitFor(() => find(view.node, (node) => node.tagName === 'BUTTON'
    && String(node.textContent).trim() === 'Close')[0]);
  assert.ok(close, 'there is no way to close an incident');
  close.click();

  // The confirmation is a dialog of its own, so the answer is given there.
  const confirm = await waitFor(() => {
    const dialog = find(document.body, classed('dialog'))
      .filter((node) => String(node.textContent).indexOf('Close it') !== -1)[0];
    if (!dialog) return null;
    return find(dialog, (node) => node.tagName === 'BUTTON'
      && String(node.textContent).indexOf('Close it') !== -1)[0];
  });
  assert.ok(confirm, 'closing an incident asked nothing');
  confirm.click();

  const patched = await waitFor(() => calls.find((call) => call.url.indexOf('/api/incidents/i1') !== -1
    && call.options.method === 'PATCH'));
  assert.ok(patched, 'the incident was never closed');
  assert.deepEqual(patched.body, { status: 'resolved' });
});

test('a reader sees what the operator wrote', async () => {
  installFetchStub({
    'http://localhost/api/incidents/status?limit=50': {
      json: {
        incidents: [INCIDENT],
        maintenance: [],
        openIncidents: 1,
        summary: '1 open incident(s)',
      },
    },
  });

  const view = renderStatus({ page: { id: 'status' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();
  await wait(20);

  const text = view.node.textContent || '';
  assert.match(text, /Messages are slow to arrive/, 'the incident was not shown');
  assert.match(text, /Some messages are taking longer than usual/, 'the summary was not shown');
  assert.match(text, /We are looking at it/, 'the note was not shown');
  assert.match(text, /Being looked at/, 'the status was not shown');
});

test('an instance with nothing recorded says so', async () => {
  installFetchStub({
    'http://localhost/api/incidents/status?limit=50': {
      json: { incidents: [], maintenance: [], openIncidents: 0, summary: 'No incidents have been recorded.' },
    },
  });

  const view = renderStatus({ page: { id: 'status' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();
  await wait(20);

  const text = view.node.textContent || '';
  assert.match(text, /No incidents have been recorded/);
  assert.equal(text.indexOf('Everything is fine'), -1,
    'the page claimed something the operator did not write');
});

test('an instance that publishes no status page says that', async () => {
  installFetchStub({
    'http://localhost/api/incidents/status?limit=50': {
      ok: false,
      status: 404,
      json: { error: { code: 'NOT_FOUND', message: 'the status page is not published' } },
    },
  });

  const view = renderStatus({ page: { id: 'status' }, query: new URLSearchParams(), params: {}, rest: [] });
  await view.onMount();
  await wait(20);

  assert.match(view.node.textContent || '', /publishes no status page/);
});

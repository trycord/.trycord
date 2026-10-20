// The operational incident timeline.
//
// An operator posts an incident, the status page shows it, and the status
// page shows nothing else: what an operator wrote, and an honest answer
// when there is nothing.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startRouted, registerUser, makeAdmin } = require('../support/harness');

test('the incident timeline', async (t) => {
  const ws = await startRouted();
  t.after(() => ws.stop());

  const admin = await registerUser(ws, 'operator');
  await makeAdmin(ws, admin.user.id);
  const reader = await registerUser(ws, 'reader');

  let incidentId = null;

  await t.test('a status page with nothing recorded says so', async () => {
    const res = await reader.get('/api/incidents/status');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(res.data.incidents, []);
    assert.deepEqual(res.data.maintenance, []);
    assert.equal(res.data.summary, 'No incidents have been recorded.');
  });

  await t.test('an ordinary reader cannot post an incident', async () => {
    const res = await reader.post('/api/incidents', {
      title: 'Not mine to post',
      summary: 'A reader tried to post an incident.',
    });
    assert.equal(res.status, 403);
  });

  await t.test('an operator posts an incident', async () => {
    const res = await admin.post('/api/incidents', {
      title: 'Messages are slow to send',
      summary: 'Sends to one region are taking several seconds.',
      status: 'investigating',
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.title, 'Messages are slow to send');
    assert.equal(res.data.status, 'investigating');
    assert.ok(res.data.startedAt, 'the incident says when it happened');
    incidentId = res.data.id;
  });

  await t.test('the status page shows exactly what was written', async () => {
    const res = await reader.get('/api/incidents');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.length, 1);
    assert.equal(res.data[0].id, incidentId);
    assert.equal(res.data[0].title, 'Messages are slow to send');
    assert.equal(res.data[0].summary, 'Sends to one region are taking several seconds.');
    assert.equal(res.data[0].status, 'investigating');

    const status = await reader.get('/api/incidents/status');
    assert.equal(status.data.openIncidents, 1);
    assert.equal(status.data.summary, '1 open incident(s)');
  });

  await t.test('the incident is moved on and closed', async () => {
    const identified = await admin.patch('/api/incidents/' + incidentId, { status: 'identified' });
    assert.equal(identified.status, 200, JSON.stringify(identified.data));
    assert.equal(identified.data.status, 'identified');

    const monitoring = await admin.patch('/api/incidents/' + incidentId, { status: 'monitoring' });
    assert.equal(monitoring.data.status, 'monitoring');

    const resolved = await admin.patch('/api/incidents/' + incidentId, { status: 'resolved' });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.data));
    assert.equal(resolved.data.status, 'resolved');
    assert.ok(resolved.data.resolvedAt, 'a closed incident says when it was closed');

    const status = await reader.get('/api/incidents/status');
    assert.equal(status.data.openIncidents, 0);
  });

  await t.test('a planned maintenance notice is the same thing with a date', async () => {
    const res = await admin.post('/api/incidents', {
      kind: 'maintenance',
      title: 'Database upgrade',
      summary: 'The database will be upgraded and the instance will be unavailable.',
      scheduledFor: '2026-12-01T09:00:00.000Z',
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.kind, 'maintenance');
    assert.equal(res.data.status, 'scheduled');
    assert.equal(res.data.scheduledFor, '2026-12-01T09:00:00.000Z');

    const status = await reader.get('/api/incidents/status');
    assert.equal(status.data.maintenance.length, 1);
    assert.equal(status.data.maintenance[0].title, 'Database upgrade');
    assert.equal(status.data.incidents.length, 1, 'the maintenance notice is not an incident');
  });

  await t.test('an incident needs a title and a summary', async () => {
    const res = await admin.post('/api/incidents', { summary: 'No title at all.' });
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /title/);
  });

  await t.test('a status this build does not know is refused', async () => {
    const res = await admin.patch('/api/incidents/' + incidentId, { status: 'mostly fine' });
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /investigating/);
  });
});

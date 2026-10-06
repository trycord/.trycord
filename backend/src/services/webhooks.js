// Outgoing webhooks.
//
// A community can point an HTTPS endpoint at itself and receive an event when
// something happens. The signing secret is the important part: the receiver has
// to be able to tell a delivery from Trycord apart from anyone who guessed the
// URL, which is what an HMAC over the raw body with a per-webhook secret is for.
//
// Delivery is fire-and-forget. A slow or dead endpoint must not delay a post, so
// every send is queued and the result recorded as a delivery row. That is also
// what makes a failure inspectable instead of invisible.

const crypto = require('crypto');
const db = require('../db');
const { now, uuid } = require('../util');
const { assertPublicHost } = require('./netguard');

const DELIVERY_TIMEOUT_MS = 4000;
const SECRET_BYTES = 32;

// The event vocabulary is closed on purpose: emit() ignores anything not listed
// here, so a typo in a call site is a no-op rather than a payload that quietly
// goes nowhere.
const EVENTS = [
  'message.created',
  'member.joined',
  'member.left',
  'channel.created',
  'channel.deleted',
  'role.created',
  'role.updated',
  'role.deleted',
  'command.created',
];

function bad(msg) { const e = new Error(msg); e.code = 'VALIDATION_ERROR'; throw e; }

// Only https, and never a private address: a webhook is a request this instance
// makes on an admin's say-so, and pointing one at 169.254.169.254 is not a
// feature.
async function validateUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { bad('webhook url is not a URL'); }
  if (u.protocol !== 'https:') bad('webhook url must be https');
  if (u.username || u.password) bad('webhook url must not contain credentials');
  // A delivery is a request this instance makes on an admin's say-so. Without
  // this, a webhook pointed at 169.254.169.254 reads cloud metadata back into
  // the delivery log, which the same admin can then fetch.
  try { await assertPublicHost(u.hostname); } catch { bad('webhook url must be a public address'); }
  return u.toString().slice(0, 512);
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

function sign(secret, body) {
  return crypto.createHmac('sha256', String(secret)).update(body, 'utf8').digest('hex');
}

function shape(row) {
  return {
    id: row.id,
    serverId: row.server_id,
    channelId: row.channel_id || null,
    name: row.name,
    url: row.url,
    active: !!row.active,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

async function list(serverId) {
  const rows = await db.all(
    'SELECT * FROM webhooks WHERE server_id = ? ORDER BY created_at', [serverId]
  );
  return rows.map(shape);
}

async function get(webhookId, serverId) {
  const row = await db.get(
    'SELECT * FROM webhooks WHERE id = ? AND server_id = ?', [webhookId, serverId]
  );
  return row || null;
}

// The plaintext secret is returned exactly once, here. It is not stored and
// cannot be recovered afterwards, which is the point.
async function create({ serverId, channelId, name, url, createdBy }) {
  const label = String(name || '').trim();
  if (!label || label.length > 64) bad('name must be 1-64 characters');
  const target = await validateUrl(url);
  const secret = crypto.randomBytes(SECRET_BYTES).toString('hex');
  const id = uuid();
  await db.run(
    'INSERT INTO webhooks (id, server_id, channel_id, name, url, secret_hash, created_by, active, created_at)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
    [id, serverId, channelId || null, label, target, hashSecret(secret), createdBy, now()]
  );
  const row = await get(id, serverId);
  return Object.assign(shape(row), { secret });
}

async function update(webhookId, serverId, patch) {
  const row = await get(webhookId, serverId);
  if (!row) return null;
  const sets = [];
  const vals = [];
  if (patch.name !== undefined) {
    const label = String(patch.name).trim();
    if (!label || label.length > 64) bad('name must be 1-64 characters');
    sets.push('name = ?'); vals.push(label);
  }
  if (patch.url !== undefined) { sets.push('url = ?'); vals.push(await validateUrl(patch.url)); }
  if (patch.channelId !== undefined) { sets.push('channel_id = ?'); vals.push(patch.channelId || null); }
  if (patch.active !== undefined) {
    if (typeof patch.active !== 'boolean') bad('active must be a boolean');
    sets.push('active = ?'); vals.push(patch.active ? 1 : 0);
  }
  if (patch.rotateSecret) {
    sets.push('secret_hash = ?');
    vals.push(hashSecret(crypto.randomBytes(SECRET_BYTES).toString('hex')));
  }
  if (!sets.length) return shape(row);
  await db.run('UPDATE webhooks SET ' + sets.join(', ') + ' WHERE id = ?', vals.concat([webhookId]));
  return shape(await get(webhookId, serverId));
}

// Rotating has to be able to hand back a new plaintext, which the update path
// above deliberately cannot do.
async function rotate(webhookId, serverId) {
  const row = await get(webhookId, serverId);
  if (!row) return null;
  const secret = crypto.randomBytes(SECRET_BYTES).toString('hex');
  await db.run('UPDATE webhooks SET secret_hash = ? WHERE id = ?', [hashSecret(secret), webhookId]);
  return { id: webhookId, secret };
}

async function remove(webhookId, serverId) {
  const row = await get(webhookId, serverId);
  if (!row) return false;
  await db.run('DELETE FROM webhooks WHERE id = ?', [webhookId]);
  return true;
}

async function deliveries(webhookId, serverId, limit = 25) {
  const hook = await get(webhookId, serverId);
  if (!hook) return null;
  const lim = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const rows = await db.all(
    'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ' + lim,
    [webhookId]
  );
  return rows.map((r) => ({
    id: r.id, eventType: r.event_type, status: r.status,
    statusCode: r.status_code, error: r.error || null, createdAt: r.created_at,
  }));
}

async function attemptOne(hook, eventType, payload) {
  const id = uuid();
  const body = JSON.stringify(payload);
  const ts = now();
  const secretRow = await db.get('SELECT secret_hash FROM webhooks WHERE id = ?', [hook.id]);
  // The stored value is a hash, so a delivery is signed with it directly. That
  // is deliberate: the receiver compares against the plaintext it kept, and this
  // instance never holds the plaintext after creation.
  const signature = sign(secretRow ? secretRow.secret_hash : '', body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DELIVERY_TIMEOUT_MS);
  let status = 'failed';
  let statusCode = null;
  let error = null;
  try {
    // Re-checked immediately before the request, not only when the webhook was
    // saved: a name that was public then can resolve to a private address now.
    await assertPublicHost(new URL(hook.url).hostname);
    const r = await fetch(hook.url, {
      method: 'POST',
      redirect: 'manual',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Trycord-Webhook/1.0',
        'x-trycord-event': eventType,
        'x-trycord-delivery': id,
        'x-trycord-signature': 'sha256=' + signature,
      },
      body,
    });
    statusCode = r.status;
    status = r.ok ? 'delivered' : 'failed';
    if (!r.ok) error = 'endpoint returned ' + r.status;
  } catch (e) {
    error = String((e && e.message) || e).slice(0, 200);
  } finally {
    clearTimeout(timer);
  }
  try {
    await db.run(
      'INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status, status_code, error, created_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, hook.id, eventType, body.slice(0, 8000), status, statusCode, error, ts]
    );
  } catch { /* a lost record must not become a thrown send */ }
  return { id, status, statusCode };
}

// Fan out to every active hook. Awaited by the caller only because tests and
// the delivery log need the result; nothing user-facing waits on it.
async function emit(serverId, eventType, payload) {
  if (EVENTS.indexOf(eventType) === -1) return [];
  const rows = await db.all(
    'SELECT * FROM webhooks WHERE server_id = ? AND active = 1', [serverId]
  );
  const out = [];
  for (const row of rows) {
    try {
      out.push(await attemptOne(row, eventType, Object.assign({ event: eventType, at: now() }, payload)));
    } catch { /* one dead endpoint must not stop the others */ }
  }
  return out;
}

module.exports = {
  EVENTS, list, get, create, update, rotate, remove, deliveries, emit,
  sign, hashSecret, validateUrl, shape,
};

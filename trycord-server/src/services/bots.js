// Bot applications and slash commands.
//
// An application is created by a community administrator, gets a bearer token
// shown once, and can then post as itself and answer slash commands. The token
// is stored hashed for the same reason the webhook secret is: it is a
// credential, and a database read should not be enough to impersonate a bot.
//
// A bot post is a real message with a real author, so it flows through the same
// broadcast, the same attachment pipeline and the same permission evaluation as
// anything else. There is no second message path.

const crypto = require('crypto');
const db = require('../db');
const { now, uuid } = require('../util');
const events = require('./events');

const TOKEN_PREFIX = 'trcd_bot_';
const COMMAND_RE = /^\/([a-z0-9][a-z0-9_-]{0,31})$/i;

function bad(msg) { const e = new Error(msg); e.code = 'VALIDATION_ERROR'; throw e; }

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function appShape(r) {
  return {
    id: r.id,
    serverId: r.server_id,
    ownerUserId: r.owner_user_id,
    name: r.name,
    createdAt: r.created_at,
  };
}

function commandShape(r) {
  return {
    id: r.id,
    applicationId: r.application_id,
    name: r.name,
    description: r.description || null,
    response: r.response,
    createdAt: r.created_at,
  };
}

async function listApps(serverId) {
  const rows = await db.all(
    'SELECT * FROM bot_applications WHERE server_id = ? ORDER BY created_at', [serverId]
  );
  return rows.map(appShape);
}

async function getApp(appId, serverId) {
  if (!serverId) return db.get('SELECT * FROM bot_applications WHERE id = ?', [appId]);
  const row = await db.get(
    'SELECT * FROM bot_applications WHERE id = ? AND server_id = ?', [appId, serverId]
  );
  return row || null;
}

async function createApp({ serverId, ownerUserId, name }) {
  const label = String(name || '').trim();
  if (!label || label.length > 64) bad('name must be 1-64 characters');
  const id = uuid();
  const token = TOKEN_PREFIX + crypto.randomBytes(24).toString('hex');
  await db.run(
    'INSERT INTO bot_applications (id, owner_user_id, server_id, name, token_hash, created_at)' +
    ' VALUES (?, ?, ?, ?, ?, ?)',
    [id, ownerUserId, serverId, label, hashToken(token), now()]
  );
  const row = await getApp(id, serverId);
  return Object.assign(appShape(row), { token });
}

async function removeApp(appId, serverId) {
  const row = await getApp(appId, serverId);
  if (!row) return false;
  await db.run('DELETE FROM bot_applications WHERE id = ?', [appId]);
  return true;
}

async function listCommands(appId) {
  const rows = await db.all(
    'SELECT * FROM bot_commands WHERE application_id = ? ORDER BY name', [appId]
  );
  return rows.map(commandShape);
}

async function setCommand(appId, input) {
  const app = await db.get('SELECT * FROM bot_applications WHERE id = ?', [appId]);
  if (!app) return null;
  const name = String((input && input.name) || '').trim().toLowerCase();
  if (!COMMAND_RE.exec('/' + name)) {
    bad('command name must be 1-32 letters, digits, dash or underscore');
  }
  const response = String((input && input.response) || '');
  if (!response || response.length > 2000) bad('response must be 1-2000 characters');
  const desc = input.description == null ? null : String(input.description).slice(0, 255);
  const existing = await db.get(
    'SELECT * FROM bot_commands WHERE application_id = ? AND name = ?', [appId, name]
  );
  if (existing) {
    await db.run(
      'UPDATE bot_commands SET description = ?, response = ? WHERE id = ?',
      [desc, response, existing.id]
    );
    return commandShape(await db.get('SELECT * FROM bot_commands WHERE id = ?', [existing.id]));
  }
  const id = uuid();
  await db.run(
    'INSERT INTO bot_commands (id, application_id, name, description, response, created_at)' +
    ' VALUES (?, ?, ?, ?, ?, ?)',
    [id, appId, name, desc, response, now()]
  );
  return commandShape(await db.get('SELECT * FROM bot_commands WHERE id = ?', [id]));
}

async function removeCommand(commandId, appId) {
  const row = await db.get(
    'SELECT * FROM bot_commands WHERE id = ? AND application_id = ?', [commandId, appId]
  );
  if (!row) return false;
  await db.run('DELETE FROM bot_commands WHERE id = ?', [commandId]);
  return true;
}

// The bearer token identifies the application. Constant-time compare, because a
// token guess is still a token guess.
async function appByToken(token) {
  const raw = String(token || '');
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const want = hashToken(raw);
  const rows = await db.all('SELECT * FROM bot_applications');
  for (const r of rows) {
    const got = String(r.token_hash || '');
    if (got.length !== want.length) continue;
    if (crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return r;
  }
  return null;
}

// A command is matched on the first word of a message. Returns the response to
// post, or null when nothing answers.
async function resolveCommand(serverId, content) {
  const text = String(content || '').trim();
  const first = text.split(/\s+/)[0] || '';
  const m = COMMAND_RE.exec(first);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const row = await db.get(
    `SELECT c.* FROM bot_commands c
     JOIN bot_applications a ON a.id = c.application_id
     WHERE a.server_id = ? AND c.name = ?
     ORDER BY c.created_at LIMIT 1`,
    [serverId, name]
  );
  return row ? { appId: row.application_id, response: row.response, name } : null;
}

// The one way an application posts. Both the bot HTTP API and a slash-command
// reply go through here, so a bot message is written and broadcast exactly the
// way a user message is, and there is no second insert path to keep correct.
async function postAsApp(app, channelRow, content, { kind } = {}) {
  const text = String(content || '').trim().slice(0, 2000);
  if (!text) return null;
  const id = uuid();
  const ts = now();
  const seqRow = await db.get('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE channel_id = ?', [channelRow.id]);
  const seq = (seqRow ? Number(seqRow.m) : 0) + 1;
  await db.run(
    'INSERT INTO messages (id, channel_id, author_id, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)',
    [id, channelRow.id, app.owner_user_id, text, ts, seq]
  );
  events.emitChannel(channelRow.server_id, channelRow.id, {
    type: 'message',
    id, channel_id: channelRow.id, server_id: channelRow.server_id,
    author_id: app.owner_user_id,
    content: text, created_at: ts, edited_at: null, seq,
    attachments: [], reactions: [], pinned: false, reply_count: 0, thread_root_id: null,
    embeds: [],
    bot: { applicationId: app.id, name: app.name, kind: kind || 'app' },
  });
  return { id, channel_id: channelRow.id, author_id: app.owner_user_id, content: text, created_at: ts, seq };
}

// A slash command: post the configured answer as the application.
async function respond(serverId, channelRow, commandName) {
  // Accepts "/ping" or "ping": callers naturally have the slash already, and
  // prefixing a second one makes every lookup miss silently.
  const name = String(commandName || '').replace(/^\/+/, '');
  const hit = await resolveCommand(serverId, '/' + name);
  if (!hit) return null;
  const app = await db.get('SELECT * FROM bot_applications WHERE id = ?', [hit.appId]);
  if (!app) return null;
  return postAsApp(app, channelRow, hit.response, { kind: 'command' });
}

module.exports = {
  TOKEN_PREFIX,
  listApps, getApp, createApp, removeApp,
  listCommands, setCommand, removeCommand,
  appByToken, resolveCommand, postAsApp, respond, hashToken, appShape, commandShape, bad,
};
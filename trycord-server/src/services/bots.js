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
const { publicMediaUrl } = require('./embeds');

const TOKEN_PREFIX = 'trcd_bot_';
const COMMAND_RE = /^\/([a-z0-9][a-z0-9_-]{0,31})$/i;
// The same ceiling the message path enforces, so a templated reply cannot become
// the one way to write a message the HTTP post would refuse.
const MAX_RESPONSE = 2000;

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
    description: r.description || null,
    iconUrl: r.icon_url || null,
    status: r.status || 'active',
    // Deliberately absent: token_hash. No read path returns it.
    createdAt: r.created_at,
    updatedAt: r.updated_at || r.created_at,
  };
}

function commandShape(r) {
  return {
    id: r.id,
    applicationId: r.application_id,
    name: r.name,
    description: r.description || null,
    response: r.response,
    options: readOptions(r.options),
    createdAt: r.created_at,
    updatedAt: r.updated_at || r.created_at,
  };
}

// The declared argument list. Read defensively: the column is free text, so a
// hand-edited row must not be able to crash the command list for every caller.
function readOptions(raw) {
  if (!raw) return [];
  try {
    const out = JSON.parse(raw);
    return Array.isArray(out) ? out : [];
  } catch { return []; }
}

// Argument declarations are validated here rather than at send time, so a
// malformed command is refused where it is created. Names are what a caller
// passes, so they are constrained to something that can be typed in a message.
const OPTION_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const OPTION_TYPES = ['string', 'number', 'boolean', 'choice'];

function normaliseOptions(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) bad('options must be an array');
  if (input.length > 5) bad('a command may declare at most 5 options');
  const seen = new Set();
  const out = [];
  for (const o of input) {
    const name = String((o && o.name) || '').trim().toLowerCase();
    if (!OPTION_NAME_RE.test(name)) bad('option name must be 1-32 letters, digits, dash or underscore');
    if (seen.has(name)) bad('duplicate option name: ' + name);
    seen.add(name);
    const type = String((o && o.type) || 'string').toLowerCase();
    if (!OPTION_TYPES.includes(type)) bad('option type must be one of ' + OPTION_TYPES.join(', '));
    let choices = null;
    if (type === 'choice') {
      const list = Array.isArray(o.choices) ? o.choices : [];
      if (!list.length) bad('a choice option needs at least one choice');
      if (list.length > 25) bad('a choice option may declare at most 25 choices');
      choices = list.map((c) => String(c).slice(0, 64));
    }
    out.push({
      name,
      type,
      required: o.required === true,
      description: o.description ? String(o.description).slice(0, 255) : null,
      choices,
    });
  }
  return out;
}

// Binds a typed argument list to the declaration. Unknown names and missing
// required ones are refused; the caller cannot pass a value the command did not
// declare, which is what keeps the declaration meaningful.
function bindArguments(options, tokens) {
  const byName = new Map(options.map((o) => [o.name, o]));
  const bound = {};
  for (const token of tokens) {
    const eq = token.indexOf('=');
    const key = (eq === -1 ? token : token.slice(0, eq)).toLowerCase();
    if (!byName.has(key)) bad('unknown option: ' + key);
    if (Object.prototype.hasOwnProperty.call(bound, key)) bad('repeated option: ' + key);
    const spec = byName.get(key);
    const raw = eq === -1 ? '' : token.slice(eq + 1);
    bound[key] = coerce(spec, raw);
  }
  for (const o of options) {
    if (o.required && !Object.prototype.hasOwnProperty.call(bound, o.name)) {
      bad('missing required option: ' + o.name);
    }
  }
  return bound;
}

function coerce(spec, raw) {
  if (spec.type === 'boolean') {
    const v = raw.toLowerCase();
    if (v === '' || v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    bad(spec.name + ' expects true or false');
  }
  if (spec.type === 'number') {
    if (!/^-?\d+(\.\d+)?$/.test(raw)) bad(spec.name + ' expects a number');
    const n = Number(raw);
    if (!Number.isFinite(n)) bad(spec.name + ' expects a number');
    return n;
  }
  if (spec.type === 'choice') {
    if (!spec.choices.includes(raw)) bad(spec.name + ' must be one of: ' + spec.choices.join(', '));
    return raw;
  }
  if (raw.length > 500) bad(spec.name + ' must be 500 characters or fewer');
  return raw;
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

async function createApp({ serverId, ownerUserId, name, description, iconUrl }) {
  const label = String(name || '').trim();
  if (!label || label.length > 64) bad('name must be 1-64 characters');
  const desc = description == null ? null : String(description).trim().slice(0, 500) || null;
  // An icon is a URL the reader's browser will load, so it goes through the same
  // guard as a preview image rather than being trusted because an admin typed it.
  let icon = null;
  if (iconUrl) {
    icon = await publicMediaUrl(iconUrl, null);
    if (!icon) bad('iconUrl must be a public http or https address');
  }
  const id = uuid();
  const token = TOKEN_PREFIX + crypto.randomBytes(24).toString('hex');
  const ts = now();
  await db.run(
    'INSERT INTO bot_applications'
    + ' (id, owner_user_id, server_id, name, description, icon_url, status, token_hash, created_at, updated_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, ownerUserId, serverId, label, desc, icon, 'active', hashToken(token), ts, ts]
  );
  const row = await getApp(id, serverId);
  // The token is the only time it exists in plaintext.
  return Object.assign(appShape(row), { token });
}

async function updateApp(appId, serverId, patch) {
  const app = await getApp(appId, serverId);
  if (!app) return null;
  const sets = [];
  const vals = [];
  if (patch.name !== undefined) {
    const label = String(patch.name || '').trim();
    if (!label || label.length > 64) bad('name must be 1-64 characters');
    sets.push('name = ?'); vals.push(label);
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    vals.push(patch.description == null ? null : (String(patch.description).trim().slice(0, 500) || null));
  }
  if (patch.iconUrl !== undefined) {
    const icon = patch.iconUrl == null ? null : await publicMediaUrl(patch.iconUrl, null);
    if (patch.iconUrl != null && !icon) bad('iconUrl must be a public http or https address');
    sets.push('icon_url = ?'); vals.push(icon);
  }
  if (patch.status !== undefined) {
    const status = String(patch.status || '').toLowerCase();
    if (status !== 'active' && status !== 'disabled') bad('status must be active or disabled');
    sets.push('status = ?'); vals.push(status);
  }
  if (sets.length) {
    sets.push('updated_at = ?'); vals.push(now());
    vals.push(appId);
    await db.run('UPDATE bot_applications SET ' + sets.join(', ') + ' WHERE id = ?', vals);
  }
  return appShape(await getApp(appId, serverId));
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
  const options = JSON.stringify(normaliseOptions(input.options));
  const ts = now();
  const existing = await db.get(
    'SELECT * FROM bot_commands WHERE application_id = ? AND name = ?', [appId, name]
  );
  if (existing) {
    await db.run(
      'UPDATE bot_commands SET description = ?, response = ?, options = ?, updated_at = ? WHERE id = ?',
      [desc, response, options, ts, existing.id]
    );
    return commandShape(await db.get('SELECT * FROM bot_commands WHERE id = ?', [existing.id]));
  }
  const id = uuid();
  await db.run(
    'INSERT INTO bot_commands'
    + ' (id, application_id, name, description, response, options, created_at, updated_at)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, appId, name, desc, response, options, ts, ts]
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
  // options has to come along: the declaration is what the arguments are bound
  // against, and a lookup that dropped it would make every command look as
  // though it took none, so every argument would be "unknown".
  return row
    ? { appId: row.application_id, response: row.response, name, options: row.options || null }
    : null;
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

// A slash command: bind the declared options, then post the configured answer.
//
// The response is a template, not a script. Only names the command actually
// declared are substituted, so a response cannot reach into anything the
// declaration did not name, and the result is length-capped like any other
// message. There is no expression evaluation and no eval anywhere on this path.
function substitute(template, bound) {
  const text = String(template);
  // {name} and {name:default}. An unknown placeholder is left as written, so a
  // response containing a literal brace is not silently emptied.
  return text.replace(/\{(\w+)(?::([^}]*))?\}/g, (whole, key, fallback) => {
    const has = Object.prototype.hasOwnProperty.call(bound, key);
    if (!has) return fallback === undefined ? whole : fallback;
    const v = bound[key];
    return v === true ? 'true' : v === false ? 'false' : String(v);
  }).slice(0, MAX_RESPONSE);
}

async function respond(serverId, channelRow, invocation) {
  // Accepts "/ping" or "ping", plus any trailing arguments: callers naturally
  // have the slash already, and prefixing a second one makes every lookup miss.
  const parts = String(invocation || '').trim().split(/\s+/).filter(Boolean);
  const head = (parts[0] || '').replace(/^\/+/, '');
  const hit = await resolveCommand(serverId, '/' + head);
  if (!hit) return null;
  const app = await db.get('SELECT * FROM bot_applications WHERE id = ?', [hit.appId]);
  if (!app) return null;
  // A disabled application answers nobody. Its commands stay listed so an
  // administrator can see what exists, but it stops posting.
  if ((app.status || 'active') !== 'active') return null;

  let reply;
  try {
    const args = bindArguments(readOptions(hit.options), parts.slice(1));
    reply = substitute(hit.response, args);
  } catch (e) {
    // A bad invocation answers with the reason rather than silently doing
    // nothing, so the person who typed it learns what was wrong.
    reply = (e && e.message ? String(e.message) : 'invalid arguments').slice(0, MAX_RESPONSE);
  }
  return postAsApp(app, channelRow, reply, { kind: 'command' });
}

module.exports = {
  TOKEN_PREFIX,
  listApps, getApp, createApp, removeApp,
  listCommands, setCommand, removeCommand,
  appByToken, resolveCommand, postAsApp, respond, hashToken, appShape, commandShape, bad,
  updateApp, normaliseOptions, bindArguments, readOptions,
  MAX_RESPONSE, OPTION_TYPES, substitute,
};
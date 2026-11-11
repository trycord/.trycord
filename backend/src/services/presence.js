// The presence an account publishes, and what other people are told.
//
// There are two separate facts. One is whether a socket is open for the
// account - the registry owns that and it is true whether the person wants it
// known or not. The other is what the account has chosen to publish: online,
// idle, do-not-disturb or invisible. This module owns the second and combines
// them for the readers who are allowed to see the first.
//
// The default is 'online'. An account that has never opened the setting is
// presented exactly as it was before the setting existed.
//
// 'invisible' is not a state other people see. To everybody else the account
// is offline; the account itself is told its own choice so its own controls
// can show what it picked.

const db = require('../db');
const { now } = require('../util');

const STATES = ['online', 'idle', 'dnd', 'invisible'];

// What a reader may send. 'offline' and 'away' are accepted as the words a
// client might naturally use, and normalised rather than refused: a status
// picker with an "Appear offline" item sends exactly that.
function normalize(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'offline' || v === 'invisible' || v === 'hide') return 'invisible';
  if (v === 'away') return 'idle';
  if (v === 'do-not-disturb' || v === 'donotdisturb' || v === 'busy') return 'dnd';
  if (v === 'available' || v === 'active' || v === 'online') return 'online';
  return STATES.includes(v) ? v : null;
}

async function chosen(userId, conn = db) {
  try {
    const row = await conn.get('SELECT presence_status FROM users WHERE id = ?', [userId]);
    return normalize(row && row.presence_status) || 'online';
  } catch {
    // A database that has not taken the additive migration yet keeps working:
    // no choice is the same as the default.
    return 'online';
  }
}

// The state one account presents to other people, given whether it is
// connected. Invisible is presented as offline.
function presented(status, connected) {
  if (!connected) return 'offline';
  if (status === 'invisible') return 'offline';
  return status || 'online';
}

// Resolve one account for a reader. `connected` is the registry's answer.
async function forOne(userId, connected, conn = db) {
  const status = await chosen(userId, conn);
  return presented(status, connected);
}

// Resolve many accounts with one query for the chosen states rather than one
// per person. `connectedOf` is a function the caller supplies - the gateway
// owns the socket map and this module must not reach into it.
async function forMany(ids, connectedOf, conn = db) {
  const out = {};
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  if (!list.length) return out;
  const statuses = new Map();
  try {
    const placeholders = list.map(() => '?').join(',');
    const rows = await conn.all(
      `SELECT id, presence_status FROM users WHERE id IN (${placeholders})`,
      list
    );
    for (const row of rows) statuses.set(String(row.id), normalize(row.presence_status) || 'online');
  } catch {
    // See chosen(): an absent column means the default for every account.
  }
  for (const id of list) {
    out[id] = presented(statuses.get(id) || 'online', connectedOf(id));
  }
  return out;
}

// The common caller: the gateway knows which sockets are open and this module
// knows what the account chose. The two answers together are the presence a
// reader sees. Kept here so every route resolves it the same way; a second
// copy is how one screen starts reporting a different state from another.
async function forGateway(ids, gateway) {
  let base = {};
  try {
    base = gateway && gateway.getPresence ? gateway.getPresence(ids) : {};
  } catch { /* presence is best-effort */ }
  return forMany(ids, (id) => base[String(id)] === 'online');
}

async function setStatus(userId, value) {
  const status = normalize(value);
  if (!status) {
    throw { code: 'VALIDATION_ERROR', message: 'status must be one of ' + STATES.join(', ') };
  }
  await db.run('UPDATE users SET presence_status = ? WHERE id = ?', [status, userId]);
  return { status, updatedAt: now() };
}

module.exports = {
  STATES,
  normalize,
  chosen,
  presented,
  forOne,
  forMany,
  forGateway,
  setStatus,
};

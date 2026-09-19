// Invite lifecycle: create, list, revoke, and validated consumption on join.
// Join flow: validate -> check expiry/uses -> create membership -> record use (atomic).
const crypto = require('crypto');
const db = require('../db');
const { now, uuid } = require('../util');
const memberships = require('./memberships');

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newCode() {
  const buf = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += CODE_CHARS[buf[i] % CODE_CHARS.length];
  return out;
}

function parseRow(r) {
  if (!r) return null;
  r.revoked = !!r.revoked;
  return r;
}

function create(serverId, creatorId, { maxUses, expiresInHours } = {}) {
  if (maxUses !== undefined && maxUses !== null) {
    maxUses = Number(maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100) {
      throw { code: 'VALIDATION_ERROR', message: 'maxUses must be 1-100' };
    }
  } else {
    maxUses = null;
  }
  let expiresAt = null;
  if (expiresInHours !== undefined && expiresInHours !== null && expiresInHours !== '') {
    const h = Number(expiresInHours);
    if (!Number.isFinite(h) || h <= 0 || h > 24 * 30) {
      throw { code: 'VALIDATION_ERROR', message: 'expiry must be 1 hour to 30 days' };
    }
    expiresAt = new Date(Date.now() + h * 3600 * 1000).toISOString();
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    try {
      const id = uuid();
      db.prepare(`INSERT INTO invites
        (id, code, server_id, creator_id, created_at, expires_at, max_uses, uses, revoked)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`)
        .run(id, code, serverId, creatorId, now(), expiresAt, maxUses);
      return parseRow(db.prepare('SELECT * FROM invites WHERE id = ?').get(id));
    } catch (e) {
      if (!String(e.message).includes('UNIQUE')) throw e;
    }
  }
  throw { code: 'CONFLICT', message: 'could not generate an invite code' };
}

function list(serverId) {
  return db.prepare(`
    SELECT i.*, u.username AS creator_name
    FROM invites i JOIN users u ON u.id = i.creator_id
    WHERE i.server_id = ? ORDER BY i.created_at DESC
  `).all(serverId).map(parseRow);
}

function getById(inviteId) {
  return parseRow(db.prepare('SELECT * FROM invites WHERE id = ?').get(inviteId));
}

function getByCode(code) {
  return parseRow(db.prepare('SELECT * FROM invites WHERE code = ?')
    .get(String(code).toUpperCase().trim()));
}

function stateOf(invite) {
  if (!invite || invite.revoked) return 'revoked';
  if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now()) return 'expired';
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) return 'exhausted';
  return 'valid';
}

// Minimal safe info for pre-join display (never leaks settings, members, or messages).
function preview(code) {
  const invite = getByCode(code);
  if (!invite) return null;
  const srv = db.prepare(`
    SELECT s.id, s.name, s.description, s.is_public, s.created_at,
      (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count
    FROM servers s WHERE s.id = ?
  `).get(invite.server_id);
  if (!srv) return null;
  return { invite: { code: invite.code, state: stateOf(invite) }, server: srv };
}

const consumeTx = db.transaction((invite, user) => {
  const fresh = getByCode(invite.code);
  const state = stateOf(fresh);
  if (state !== 'valid') throw { code: 'INVITE_' + state.toUpperCase(), message: 'invite ' + state };
  memberships.join(fresh.server_id, user);
  db.prepare('UPDATE invites SET uses = uses + 1 WHERE id = ?').run(fresh.id);
  return { serverId: fresh.server_id };
});

function joinWithCode(code, user) {
  const invite = getByCode(code);
  if (!invite) throw { code: 'INVITE_INVALID', message: 'invite not found' };
  if (invite.revoked) throw { code: 'INVITE_REVOKED', message: 'invite revoked' };
  if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now()) {
    throw { code: 'INVITE_EXPIRED', message: 'invite expired' };
  }
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) {
    throw { code: 'INVITE_EXHAUSTED', message: 'invite has no uses left' };
  }
  return consumeTx(invite, user);
}

function revoke(invite) {
  db.prepare('UPDATE invites SET revoked = 1 WHERE id = ?').run(invite.id);
  return { ok: true };
}

module.exports = { create, list, getById, getByCode, stateOf, preview, joinWithCode, revoke };

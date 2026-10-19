// The device registry: what a device is, who owns it, and when it stops
// being trusted.
//
// A device is an identity with a long-lived key pair. It is registered by
// the account that owns it, it publishes a prekey bundle, and it is revoked
// when it is lost. A revoked device is dead everywhere: it cannot publish
// prekeys, it cannot take a bundle from the server, and its sessions are
// marked dead so nothing trusts it again.
//
// Revocation is not a soft flag on one row. The prekeys it published are
// deleted, because a prekey a revoked device published is a prekey an
// attacker could otherwise hand out and have a session built on.

'use strict';

const db = require('../../db');
const { now, uuid } = require('../../clock');
const { protocolError } = require('./envelope');

/** A device row as it is shown to its owner. */
function shape(row) {
  return {
    id: row.id,
    label: row.label,
    identityKey: row.identity_key,
    identityDhKey: row.identity_dh_key,
    signedPreKey: row.signed_pre_key,
    keyFingerprint: row.key_fingerprint,
    recoveryEnabled: !!row.wrapped_private_key,
    revoked: !!row.revoked_at,
    revokedAt: row.revoked_at || null,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * Register a device.
 *
 * The client supplies the public keys and the sealed private material; the
 * server checks the shape of both and stores them. It cannot read the
 * sealed material, and it never asks for the private keys in the clear.
 */
async function register(userId, input) {
  const id = String(input.id || uuid());
  const label = String(input.label || '').trim();
  if (!label) throw protocolError('E2EE_VALIDATION_ERROR', 'a device needs a label', 400);
  if (!input.identityKey || !input.identityDhKey || !input.signedPreKey) {
    throw protocolError('E2EE_VALIDATION_ERROR', 'a device needs its three public keys', 400);
  }
  const timestamp = now();
  const existing = await db.get('SELECT id, user_id FROM e2ee_devices WHERE id = ?', [id]);
  if (existing) {
    if (existing.user_id !== userId) {
      throw protocolError('E2EE_FORBIDDEN', 'that device id belongs to somebody else', 403);
    }
    await db.run(
      `UPDATE e2ee_devices
          SET label = ?, identity_key = ?, identity_dh_key = ?, signed_pre_key = ?,
              key_fingerprint = ?, signature = ?, wrapped_private_key = ?, recovery_salt = ?,
              recovery_iterations = ?, last_seen_at = ?
        WHERE id = ?`,
      [label, input.identityKey, input.identityDhKey, input.signedPreKey,
        input.keyFingerprint || '', input.signature || null,
        input.wrappedPrivateKey || null, input.recoverySalt || null,
        input.recoveryIterations || null, timestamp, id]
    );
    return shape(await db.get('SELECT * FROM e2ee_devices WHERE id = ?', [id]));
  }
  await db.run(
    `INSERT INTO e2ee_devices
       (id, user_id, label, identity_key, identity_dh_key, signed_pre_key, key_fingerprint,
        signature, wrapped_private_key, recovery_salt, recovery_iterations, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, label, input.identityKey, input.identityDhKey, input.signedPreKey,
      input.keyFingerprint || '', input.signature || null,
      input.wrappedPrivateKey || null, input.recoverySalt || null,
      input.recoveryIterations || null, timestamp, timestamp]
  );
  return shape(await db.get('SELECT * FROM e2ee_devices WHERE id = ?', [id]));
}

/**
 * A device of the caller's own.
 *
 * A device that exists but belongs to somebody else is refused rather than
 * reported as missing: the caller asked for key material, and the answer
 * is that it is not theirs to have.
 */
async function owned(userId, deviceId) {
  const row = await db.get('SELECT * FROM e2ee_devices WHERE id = ?', [deviceId]);
  if (!row) throw protocolError('E2EE_NOT_FOUND', 'no such device', 404);
  if (row.user_id !== userId) {
    throw protocolError('E2EE_FORBIDDEN', 'that device belongs to somebody else', 403);
  }
  return row;
}

/** A device by id, whoever owns it. The public half is not a secret. */
async function get(deviceId) {
  return db.get('SELECT * FROM e2ee_devices WHERE id = ?', [deviceId]);
}

/** Every device of an account, newest first. */
async function listForUser(userId) {
  const rows = await db.all(
    'SELECT * FROM e2ee_devices WHERE user_id = ? ORDER BY created_at DESC',
    [userId]
  );
  return rows.map(shape);
}

/** Every live device of an account. Revoked devices are not live. */
async function liveDevicesOf(userId) {
  return db.all(
    'SELECT * FROM e2ee_devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at ASC',
    [userId]
  );
}

/** Record that a device was seen. Cheap, and it is what "last seen" means. */
async function touch(deviceId) {
  await db.run('UPDATE e2ee_devices SET last_seen_at = ? WHERE id = ?', [now(), deviceId]);
}
/**
 * Revoke a device.
 *
 * The prekeys it published are deleted, its sessions are marked dead, and
 * the account holder's other devices are told about it so they can rekey
 * what they shared with it.
 */
async function revoke(userId, deviceId) {
  const device = await owned(userId, deviceId);
  if (device.revoked_at) return shape(device);
  const timestamp = now();
  await db.transaction(async (t) => {
    await t.run('UPDATE e2ee_devices SET revoked_at = ? WHERE id = ?', [timestamp, deviceId]);
    await t.run('DELETE FROM e2ee_prekeys WHERE device_id = ?', [deviceId]);
    await t.run(
      "UPDATE e2ee_sessions SET status = 'dead', last_seen_at = ? WHERE device_id = ? AND status != 'dead'",
      [timestamp, deviceId]
    );
    await t.run(
      "UPDATE e2ee_sessions SET status = 'dead', last_seen_at = ? WHERE peer_device_id = ? AND status != 'dead'",
      [timestamp, deviceId]
    );
  });
  return shape(await db.get('SELECT * FROM e2ee_devices WHERE id = ?', [deviceId]));
}

module.exports = {
  shape,
  register,
  owned,
  get,
  listForUser,
  liveDevicesOf,
  touch,
  revoke,
};

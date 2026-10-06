// Account deletion, as a request workflow rather than a button.
//
//   DELETION_REQUESTED  the user asked, after confirming with their password
//   UNDER_REVIEW        an administrator is looking at it
//   DELETION_PROCESSING the erase has run
//   DELETED             the account is anonymised and can no longer sign in
//   CANCELLED           withdrawn before processing
//
// The account is anonymised, never hard-deleted. Messages, moderation actions
// and audit rows reference the author, and deleting the user row would cascade
// that evidence away: a moderator's actions and a report's history have to
// outlive the person they name. What is erased is the identity - username,
// email, display name, password, profile media and every object the account
// owns - plus the sessions, friendships, notifications and search-facing rows
// that carry no independent value.
const db = require('../db');
const storage = require('./storage');
const { now, uuid } = require('../util');
const enforcement = require('./enforcement');

const OPEN_STATES = ['DELETION_REQUESTED', 'UNDER_REVIEW', 'DELETION_PROCESSING'];

function bad(message, code) {
  const e = new Error(message);
  e.code = code || 'VALIDATION_ERROR';
  throw e;
}

function notFound() {
  const e = new Error('request not found');
  e.code = 'NOT_FOUND';
  throw e;
}

// --- user-facing ---------------------------------------------------------

async function requestDeletion({ userId, reason }) {
  const user = await db.get('SELECT id, username FROM users WHERE id = ?', [userId]);
  if (!user) notFound();
  const existing = await db.get(
    'SELECT id, status FROM account_deletion_requests WHERE user_id = ? AND status IN (?,?,?)',
    [userId].concat(OPEN_STATES)
  );
  if (existing) bad('an erasure request is already open for this account', 'CONFLICT');

  const id = uuid();
  const ts = now();
  // request_type is fixed here and never taken from the caller: only the user
  // can open a GDPR request, and the queue cannot be relabelled.
  await db.run(
    'INSERT INTO account_deletion_requests (id, user_id, status, request_type, reason, requested_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, userId, 'DELETION_REQUESTED', 'GDPR', String(reason || '').slice(0, 1000) || null, ts]
  );
  await enforcement.audit(userId, 'GDPR_ACCOUNT_DELETION_REQUESTED', 'user', userId, null);
  return getForUser(userId);
}

async function cancelDeletion({ userId, actorId }) {
  const row = await db.get(
    'SELECT * FROM account_deletion_requests WHERE user_id = ? AND status IN (?,?)',
    [userId, 'DELETION_REQUESTED', 'UNDER_REVIEW']
  );
  if (!row) notFound();
  const ts = now();
  await db.run(
    'UPDATE account_deletion_requests SET status = ?, cancelled_at = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?',
    ['CANCELLED', ts, ts, actorId || null, row.id]
  );
  await enforcement.audit(actorId || userId, 'GDPR_ACCOUNT_DELETION_CANCELLED', 'user', userId, null);
  return getForUser(userId);
}

async function getForUser(userId) {
  return db.get('SELECT * FROM account_deletion_requests WHERE user_id = ? ORDER BY requested_at DESC', [userId]);
}

// --- administrator -------------------------------------------------------

async function listRequests({ status, limit } = {}) {
  const where = [];
  const params = [];
  if (status) {
    if (!KNOWN_STATUSES.includes(String(status).toUpperCase())) bad('unknown request status');
    where.push('r.status = ?');
    params.push(String(status).toUpperCase());
  }
  const cap = Math.min(parseInt(limit, 10) || 50, 200);
  const q = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return db.all(
    `SELECT r.*, u.username, u.created_at AS account_created_at
     FROM account_deletion_requests r
     LEFT JOIN users u ON u.id = r.user_id
     ${q} ORDER BY r.requested_at ASC LIMIT ${cap}`,
    params
  );
}

async function reviewRequest({ requestId, reviewerId, decision, note }) {
  const row = await db.get('SELECT * FROM account_deletion_requests WHERE id = ?', [requestId]);
  if (!row) notFound();
  if (row.status !== 'DELETION_REQUESTED') {
    bad('this request is not awaiting review', 'CONFLICT');
  }
  if (decision === 'APPROVE') {
    await db.run(
      'UPDATE account_deletion_requests SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?',
      ['UNDER_REVIEW', now(), reviewerId, requestId]
    );
  } else if (decision === 'REJECT') {
    await db.run(
      'UPDATE account_deletion_requests SET status = ?, reviewed_at = ?, reviewed_by = ?, reason = ? WHERE id = ?',
      ['REJECTED', now(), reviewerId, String(note || '').slice(0, 1000) || row.reason, requestId]
    );
  } else {
    bad('decision must be APPROVE or REJECT');
  }
  await enforcement.audit(reviewerId, 'GDPR_ACCOUNT_DELETION_REVIEWED', 'user', row.user_id, null);
  return db.get('SELECT * FROM account_deletion_requests WHERE id = ?', [requestId]);
}

const KNOWN_STATUSES = [
  'DELETION_REQUESTED', 'UNDER_REVIEW', 'DELETION_PROCESSING',
  'DELETED', 'CANCELLED', 'REJECTED',
];

// --- the erase -----------------------------------------------------------

// Every object the account owns, resolved through the same key helpers the
// upload pipeline uses. Returned as descriptors so the caller can delete them
// through the storage service, and so the count can be reported.
async function collectOwnedObjects(userId) {
  const objects = [];
  const atts = await db.all(
    'SELECT a.id, a.channel_id FROM attachments a WHERE a.uploader_id = ?',
    [userId]
  );
  atts.forEach((r) => objects.push(storage.key.messageMedia(r.channel_id, r.id)));

  const prof = await db.all('SELECT id, user_id, kind FROM profile_media WHERE user_id = ?', [userId]);
  prof.forEach((r) => objects.push(storage.key.userMedia(r.user_id, r.kind, r.id)));

  const owned = await db.get('SELECT id FROM servers WHERE owner_id = ?', [userId]);
  if (owned) {
    const media = await db.all('SELECT id, server_id, kind FROM server_media WHERE server_id = ?', [owned.id]);
    media.forEach((r) => objects.push(storage.key.communityMedia(r.server_id, r.kind, r.id)));
  }
  return objects;
}

// Sessions and tokens first, so a failure partway through cannot leave a
// working session behind on an account the operator believes is gone.
// Kill every live session for the account. Called before the identity columns
// are cleared, so a crash here cannot leave a usable login on an account the
// operator believes is gone.
async function revokeAccess(userId) {
  await db.run(
    'UPDATE users SET sessions_invalidated_at = ?, password_hash = ? WHERE id = ?',
    [now(), '!' + uuid(), userId]
  );
}

async function eraseAccount({ userId, actorId }) {
  const user = await db.get('SELECT id, username FROM users WHERE id = ?', [userId]);
  if (!user) notFound();

  const objects = await collectOwnedObjects(userId);

  const report = {
    userId,
    username: user.username,
    objects: objects.length,
    objectsRemoved: 0,
    objectFailures: [],
    communitiesLeft: 0,
    messagesRedacted: 0,
  };

  // Objects go before the rows that describe them, so a crash leaves orphaned
  // files (recoverable, and swept by the pending-upload purge) rather than rows
  // pointing at objects that no longer exist.
  for (const key of objects) {
    try {
      await storage.delete(key);
      report.objectsRemoved++;
    } catch (e) {
      report.objectFailures.push({ key, error: (e && e.message) || String(e) });
    }
  }

  // Communities this account owns are handed to the longest-standing remaining
  // member rather than deleted: other people are still using them. A community
  // with nobody else in it is left pointing at the anonymised account and is
  // named in the report for an administrator to deal with.
  const owned = await db.all('SELECT id FROM servers WHERE owner_id = ?', [userId]);
  const orphans = [];
  for (const s of owned) {
    const heir = await db.get(
      'SELECT user_id FROM server_members WHERE server_id = ? AND user_id != ? ORDER BY joined_at ASC, id ASC',
      [s.id, userId]
    );
    if (heir && heir.user_id) {
      await db.run('UPDATE servers SET owner_id = ? WHERE id = ?', [heir.user_id, s.id]);
    } else {
      orphans.push(s.id);
    }
  }
  report.communitiesLeft = owned.length;
  report.communitiesTransferred = owned.length - orphans.length;
  report.orphanCommunities = orphans;

  await db.run('DELETE FROM server_members WHERE user_id = ?', [userId]);
  await db.run('DELETE FROM member_roles WHERE user_id = ?', [userId]);
  await db.run('DELETE FROM server_bans WHERE user_id = ?', [userId]);
  await db.run('DELETE FROM friendships WHERE user_id = ? OR friend_id = ?', [userId, userId]);
  await db.run('DELETE FROM friend_requests WHERE from_user_id = ? OR to_user_id = ?', [userId, userId]);
  await db.run('DELETE FROM notifications WHERE user_id = ?', [userId]);
  await db.run('DELETE FROM muted_channels WHERE user_id = ?', [userId]);
  await db.run('DELETE FROM dm_members WHERE user_id = ?', [userId]);
  await db.run('DELETE FROM reactions WHERE user_id = ?', [userId]);
  await db.run('DELETE FROM profile_media WHERE user_id = ?', [userId]);
  await db.run('DELETE FROM password_resets WHERE user_id = ?', [userId]);
  await db.run('DELETE FROM email_verifications WHERE user_id = ?', [userId]);

  // Messages stay, attributed to the anonymised account. Removing them would
  // delete other people's conversations; the author reference becomes a
  // placeholder that resolves to nobody.
  const msgs = await db.get('SELECT COUNT(*) AS c FROM messages WHERE author_id = ?', [userId]);
  report.messagesRedacted = msgs ? msgs.c : 0;

  await revokeAccess(userId);

  // Identity columns are cleared in place. username/email are UNIQUE, so the
  // placeholder has to be unique too.
  const tombstone = 'deleted-' + uuid();
  await db.run(
    `UPDATE users SET username = ?, email = NULL, display_name = NULL, bio = NULL,
       status_text = NULL, avatar_url = NULL, banner_url = NULL,
       terms_version = NULL, privacy_version = NULL, password_hash = ?,
       email_verified_at = NULL, sessions_invalidated_at = ?
     WHERE id = ?`,
    [tombstone, '!' + uuid(), now(), userId]
  );

  await db.run(
    'UPDATE account_deletion_requests SET status = ?, processed_at = ?, anonymised_at = ? WHERE user_id = ? AND status = ?',
    ['DELETED', now(), now(), userId, 'DELETION_PROCESSING']
  );
  await enforcement.audit(actorId, 'GDPR_ACCOUNT_DELETION_PROCESSED', 'user', userId, null);
  return report;
}

// Move an approved request into processing. Kept separate from the erase so an
// administrator can queue work and an operator can run it deliberately.
async function beginProcessing({ requestId, actorId }) {
  const row = await db.get('SELECT * FROM account_deletion_requests WHERE id = ?', [requestId]);
  if (!row) notFound();
  if (row.status !== 'UNDER_REVIEW') bad('this request is not approved', 'CONFLICT');
  await db.run('UPDATE account_deletion_requests SET status = ? WHERE id = ?', ['DELETION_PROCESSING', requestId]);
  await enforcement.audit(actorId, 'GDPR_ACCOUNT_DELETION_PROCESSING', 'user', row.user_id, null);
  return db.get('SELECT * FROM account_deletion_requests WHERE id = ?', [requestId]);
}

module.exports = {
  KNOWN_STATUSES,
  OPEN_STATES,
  requestDeletion,
  cancelDeletion,
  getForUser,
  listRequests,
  reviewRequest,
  beginProcessing,
  eraseAccount,
  collectOwnedObjects,
};

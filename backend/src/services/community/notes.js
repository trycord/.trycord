// A moderator's note about a member.
//
// One note per member per community. A moderator who writes again replaces
// the earlier note rather than leaving a pile of them to read.
//
// The note belongs to the community's moderators and to nobody else:
//
//   - the member it is about never sees it, and there is no route that
//     hands it to them;
//   - the server only hands it to a reader who can moderate here;
//   - and it is never written into the audit log, because an audit log is
//     a record of actions, and a note is not an action - it is a thought.
//
// The note says who wrote it and when, so a moderator picking it up after
// somebody else left can see whose judgement it was.

'use strict';

const db = require('../../db');
const { now, uuid } = require('../../util');

/** The longest a note may be. */
const MAX_LENGTH = 2000;

/**
 * The note about a member.
 *
 * @param {string} serverId
 * @param {string} userId
 * @returns {Promise<object|null>} the note, or null when there is none
 */
async function read(serverId, userId) {
  return db.get(
    'SELECT * FROM member_notes WHERE server_id = ? AND user_id = ?',
    [serverId, userId]
  );
}

/**
 * Every note in a community.
 *
 * Used by the roster, so a moderator can see at a glance who has a note.
 *
 * @param {string} serverId
 * @returns {Promise<object[]>}
 */
async function list(serverId) {
  return db.all(
    'SELECT n.*, u.username AS author_username, u.display_name AS author_display '
    + 'FROM member_notes n LEFT JOIN users u ON u.id = n.author_id '
    + 'WHERE n.server_id = ? ORDER BY n.updated_at DESC',
    [serverId]
  );
}

/**
 * Write the note about a member.
 *
 * @param {string} serverId
 * @param {string} userId     the member the note is about
 * @param {string} authorId   the moderator writing it
 * @param {string} body
 * @returns {Promise<object>} the note
 */
async function write(serverId, userId, authorId, body) {
  const text = String(body == null ? '' : body).trim();
  if (!text) {
    throw { code: 'VALIDATION_ERROR', message: 'a note needs some words in it' };
  }
  if (text.length > MAX_LENGTH) {
    throw {
      code: 'VALIDATION_ERROR',
      message: 'a note may be at most ' + MAX_LENGTH + ' characters long',
    };
  }

  const existing = await read(serverId, userId);
  if (existing) {
    await db.run(
      'UPDATE member_notes SET body = ?, author_id = ?, updated_at = ? WHERE id = ?',
      [text, authorId, now(), existing.id]
    );
  } else {
    await db.run(
      'INSERT INTO member_notes (id, server_id, user_id, author_id, body, created_at, updated_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuid(), serverId, userId, authorId, text, now(), now()]
    );
  }
  return read(serverId, userId);
}

/**
 * Take the note about a member away.
 *
 * @param {string} serverId
 * @param {string} userId
 * @returns {Promise<boolean>} whether there was a note to take away
 */
async function remove(serverId, userId) {
  const existing = await read(serverId, userId);
  if (!existing) return false;
  await db.run('DELETE FROM member_notes WHERE id = ?', [existing.id]);
  return true;
}

/**
 * The note about a member, as it is shown.
 *
 * @param {object} note
 * @returns {object}
 */
function shown(note) {
  if (!note) return null;
  return {
    id: String(note.id),
    userId: String(note.user_id),
    body: String(note.body),
    authorId: String(note.author_id),
    authorName: note.author_display || note.author_username || 'A moderator',
    createdAt: note.created_at,
    updatedAt: note.updated_at,
  };
}

module.exports = { read, list, write, remove, shown, MAX_LENGTH };

// Notifying the author of the message that was replied to.
//
// Separate from mentions because the trigger is different: a mention is a
// deliberate "@name" in the text, a reply is someone answering a message of
// yours whether or not they name you. Both are skipped for the same reasons -
// you are not notified about your own message, a muted channel is a muted
// channel, and a block is a block.
//
// The root author is the person who needs to know, not everyone in the thread:
// once you have replied you are in it, and being told about every subsequent
// reply is a notification you cannot act on.

const db = require('../db');
const notifications = require('./notifications');

async function notifyReply({ kind, scopeId, rootId, replyId, authorId }) {
  if (!rootId) return null;
  const s = kind === 'dm'
    ? { table: 'dm_messages', scope: 'conversation_id' }
    : { table: 'messages', scope: 'channel_id' };
  const root = await db.get(
    `SELECT author_id FROM ${s.table} WHERE id = ? AND ${s.scope} = ?`,
    [rootId, scopeId]
  );
  if (!root) return null;
  const target = String(root.author_id);
  if (target === String(authorId)) return null;

  // A reply can name a person who has since blocked the author, or left. The
  // insert is not worth a 500 and the notification is not worth violating
  // either of those, so a rejection here is dropped rather than raised.
  try {
    if (kind === 'channel') {
      const muted = await db.get(
        'SELECT 1 AS ok FROM muted_channels WHERE channel_id = ? AND user_id = ?',
        [scopeId, target]
      );
      if (muted) return null;
    }
    const note = await notifications.create(target, 'reply', authorId, replyId);
    return { userId: target, notification: note };
  } catch {
    return null;
  }
}

module.exports = { notifyReply };

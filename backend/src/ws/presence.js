// Who should hear about a presence change, and telling them.
//
// A presence flip is interesting to three overlapping groups: DM peers, friends, and
// fellow members of any shared community - the last so member lists can show live
// online/offline state without polling. Fan-out is bounded by construction: only
// currently-online targets are sent to, so a user's presence costs one query and zero
// frames when nobody relevant is connected.
//
// Everything here is best-effort. Presence is decoration on top of messaging, and a
// failed presence broadcast must never be able to fail the thing that triggered it -
// hence the catch in affectedUsers and the callers that ignore the promise.

const db = require('../db');

module.exports = function createPresence({ registry }) {
  async function affectedUsers(userId) {
    try {
      const peers = await db.all(
        `SELECT om.user_id AS id FROM dm_members m
         JOIN dm_members om ON om.conversation_id = m.conversation_id
         WHERE m.user_id = ? AND om.user_id != ?`,
        [userId, userId]
      );
      const friends = await db.all('SELECT friend_id AS id FROM friendships WHERE user_id = ?', [userId]);
      const members = await db.all(
        `SELECT m2.user_id AS id FROM server_members m
         JOIN server_members m2 ON m2.server_id = m.server_id
         WHERE m.user_id = ? AND m2.user_id != ?`,
        [userId, userId]
      );
      const ids = new Set();
      peers.concat(friends).concat(members).forEach((r) => ids.add(String(r.id)));
      ids.delete(String(userId));
      return [...ids];
    } catch {
      // Returning nothing means the recipients keep whatever they last believed, which
      // is wrong for a moment. Failing the connection would be much worse.
      return [];
    }
  }

  async function announce(userId, presence) {
    const targets = await affectedUsers(userId);
    for (const id of targets) {
      if (registry.isOnline(id)) {
        registry.sendToUser(id, { type: 'presence', userId: String(userId), presence });
      }
    }
  }

  return {
    announce,
    // Called from the registry's hooks, which fire on first-open and last-close. The
    // promise is dropped deliberately: nothing should await a presence broadcast.
    announceQuiet: (userId, presence) => { announce(userId, presence).catch(() => {}); },
    affectedUsers,
  };
};

// Who should hear about a presence change, and telling them.
//
// A presence flip is interesting to three overlapping groups: DM peers,
// friends, and fellow members of any shared community - the last so member
// lists can show live online/offline state without polling. Fan-out is bounded
// by construction: only currently-online targets are sent to, so a user's
// presence costs one query and zero frames when nobody relevant is connected.
//
// Privacy is applied here, not only on the HTTP routes. A presence preference
// that is honoured when a profile is fetched but ignored when the same state
// is pushed over a socket is not a preference: it is a decoration. 'friends'
// narrows the audience to friends; 'nobody' reaches nobody; a block in either
// direction removes that person from the audience.
//
// Everything here is best-effort. Presence is decoration on top of messaging,
// and a failed presence broadcast must never be able to fail the thing that
// triggered it - hence the catch in affectedUsers and the callers that ignore
// the promise.

const db = require('../db');
const privacy = require('../services/privacy');
const presence = require('../services/presence');
const { EVENTS } = require('./events.js');

module.exports = function createPresence({ registry }) {
  async function blockedIds(userId) {
    const rows = await db.all(
      `SELECT user_id, blocked_id FROM user_blocks
       WHERE user_id = ? OR blocked_id = ?`,
      [userId, userId]
    );
    const ids = new Set();
    for (const row of rows) {
      ids.add(String(row.user_id));
      ids.add(String(row.blocked_id));
    }
    ids.delete(String(userId));
    return ids;
  }

  // Everybody who could be interested, before privacy narrows the list. Split
  // from affectedUsers so a change of the preference itself can reach the
  // people who were allowed a moment ago and are not any more.
  async function candidates(userId) {
    const friends = await db.all('SELECT friend_id AS id FROM friendships WHERE user_id = ?', [userId]);
    const ids = new Set();
    friends.forEach((r) => ids.add(String(r.id)));

    const peers = await db.all(
      `SELECT DISTINCT om.user_id AS id FROM dm_members m
       JOIN dm_members om ON om.conversation_id = m.conversation_id
       WHERE m.user_id = ? AND om.user_id != ?`,
      [userId, userId]
    );
    const members = await db.all(
      `SELECT DISTINCT m2.user_id AS id FROM server_members m
       JOIN server_members m2 ON m2.server_id = m.server_id
       WHERE m.user_id = ? AND m2.user_id != ?`,
      [userId, userId]
    );
    peers.concat(members).forEach((r) => ids.add(String(r.id)));

    const blocked = await blockedIds(userId);
    for (const id of blocked) ids.delete(id);
    ids.delete(String(userId));
    return [...ids];
  }

  async function affectedUsers(userId) {
    try {
      const pref = await privacy.getPrivacy(userId);
      if (pref.presence === 'nobody') return [];
      const ids = new Set(await candidates(userId));
      if (pref.presence === 'friends') {
        const friends = await db.all('SELECT friend_id AS id FROM friendships WHERE user_id = ?', [userId]);
        const allowed = new Set(friends.map((r) => String(r.id)));
        for (const id of [...ids]) if (!allowed.has(id)) ids.delete(id);
      }
      return [...ids];
    } catch {
      // Returning nothing means the recipients keep whatever they last believed,
      // which is wrong for a moment. Failing the connection would be much worse.
      return [];
    }
  }

  function send(id, userId, shown) {
    if (!registry.isOnline(id)) return;
    registry.sendToUser(id, {
      type: EVENTS.PRESENCE,
      userId: String(userId),
      presence: shown,
    });
  }

  async function announce(userId, connected) {
    const status = await presence.chosen(userId);
    const shown = presence.presented(status, connected === 'online');
    const targets = await affectedUsers(userId);
    for (const id of targets) send(id, userId, shown);
  }

  // Re-evaluate the audience after the account changed who may see it. The
  // people who just lost permission must be told the account is offline;
  // otherwise their last belief - online - stays on screen indefinitely, which
  // is exactly the state the preference was meant to stop.
  async function refresh(userId) {
    const status = await presence.chosen(userId);
    const connected = registry.isOnline(userId);
    const shown = presence.presented(status, connected);
    const all = await candidates(userId);
    const allowed = new Set(await affectedUsers(userId));
    for (const id of all) send(id, userId, allowed.has(id) ? shown : 'offline');
  }

  return {
    announce,
    refresh,
    // Called from the registry's hooks, which fire on first-open and
    // last-close. The promise is dropped deliberately: nothing should await a
    // presence broadcast.
    announceQuiet: (userId, connected) => { announce(userId, connected).catch(() => {}); },
    refreshQuiet: (userId) => { refresh(userId).catch(() => {}); },
    affectedUsers,
  };
};

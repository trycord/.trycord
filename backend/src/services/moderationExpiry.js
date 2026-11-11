// Expiry for moderation that lapses on its own.
//
// A suspension, timeout, warning, community ban or feature restriction has an
// end time. The enforcement path already refuses an expired row on the next
// request, but the durable record must move too: the action becomes EXPIRED,
// the case gets a timeline entry, and the member is told. Without this the
// console shows live-looking enforcement that ended weeks ago.
const db = require('../db');
const { now } = require('../util');
const cases = require('./cases');
const notifications = require('./notifications');

async function notify(userId, referenceId, detail, dedupeKey) {
  if (!userId) return;
  try {
    await notifications.create(userId, 'moderation_lift', null, referenceId, {
      detail, dedupeKey,
    });
  } catch { /* expiry itself is already durable */ }
}

async function closeAction(action, kind) {
  if (!action) return;
  const ts = now();
  await db.run(
    `UPDATE moderation_actions SET status = 'EXPIRED', updated_at = ?
     WHERE id = ? AND status = 'ACTIVE'`,
    [ts, action.id]
  );
  if (action.case_id) {
    await cases.addEvent(action.case_id, null, 'ENFORCEMENT_EXPIRED', kind, {
      actionId: action.id, actionType: action.action_type, expiredAt: ts,
    });
  }
}

async function sweep() {
  const timestamp = now();
  const result = {
    suspensions: 0, servers: 0, bans: 0, timeouts: 0,
    warnings: 0, restrictions: 0,
  };

  // Account suspensions.
  const suspended = await db.all(
    `SELECT id, username, enforcement_expires_at FROM users
     WHERE enforcement_state = 'suspended'
       AND enforcement_expires_at IS NOT NULL AND enforcement_expires_at <= ?`,
    [timestamp]
  );
  for (const user of suspended) {
    const action = await db.get(
      `SELECT * FROM moderation_actions WHERE target_type = 'user' AND target_id = ?
         AND action_type = 'SUSPENSION' AND status = 'ACTIVE'
       ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    await db.run(
      `UPDATE users SET enforcement_state = NULL, enforcement_expires_at = NULL,
         enforcement_reason = NULL, enforcement_updated_at = ? WHERE id = ?`,
      [timestamp, user.id]
    );
    await closeAction(action, 'suspension ended');
    await notify(user.id, action ? action.id : null,
      'Your temporary suspension has ended.',
      'moderation:expired:suspension:' + user.id + ':' + (user.enforcement_expires_at || ''));
    result.suspensions++;
  }

  // Community suspensions.
  const servers = await db.all(
    `SELECT id, name, owner_id, enforcement_expires_at FROM servers
     WHERE enforcement_state = 'suspended'
       AND enforcement_expires_at IS NOT NULL AND enforcement_expires_at <= ?`,
    [timestamp]
  );
  for (const server of servers) {
    const action = await db.get(
      `SELECT * FROM moderation_actions WHERE target_type = 'server' AND target_id = ?
         AND action_type = 'SERVER_SUSPENSION' AND status = 'ACTIVE'
       ORDER BY created_at DESC LIMIT 1`,
      [server.id]
    );
    await db.run(
      `UPDATE servers SET enforcement_state = NULL, enforcement_reason = NULL,
         enforcement_expires_at = NULL, enforcement_updated_at = ? WHERE id = ?`,
      [timestamp, server.id]
    );
    await closeAction(action, 'community suspension ended');
    await notify(server.owner_id, action ? action.id : null,
      'The suspension on your community has ended.',
      'moderation:expired:server:' + server.id + ':' + (server.enforcement_expires_at || ''));
    result.servers++;
  }

  // Community bans. The ban row is the live state; the action is history.
  const bans = await db.all(
    `SELECT b.*, s.name AS server_name FROM server_bans b
     JOIN servers s ON s.id = b.server_id
     WHERE b.expires_at IS NOT NULL AND b.expires_at <= ?`,
    [timestamp]
  );
  for (const ban of bans) {
    const action = await db.get(
      `SELECT * FROM moderation_actions WHERE server_id = ? AND target_type = 'user'
         AND target_id = ? AND action_type = 'COMMUNITY_BAN' AND status = 'ACTIVE'
       ORDER BY created_at DESC LIMIT 1`,
      [ban.server_id, ban.user_id]
    );
    await db.run('DELETE FROM server_bans WHERE id = ?', [ban.id]);
    await closeAction(action, 'community ban ended');
    await notify(ban.user_id, action ? action.id : null,
      'Your ban from ' + ban.server_name + ' has ended.',
      'moderation:expired:community-ban:' + ban.id);
    result.bans++;
  }

  // Community timeouts.
  const timeouts = await db.all(
    `SELECT m.server_id, m.user_id, m.timeout_expires_at, s.name AS server_name
     FROM server_members m JOIN servers s ON s.id = m.server_id
     WHERE m.timeout_expires_at IS NOT NULL AND m.timeout_expires_at <= ?`,
    [timestamp]
  );
  for (const row of timeouts) {
    const action = await db.get(
      `SELECT * FROM moderation_actions WHERE server_id = ? AND target_type = 'user'
         AND target_id = ? AND action_type = 'COMMUNITY_TIMEOUT' AND status = 'ACTIVE'
       ORDER BY created_at DESC LIMIT 1`,
      [row.server_id, row.user_id]
    );
    await db.run(
      'UPDATE server_members SET timeout_expires_at = NULL WHERE server_id = ? AND user_id = ?',
      [row.server_id, row.user_id]
    );
    await closeAction(action, 'timeout ended');
    await notify(row.user_id, action ? action.id : null,
      'Your timeout in ' + row.server_name + ' has ended.',
      'moderation:expired:timeout:' + row.server_id + ':' + row.user_id + ':' + row.timeout_expires_at);
    result.timeouts++;
  }

  // Warnings, both platform and community.
  const warnings = await db.all(
    `SELECT * FROM moderation_actions
     WHERE action_type IN ('WARNING', 'COMMUNITY_WARNING')
       AND status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= ?`,
    [timestamp]
  );
  for (const warning of warnings) {
    await closeAction(warning, 'warning expired');
    await notify(warning.target_id, warning.id,
      'A warning on your account has expired.',
      'moderation:expired:warning:' + warning.id);
    result.warnings++;
  }

  // Feature restrictions.
  const restrictions = await db.all(
    `SELECT * FROM user_restrictions
     WHERE lifted_at IS NULL AND expired_at IS NULL
       AND expires_at IS NOT NULL AND expires_at <= ?`,
    [timestamp]
  );
  for (const restriction of restrictions) {
    await db.run('UPDATE user_restrictions SET expired_at = ? WHERE id = ?',
      [timestamp, restriction.id]);
    if (restriction.case_id) {
      await cases.addEvent(restriction.case_id, null, 'RESTRICTION_EXPIRED',
        restriction.kind, { restrictionId: restriction.id, expiredAt: timestamp });
    }
    await notify(restriction.user_id, null,
      'A restriction on your account has ended.',
      'moderation:expired:restriction:' + restriction.id);
    result.restrictions++;
  }

  return result;
}

module.exports = { sweep };

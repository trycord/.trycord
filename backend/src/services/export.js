// Everything this instance holds about the caller, in one response, without
// asking anyone. No queue, no emailed link - those make a person wait on a
// stranger's infrastructure for their own data.
//
// Two rules. Only the caller's own data: a friendship is stored twice, so the
// other person's half is reduced to the fact it existed - they didn't consent to
// their side being exported to you, and their username is the same leak one
// level down. And no secrets: password hashes, TOTP secrets and recovery-code
// hashes aren't the caller's data in any sense a person means by "my data", and
// handing them over turns this into a credential-disclosure endpoint with a
// friendly label.

const db = require('../db');

// One query per section, written out rather than composed from table names at
// runtime, so the set of things an export contains is readable in one screen.
async function collect(userId) {
  const S = {};

  S.account = async () => {
    const u = await db.get(
      `SELECT id, username, display_name, email, email_verified_at, bio,
              status_text, avatar_url, banner_url, is_bot, created_at,
              password_changed_at
       FROM users WHERE id = ?`,
      [userId]
    );
    return u || null;
  };

  S.preferences = async () => {
    const [privacy, notif, wellbeing, blocks, mutes] = await Promise.all([
      db.get('SELECT * FROM privacy_settings WHERE user_id = ?', [userId]),
      db.all('SELECT * FROM notification_prefs WHERE user_id = ?', [userId]),
      db.get('SELECT * FROM wellbeing_settings WHERE user_id = ?', [userId]),
      db.get('SELECT * FROM user_blocks WHERE user_id = ?', [userId]),
      db.all('SELECT * FROM muted_channels WHERE user_id = ?', [userId]),
    ]);
// An absent row means the default, not nothing. Said explicitly so the export
// reads on its own.
    return {
      privacy: privacy || 'defaults (all settings are open)',
      notifications: notif || 'defaults (all categories delivered)',
      wellbeing: wellbeing || 'defaults (no quiet hours, motion not reduced)',
      blockedUsers: blocks ? [blocks] : [],
      mutedChannels: mutes,
    };
  };

// Your half only.
  S.friendships = () => db.all(
    'SELECT friend_id, created_at FROM friendships WHERE user_id = ?', [userId]
  );

  S.friendRequests = async () => {
    const sent = await db.all(
      `SELECT id, to_user_id, status, created_at, updated_at
       FROM friend_requests WHERE from_user_id = ?`, [userId]
    );
    const received = await db.all(
      `SELECT id, from_user_id, status, created_at, updated_at
       FROM friend_requests WHERE to_user_id = ?`, [userId]
    );
    return { sent, received };
  };

  S.communities = () => db.all(
    `SELECT sm.server_id, sm.nickname, sm.joined_at, sm.timeout_expires_at
     FROM server_members sm WHERE sm.user_id = ?`, [userId]
  );

  S.roles = () => db.all(
    `SELECT mr.server_id, r.name, r.color
     FROM member_roles mr JOIN roles r ON r.id = mr.role_id
     WHERE mr.user_id = ?`, [userId]
  );

// channel_messages and dm_messages are both keyed on author_id but are separate
// tables, and both are this person's writing. Kept under their own keys rather
// than merged - a DM and a channel message can share an id and are different
// records. server_id comes from the channel; the message row doesn't carry it.
  S.channelMessages = () => db.all(
    `SELECT m.id, m.channel_id, ch.server_id, m.content, m.created_at, m.edited_at
     FROM messages m LEFT JOIN channels ch ON ch.id = m.channel_id
     WHERE m.author_id = ? ORDER BY m.created_at ASC`,
    [userId]
  );

  S.directMessages = async () => {
    const conversations = await db.all(
      `SELECT conversation_id, joined_at, last_read_at
       FROM dm_members WHERE user_id = ?`, [userId]
    );
    const messages = await db.all(
      `SELECT conversation_id, author_id, content, created_at, edited_at
       FROM dm_messages
       WHERE conversation_id IN (SELECT conversation_id FROM dm_members WHERE user_id = ?)
       ORDER BY created_at ASC`,
      [userId]
    );
    return { conversations, messages };
  };

  S.notifications = () => db.all(
    `SELECT id, type, actor_id, reference_id, created_at, read_at
     FROM notifications WHERE user_id = ? ORDER BY created_at DESC`, [userId]
  );

// Identifiers kept - you need the jti to revoke a session you don't recognise -
// but no tokens, because the table doesn't store any.
  S.sessions = () => db.all(
    `SELECT jti, user_agent, ip, created_at, last_seen_at, revoked_at
     FROM user_sessions WHERE user_id = ? ORDER BY created_at DESC`, [userId]
  );

  S.attachments = () => db.all(
    `SELECT id, message_id, channel_id, filename, mime, size, created_at
     FROM attachments WHERE uploader_id = ?`, [userId]
  );

  S.reactions = () => db.all(
    'SELECT message_id, emoji, created_at FROM reactions WHERE user_id = ?', [userId]
  );

// Reports filed by this person. Reports *about* them are other people's data.
  S.reportsFiled = () => db.all(
    `SELECT id, target_type, target_id, reason, description, status, created_at
     FROM reports WHERE reporter_id = ? ORDER BY created_at DESC`, [userId]
  );

// The audit log is an operator record, but your own actions inside it are
// yours.
  S.accountActivity = () => db.all(
    `SELECT action, target_type, target_id, reason, created_at
     FROM audit_logs WHERE actor_id = ? ORDER BY created_at DESC LIMIT 2000`,
    [userId]
  );

  S.deletionRequests = () => db.all(
    `SELECT id, status, request_type, reason, requested_at, reviewed_at,
            processed_at, cancelled_at, anonymised_at
     FROM account_deletion_requests WHERE user_id = ? ORDER BY requested_at DESC`,
    [userId]
  );

  return S;
}

// Excluded by construction - none of them is in the query list above. Named so
// anyone reading this can find the reason instead of assuming an oversight.
function neverIncluded() {
  return [
    'password hash',
    'TOTP secret',
    'recovery code hash',
    'session token or token identifier',
    'pending email verification token',
  ];
}

// A section that fails does not fail the export. Losing the mute list because
// one row had an odd shape would mean answering "here is everything, except the
// part that broke" - the worst possible failure mode for a data-access
// request.
async function exportAccount(userId) {
  const sections = await collect(userId);
  const out = {
    format: 'trycord-account-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    notice: 'Contains your data held by this Trycord instance. '
      + 'Secrets needed to authenticate as you are deliberately excluded.',
    neverIncluded: neverIncluded(),
    data: {},
  };
  const problems = [];
  for (const [name, read] of Object.entries(sections)) {
    try {
      out.data[name] = await read();
    } catch (e) {
      problems.push(name + ': ' + (e && e.message));
      out.data[name] = null;
    }
  }
  if (problems.length) out.incomplete = problems;
  return out;
}

module.exports = { exportAccount };
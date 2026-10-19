// The relay store and the remote community registry.
//
// Two things live here:
//
//   - The remote communities this instance knows about: a community that lives
//     on another instance, described well enough to be shown, and nothing
//     more. It is not a row in `servers`, it grants no role and no permission
//     here, and the instance it lives on stays the only authority over it.
//
//   - The relay store: the messages, reactions and memberships that arrived
//     from another instance. Everything in it is keyed by (origin instance,
//     origin id), so a remote id can never be mistaken for a local one and
//     the same thing arriving twice lands on the same row.

const db = require('../../db');
const { now, uuid } = require('../../util');

function parseChannels(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ---- remote communities ---------------------------------------------------

// Record a community that lives on another instance.
//
// The channels are stored as they were described by the origin. A channel
// that is not in the list is not one the origin exposes, and the list is
// replaced rather than merged so that a channel the origin has closed stops
// being offered here.
async function upsertCommunity({ originInstanceId, originCommunityId, name, description, iconUrl, channels }) {
  const stamp = now();
  const list = JSON.stringify(Array.isArray(channels) ? channels : []);
  const existing = await findCommunity(originInstanceId, originCommunityId);
  if (existing) {
    await db.run(
      'UPDATE continuum_communities SET name = ?, description = ?, icon_url = ?, channels = ?, synced_at = ?, updated_at = ? '
      + 'WHERE id = ?',
      [
        String(name || existing.name),
        description === undefined ? existing.description : description,
        iconUrl === undefined ? existing.icon_url : iconUrl,
        list, stamp, stamp, existing.id,
      ]
    );
    return findCommunity(originInstanceId, originCommunityId);
  }
  const id = uuid();
  await db.run(
    'INSERT INTO continuum_communities '
    + '(id, origin_instance_id, origin_community_id, name, description, icon_url, channels, state, synced_at, created_at, updated_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id, String(originInstanceId), String(originCommunityId), String(name || 'Unknown community'),
      description == null ? null : String(description),
      iconUrl == null ? null : String(iconUrl),
      list, 'discovered', stamp, stamp, stamp,
    ]
  );
  return findCommunity(originInstanceId, originCommunityId);
}

// Add or replace one channel in a community's channel list.
async function upsertCommunityChannel(originInstanceId, originCommunityId, channel) {
  const community = await findCommunity(originInstanceId, originCommunityId);
  if (!community) return null;
  const channels = parseChannels(community.channels).filter((c) => String(c.id) !== String(channel.id));
  channels.push(channel);
  await db.run(
    'UPDATE continuum_communities SET channels = ?, synced_at = ?, updated_at = ? WHERE id = ?',
    [JSON.stringify(channels), now(), now(), community.id]
  );
  return findCommunity(originInstanceId, originCommunityId);
}

async function findCommunity(originInstanceId, originCommunityId) {
  return db.get(
    'SELECT * FROM continuum_communities WHERE origin_instance_id = ? AND origin_community_id = ?',
    [String(originInstanceId), String(originCommunityId)]
  );
}

async function listCommunities() {
  const rows = await db.all('SELECT * FROM continuum_communities ORDER BY name ASC');
  return rows.map(shapeCommunity);
}

async function findCommunityById(id) {
  const row = await db.get('SELECT * FROM continuum_communities WHERE id = ?', [String(id)]);
  return row ? shapeCommunity(row) : null;
}

function shapeCommunity(row) {
  return {
    ...row,
    channels: parseChannels(row.channels),
  };
}

async function setCommunityState(originInstanceId, originCommunityId, state) {
  await db.run(
    'UPDATE continuum_communities SET state = ?, updated_at = ? WHERE origin_instance_id = ? AND origin_community_id = ?',
    [state, now(), String(originInstanceId), String(originCommunityId)]
  );
  return findCommunity(originInstanceId, originCommunityId);
}

// ---- local membership of a remote community --------------------------------

// Which local account follows which remote community. This is a local record
// and nothing more: it says that the person joined a community that lives
// somewhere else, and it carries no authority over it.
async function upsertMembership({ userId, originInstanceId, originCommunityId, state }) {
  const stamp = now();
  const existing = await db.get(
    'SELECT * FROM continuum_memberships WHERE user_id = ? AND origin_instance_id = ? AND origin_community_id = ?',
    [String(userId), String(originInstanceId), String(originCommunityId)]
  );
  if (existing) {
    await db.run(
      'UPDATE continuum_memberships SET state = ?, updated_at = ? WHERE id = ?',
      [state, stamp, existing.id]
    );
    return existing.id;
  }
  const id = uuid();
  await db.run(
    'INSERT INTO continuum_memberships (id, user_id, origin_instance_id, origin_community_id, state, created_at, updated_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, String(userId), String(originInstanceId), String(originCommunityId), state, stamp, stamp]
  );
  return id;
}

async function listMemberships(userId) {
  if (!userId) return [];
  return db.all(
    'SELECT * FROM continuum_memberships WHERE user_id = ? ORDER BY created_at DESC',
    [String(userId)]
  );
}

async function findMembership(userId, originInstanceId, originCommunityId) {
  return db.get(
    'SELECT * FROM continuum_memberships WHERE user_id = ? AND origin_instance_id = ? AND origin_community_id = ?',
    [String(userId), String(originInstanceId), String(originCommunityId)]
  );
}

// ---- relayed messages -----------------------------------------------------

// Store a message that arrived from another instance. Applying the same
// message twice leaves the same row: the key is the origin's id, not a row
// this instance made up.
async function upsertRelayMessage(message) {
  const stamp = now();
  const existing = await db.get(
    'SELECT * FROM continuum_relay_messages WHERE origin_instance_id = ? AND origin_message_id = ?',
    [String(message.originInstanceId), String(message.originMessageId)]
  );
  if (existing) {
    await db.run(
      'UPDATE continuum_relay_messages SET origin_community_id = ?, origin_channel_id = ?, author_origin_id = ?, '
      + 'author_username = ?, author_display_name = ?, content = ?, edited_at = ?, deleted_at = ?, thread_root_id = ?, '
      + 'event_id = ?, relayed_at = ? WHERE id = ?',
      [
        String(message.originCommunityId), String(message.originChannelId), String(message.authorOriginId),
        message.authorUsername || null, message.authorDisplayName || null,
        message.content === undefined ? existing.content : message.content,
        message.editedAt === undefined ? existing.edited_at : message.editedAt,
        message.deletedAt === undefined ? existing.deleted_at : message.deletedAt,
        message.threadRootId === undefined ? existing.thread_root_id : message.threadRootId,
        message.eventId || null, stamp, existing.id,
      ]
    );
    return existing.id;
  }
  const id = uuid();
  await db.run(
    'INSERT INTO continuum_relay_messages '
    + '(id, origin_instance_id, origin_message_id, origin_community_id, origin_channel_id, author_origin_id, '
    + 'author_username, author_display_name, content, created_at, edited_at, deleted_at, thread_root_id, event_id, relayed_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id, String(message.originInstanceId), String(message.originMessageId), String(message.originCommunityId),
      String(message.originChannelId), String(message.authorOriginId),
      message.authorUsername || null, message.authorDisplayName || null,
      message.content === undefined ? null : message.content,
      String(message.createdAt), message.editedAt || null, message.deletedAt || null,
      message.threadRootId || null, message.eventId || null, stamp,
    ]
  );
  return id;
}

async function findRelayMessage(originInstanceId, originMessageId) {
  return db.get(
    'SELECT * FROM continuum_relay_messages WHERE origin_instance_id = ? AND origin_message_id = ?',
    [String(originInstanceId), String(originMessageId)]
  );
}

// The relayed messages of one remote community, oldest first, with the
// reactions that arrived for them.
async function listRelayMessages(originInstanceId, originCommunityId, { limit } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = await db.all(
    'SELECT * FROM continuum_relay_messages WHERE origin_instance_id = ? AND origin_community_id = ? '
    + 'ORDER BY created_at ASC, id ASC LIMIT ' + cap,
    [String(originInstanceId), String(originCommunityId)]
  );
  const shaped = [];
  for (const row of rows) {
    const message = shapeRelayMessage(row);
    message.reactions = await listRelayReactions(originInstanceId, row.origin_message_id);
    shaped.push(message);
  }
  return shaped;
}

async function listAllRelayMessages({ limit } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = await db.all(
    'SELECT * FROM continuum_relay_messages ORDER BY relayed_at DESC LIMIT ' + cap
  );
  return rows.map(shapeRelayMessage);
}

// A relayed message is presented as a relayed message: it keeps the origin's
// timestamp and the origin's author, and it says where it came from.
function shapeRelayMessage(row) {
  return {
    id: row.id,
    relayed: true,
    origin_instance_id: row.origin_instance_id,
    origin_message_id: row.origin_message_id,
    origin_community_id: row.origin_community_id,
    origin_channel_id: row.origin_channel_id,
    author_origin_id: row.author_origin_id,
    author_username: row.author_username,
    author_display_name: row.author_display_name,
    content: row.deleted_at ? null : row.content,
    created_at: row.created_at,
    edited_at: row.edited_at,
    deleted_at: row.deleted_at,
    deleted: !!row.deleted_at,
    thread_root_id: row.thread_root_id,
    relayed_at: row.relayed_at,
  };
}

// ---- relayed reactions ----------------------------------------------------

async function upsertRelayReaction(reaction) {
  const stamp = now();
  const existing = await db.get(
    'SELECT * FROM continuum_relay_reactions WHERE origin_instance_id = ? AND origin_message_id = ? '
    + 'AND origin_user_id = ? AND emoji = ?',
    [
      String(reaction.originInstanceId), String(reaction.originMessageId),
      String(reaction.originUserId), String(reaction.emoji),
    ]
  );
  if (existing) {
    await db.run(
      'UPDATE continuum_relay_reactions SET username = ?, display_name = ?, relayed_at = ? WHERE id = ?',
      [reaction.username || null, reaction.displayName || null, stamp, existing.id]
    );
    return existing.id;
  }
  const id = uuid();
  await db.run(
    'INSERT INTO continuum_relay_reactions '
    + '(id, origin_instance_id, origin_message_id, origin_user_id, username, display_name, emoji, created_at, relayed_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id, String(reaction.originInstanceId), String(reaction.originMessageId), String(reaction.originUserId),
      reaction.username || null, reaction.displayName || null, String(reaction.emoji),
      String(reaction.createdAt), stamp,
    ]
  );
  return id;
}

async function removeRelayReaction(originInstanceId, originMessageId, originUserId, emoji) {
  await db.run(
    'DELETE FROM continuum_relay_reactions WHERE origin_instance_id = ? AND origin_message_id = ? '
    + 'AND origin_user_id = ? AND emoji = ?',
    [String(originInstanceId), String(originMessageId), String(originUserId), String(emoji)]
  );
}

async function listRelayReactions(originInstanceId, originMessageId) {
  const rows = await db.all(
    'SELECT * FROM continuum_relay_reactions WHERE origin_instance_id = ? AND origin_message_id = ? '
    + 'ORDER BY created_at ASC',
    [String(originInstanceId), String(originMessageId)]
  );
  return rows.map((row) => ({
    id: row.id,
    relayed: true,
    origin_instance_id: row.origin_instance_id,
    origin_message_id: row.origin_message_id,
    origin_user_id: row.origin_user_id,
    username: row.username,
    display_name: row.display_name,
    emoji: row.emoji,
    created_at: row.created_at,
  }));
}

// ---- remote members of this instance's communities ------------------------

// A member of one of this instance's communities who lives on another
// instance. This instance decides what such a member may do; the row is the
// record of them, and it grants nothing.
async function upsertRelayMembership(membership) {
  const stamp = now();
  const existing = await db.get(
    'SELECT * FROM continuum_relay_memberships WHERE origin_instance_id = ? AND origin_community_id = ? '
    + 'AND origin_user_id = ?',
    [
      String(membership.originInstanceId), String(membership.originCommunityId),
      String(membership.originUserId),
    ]
  );
  if (existing) {
    await db.run(
      'UPDATE continuum_relay_memberships SET username = ?, display_name = ?, state = ?, joined_at = ?, updated_at = ? '
      + 'WHERE id = ?',
      [
        membership.username || existing.username,
        membership.displayName === undefined ? existing.display_name : membership.displayName,
        membership.state || existing.state,
        membership.joinedAt === undefined ? existing.joined_at : membership.joinedAt,
        stamp, existing.id,
      ]
    );
    return existing.id;
  }
  const id = uuid();
  await db.run(
    'INSERT INTO continuum_relay_memberships '
    + '(id, origin_instance_id, origin_community_id, origin_user_id, username, display_name, state, joined_at, updated_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id, String(membership.originInstanceId), String(membership.originCommunityId),
      String(membership.originUserId), membership.username || null,
      membership.displayName === undefined ? null : membership.displayName,
      membership.state || 'joined', membership.joinedAt || null, stamp,
    ]
  );
  return id;
}

async function listRelayMemberships({ originCommunityId, originInstanceId } = {}) {
  const clauses = [];
  const args = [];
  if (originCommunityId) { clauses.push('origin_community_id = ?'); args.push(String(originCommunityId)); }
  if (originInstanceId) { clauses.push('origin_instance_id = ?'); args.push(String(originInstanceId)); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  return db.all(
    'SELECT * FROM continuum_relay_memberships ' + where + ' ORDER BY updated_at DESC',
    args
  );
}

module.exports = {
  parseChannels,
  upsertCommunity,
  upsertCommunityChannel,
  findCommunity,
  listCommunities,
  findCommunityById,
  setCommunityState,
  upsertMembership,
  listMemberships,
  findMembership,
  upsertRelayMessage,
  findRelayMessage,
  listRelayMessages,
  listAllRelayMessages,
  shapeRelayMessage,
  upsertRelayReaction,
  removeRelayReaction,
  listRelayReactions,
  upsertRelayMembership,
  listRelayMemberships,
};

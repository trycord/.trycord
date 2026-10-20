// Moderating what a member of this instance's community wrote elsewhere.
//
// The community is this instance's, so the rules are this instance's and the
// tools are this instance's. A member of one of these communities writes on
// another instance, the message arrives here, and it is kept as a relayed
// message: it is not a local message, it grants nothing here, and it is
// nobody's - but the owner of the community has to be able to see it, take
// it back, and say who did what.
//
// Everything done here is recorded in the audit trail, the same trail the
// local moderation writes to.

const db = require('../../db');
const { now, uuid } = require('../../util');
const enforcement = require('../enforcement');
const permissions = require('../permissions');
const store = require('./store');

// The trail. A moderation action that happened is a fact about the instance,
// and a fact that is not recorded is a fact nobody can act on.
async function recordAudit(actor, action, targetType, targetId, reason, serverId) {
  try {
    await db.run(
      'INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, server_id, created_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        uuid(), actor.id, action, targetType, targetId ? String(targetId) : null,
        reason ? String(reason).slice(0, 500) : null, serverId || null, now(),
      ]
    );
  } catch (e) {
    // The trail is never worth failing the action it records, but a trail
    // that silently stopped recording is worse than a noisy one.
    console.error('[continuum] the moderation trail could not be written:', String(e && e.message || e));
  }
}

// May this person moderate in this community?
//
// A platform administrator is not the owner of every community, and a
// community moderator is not a platform administrator. Either may do it: the
// one who runs the instance, and the one who runs the community.
async function assertModerator(actor, communityId) {
  if (await enforcement.isPlatformAdmin(actor.id)) return;
  const allowed = await permissions.hasChannelPermission(actor.id, communityId, null, 'MANAGE_MESSAGES');
  if (!allowed) {
    throw { code: 'PERMISSION_DENIED', message: 'you may not moderate in that community' };
  }
}

// The communities this person may moderate in. Null means all of them: a
// platform administrator runs the instance, and the instance's communities
// are its business.
async function moderateableCommunities(actor) {
  if (await enforcement.isPlatformAdmin(actor.id)) return null;
  const rows = await db.all('SELECT DISTINCT server_id FROM member_roles WHERE user_id = ?', [actor.id]);
  const allowed = [];
  for (const row of rows) {
    if (await permissions.hasChannelPermission(actor.id, row.server_id, null, 'MANAGE_MESSAGES')) {
      allowed.push(String(row.server_id));
    }
  }
  return allowed;
}

// The messages members of this instance's communities wrote elsewhere.
//
// This is the moderation surface: what a member of one of these communities
// wrote on another instance, in the community it belongs to, with the
// author's name as the other instance had it.
async function listMessages({ actor, communityId, limit } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);

  if (communityId) {
    const community = await db.get('SELECT id FROM servers WHERE id = ?', [String(communityId)]);
    if (!community) throw { code: 'NOT_FOUND', message: 'no such community' };
    await assertModerator(actor, community.id);
    const rows = await db.all(
      'SELECT * FROM continuum_relay_messages WHERE origin_community_id = ? '
      + 'ORDER BY created_at DESC, id DESC LIMIT ' + cap,
      [String(communityId)]
    );
    return rows.map(store.shapeRelayMessage);
  }

  const allowed = await moderateableCommunities(actor);
  const all = await store.listRelayMessagesForLocalCommunities({ limit: 500 });
  if (allowed === null) return all.slice(0, cap);
  return all.filter((message) => allowed.includes(String(message.origin_community_id))).slice(0, cap);
}

// Take back a message a member wrote on another instance.
//
// The message goes from here, and the instance that wrote it is told, so the
// copy over there does not outlive this one.
async function removeMessage({ actor, originInstanceId, originMessageId, reason, publish }) {
  const message = await store.findRelayMessage(originInstanceId, originMessageId);
  if (!message) throw { code: 'NOT_FOUND', message: 'no such message' };

  // It has to be about a community of this instance. It is this instance's
  // to take back - a message in somebody else's community is not.
  const community = await db.get('SELECT id FROM servers WHERE id = ?', [message.origin_community_id]);
  if (!community) {
    throw { code: 'PERMISSION_DENIED', message: 'that message is not in a community of this instance' };
  }
  await assertModerator(actor, community.id);
  if (message.deleted_at) {
    throw { code: 'CONFLICT', message: 'the message has already been removed' };
  }

  // It is removed here first, so that the moderation surface says so even if
  // the peer cannot be reached.
  await store.upsertRelayMessage({
    originInstanceId: message.origin_instance_id,
    originMessageId: message.origin_message_id,
    originCommunityId: message.origin_community_id,
    originChannelId: message.origin_channel_id,
    authorOriginId: message.author_origin_id,
    authorUsername: message.author_username,
    authorDisplayName: message.author_display_name,
    deletedAt: now(),
    content: null,
    eventId: message.event_id,
  });

  const result = await publish('message.deleted', {
    sourceKind: 'relay_message',
    relayMessageId: message.id,
    serverId: message.origin_community_id,
    channelId: message.origin_channel_id,
    messageId: message.origin_message_id,
    messageOwnerId: message.origin_instance_id,
    authorId: message.author_origin_id,
    username: message.author_username,
    displayName: message.author_display_name,
    createdAt: message.created_at,
    occurredAt: now(),
    destination: message.origin_instance_id,
  }, { destination: message.origin_instance_id, actorId: String(actor.id) });

  await recordAudit(
    actor, 'relay_message_remove', 'relay_message',
    message.origin_instance_id + ':' + message.origin_message_id,
    reason, community.id
  );

  return {
    ok: true,
    origin_instance_id: message.origin_instance_id,
    origin_message_id: message.origin_message_id,
    origin_community_id: message.origin_community_id,
    removed: true,
    relayed: !!(result && result.ok),
    reason: result && result.ok ? null : (result && result.reason) || null,
  };
}

// Mute or remove a member of one of this instance's communities who lives on
// another instance.
//
// The decision is this instance's: it is the owner of the community, and it
// is the one that enforces it. A member who is muted here is refused when
// they write, and the refusal says why. The member's own instance is told,
// so the member stops writing rather than finding out one message at a time.
async function restrictMember({
  actor, originInstanceId, originUserId, communityId, action, reason, publish,
}) {
  const actions = { mute: 'muted', remove: 'removed', restore: 'joined' };
  const state = actions[String(action || '')];
  if (!state) throw { code: 'VALIDATION_ERROR', message: 'action must be mute, remove or restore' };

  const member = await store.findRelayMembership(originInstanceId, communityId, originUserId);
  if (!member) throw { code: 'NOT_FOUND', message: 'no such member of that community' };
  const community = await db.get('SELECT id, name FROM servers WHERE id = ?', [String(communityId)]);
  if (!community) throw { code: 'NOT_FOUND', message: 'no such community' };
  await assertModerator(actor, community.id);

  await store.setRelayMembershipState(originInstanceId, communityId, originUserId, state);

  const result = await publish('membership.updated', {
    serverId: community.id,
    communityName: community.name,
    userId: originUserId,
    memberInstanceId: originInstanceId,
    username: member.username,
    displayName: member.display_name,
    state,
    actorId: String(actor.id),
    occurredAt: now(),
    destination: originInstanceId,
  }, { destination: originInstanceId, actorId: String(actor.id) });

  await recordAudit(
    actor, 'relay_member_' + String(action), 'relay_member',
    originInstanceId + ':' + originUserId, reason, community.id
  );

  return {
    ok: true,
    origin_instance_id: originInstanceId,
    origin_user_id: originUserId,
    origin_community_id: community.id,
    state,
    relayed: !!(result && result.ok),
    reason: result && result.ok ? null : (result && result.reason) || null,
  };
}

// The members of this instance's communities who live on another instance,
// with what this instance has decided about them.
async function listMembers({ actor, communityId, limit } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
  if (communityId) {
    const community = await db.get('SELECT id FROM servers WHERE id = ?', [String(communityId)]);
    if (!community) throw { code: 'NOT_FOUND', message: 'no such community' };
    await assertModerator(actor, community.id);
    const rows = await db.all(
      'SELECT * FROM continuum_relay_memberships WHERE origin_community_id = ? ORDER BY updated_at DESC LIMIT ' + cap,
      [String(communityId)]
    );
    return rows;
  }
  const allowed = await moderateableCommunities(actor);
  const rows = await store.listRelayMembersOfLocalCommunities({ communityId });
  if (allowed === null) return rows.slice(0, cap);
  return rows
    .filter((member) => allowed.includes(String(member.origin_community_id)))
    .slice(0, cap);
}

module.exports = {
  listMessages,
  removeMessage,
  restrictMember,
  listMembers,
  assertModerator,
};

// The inbound side.
//
// Two jobs: decide whether an event may be applied, and apply it.
//
// An event that arrives is checked in this order, and each check refuses
// before the next one runs:
//
//   1. the peer it claims to come from is one this instance knows and
//      trusts, and the signature verifies against the key recorded for it
//      (done by the caller, which owns the key material)
//   2. the event id has not been seen before
//   3. its timestamp is a real time, near enough to now
//   4. its kind is part of the vocabulary and its payload is well formed
//   5. its sequence is newer than the highest already accepted from that
//      (origin, actor)
//
// Only then is it stored and applied. The checks are deliberately in that
// order: the cheap ones come first, and none of them depends on a later
// one.

const db = require('../../db');
const { now } = require('../../util');
const events = require('./events');
const store = require('./store');
const rules = require('./rules');

// Is this envelope's timestamp acceptable?
function checkTimestamp(envelope) {
  const parsed = events.acceptableTimestamp(envelope.timestamp);
  if (parsed === null) {
    return { ok: false, reason: 'the event timestamp is missing, unparseable, or too far from now' };
  }
  return { ok: true, at: parsed };
}

// Is this envelope's kind and payload acceptable?
function checkShape(envelope) {
  if (!events.isKnownKind(envelope.kind)) {
    return { ok: false, reason: 'unknown event kind' };
  }
  const payload = events.validatePayload(envelope.kind, envelope.payload);
  if (!payload.ok) return payload;
  if (rules.encryptedContent(envelope.payload)) {
    return { ok: false, reason: 'encrypted content is never federated' };
  }
  return { ok: true };
}

// Apply one accepted event to the relay store.
//
// The store is keyed by (origin instance, origin id), so applying the same
// event twice leaves the same state: a message that arrives twice is one
// relayed message, and an edit that arrives twice is the same edit.
async function apply(event) {
  const originInstanceId = String(event.instance_id);
  const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
  const origin = payload.origin;
  const kind = event.kind;

  if (events.isSubjectKind(kind, 'community')) {
    await store.upsertCommunity({
      originInstanceId,
      originCommunityId: payload.community.id,
      name: payload.community.name,
      description: payload.community.description,
      iconUrl: payload.community.icon_url,
      channels: payload.community.channels,
    });
    return { applied: true, subject: 'community', originInstanceId, originCommunityId: payload.community.id };
  }

  if (events.isSubjectKind(kind, 'channel')) {
    const communityId = origin.community_origin_id;
    // The community has to be known before its channels can be filed under
    // it. A channel event for a community this instance has never heard of
    // creates a placeholder: the community's own event fills in the rest.
    const known = await store.findCommunity(originInstanceId, communityId);
    if (!known) {
      await store.upsertCommunity({
        originInstanceId,
        originCommunityId: communityId,
        name: payload.community ? payload.community.name : 'Unknown community',
        description: payload.community ? payload.community.description : undefined,
        iconUrl: payload.community ? payload.community.icon_url : undefined,
        channels: [],
      });
    }
    await store.upsertCommunityChannel(originInstanceId, communityId, payload.channel);
    return { applied: true, subject: 'channel', originInstanceId, originCommunityId: communityId };
  }

  if (events.isSubjectKind(kind, 'message')) {
    const messageId = origin.message_origin_id || payload.message.id;
    const known = await store.findRelayMessage(originInstanceId, messageId);
    if (kind === 'message.deleted') {
      if (!known) {
        // A deletion for a message this instance never saw is a no-op, not an
        // error: the outcome the sender wanted - the message is not here -
        // is already true.
        return { applied: false, subject: 'message', reason: 'no such message', originInstanceId, originCommunityId: origin.community_origin_id };
      }
      await store.upsertRelayMessage({
        originInstanceId,
        originMessageId: messageId,
        originCommunityId: origin.community_origin_id,
        originChannelId: origin.channel_origin_id,
        authorOriginId: origin.actor_id,
        authorUsername: origin.author_username,
        authorDisplayName: origin.author_display_name,
        deletedAt: origin.occurred_at,
        content: null,
        eventId: event.event_id,
      });
      return {
        applied: true,
        subject: 'message',
        deleted: true,
        originInstanceId,
        originCommunityId: origin.community_origin_id,
        originMessageId: messageId,
      };
    }
    await store.upsertRelayMessage({
      originInstanceId,
      originMessageId: messageId,
      originCommunityId: origin.community_origin_id,
      originChannelId: origin.channel_origin_id,
      authorOriginId: origin.actor_id,
      authorUsername: origin.author_username,
      authorDisplayName: origin.author_display_name,
      content: payload.message.content,
      createdAt: payload.message.created_at || origin.occurred_at,
      editedAt: payload.message.edited_at || null,
      threadRootId: origin.thread_root_origin_id || null,
      eventId: event.event_id,
    });
    return {
      applied: true,
      subject: 'message',
      originInstanceId,
      originCommunityId: origin.community_origin_id,
      originMessageId: messageId,
    };
  }

  if (events.isSubjectKind(kind, 'reaction')) {
    const reaction = payload.reaction;
    if (kind === 'reaction.removed') {
      await store.removeRelayReaction(originInstanceId, reaction.message_id, reaction.user_id, reaction.emoji);
      return {
        applied: true,
        subject: 'reaction',
        removed: true,
        originInstanceId,
        originCommunityId: origin.community_origin_id,
        originMessageId: reaction.message_id,
      };
    }
    await store.upsertRelayReaction({
      originInstanceId,
      originMessageId: reaction.message_id,
      originUserId: reaction.user_id,
      username: reaction.username,
      displayName: reaction.display_name,
      emoji: reaction.emoji,
      createdAt: reaction.created_at || origin.occurred_at,
    });
    return {
      applied: true,
      subject: 'reaction',
      originInstanceId,
      originCommunityId: origin.community_origin_id,
      originMessageId: reaction.message_id,
    };
  }

  if (events.isSubjectKind(kind, 'membership')) {
    const communityId = origin.community_origin_id;
    // This instance decides who may join its communities. A join for a
    // community that does not exist here, or for one that is not federated,
    // is recorded and not applied: the origin's authority is its own.
    const community = await db.get('SELECT id, is_public FROM servers WHERE id = ?', [communityId]);
    if (!community) return { applied: false, subject: 'membership', reason: 'no such community' };
    if (!community.is_public) return { applied: false, subject: 'membership', reason: 'the community is private' };
    await store.upsertRelayMembership({
      originInstanceId,
      originCommunityId: communityId,
      originUserId: payload.membership.user_id,
      username: payload.membership.username,
      displayName: payload.membership.display_name,
      state: kind === 'membership.left' ? 'left' : 'joined',
      joinedAt: kind === 'membership.joined' ? now() : undefined,
    });
    return { applied: true, subject: 'membership' };
  }

  return { applied: false, subject: null, reason: 'unknown event kind' };
}

// The local accounts that follow a remote community, so a relayed message can
// be pushed to the people who are actually there.
async function localFollowers(originInstanceId, originCommunityId) {
  const rows = await db.all(
    'SELECT user_id FROM continuum_memberships WHERE origin_instance_id = ? AND origin_community_id = ? AND state = ?',
    [String(originInstanceId), String(originCommunityId), 'joined']
  );
  return rows.map((row) => String(row.user_id));
}

module.exports = {
  checkTimestamp,
  checkShape,
  apply,
  localFollowers,
};

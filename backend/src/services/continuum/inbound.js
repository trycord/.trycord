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
//
// An event that arrives is also either about a community this instance owns
// or about one it does not, and the two are governed by different rules. A
// message about a community this instance owns, written by a member on
// another instance, is answered here: this instance is the authority over
// its community, and it applies its own rules - the same rules the outbound
// direction applies, asked of the other side.

const db = require('../../db');
const { now } = require('../../util');
const events = require('./events');
const identity = require('./identity');
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

// A message a member of one of this instance's communities wrote on another
// instance.
//
// This instance owns the community, so this instance decides. The rules are
// the same rules the outbound direction applies, asked the other way round:
// the community has to still be federated, the channel has to be one the
// members may post in, and the writer has to be a member here who may write.
// A member who may not post in the channel does not post there by writing to
// a federated copy of it.
//
// A refusal is not silence: the writer is told, here and now, because a
// message that vanishes without a word is worse than one that is refused.
async function applyReturnMessage(event, origin, payload, publish) {
  const serverId = origin.community_origin_id;
  const channelId = origin.channel_origin_id;
  const originInstanceId = origin.instance_id;
  const authorId = origin.actor_id;
  const messageId = origin.message_origin_id || payload.message.id;

  const gate = await rules.mayAcceptRemoteMessage({
    serverId,
    channelId,
    originInstanceId,
    originUserId: authorId,
  });

  if (!gate.ok) {
    if (publish) {
      await publish('message.refused', {
        sourceKind: 'decision',
        decision: 'refused',
        reason: gate.reason,
        serverId,
        channelId,
        messageId,
        originInstanceId,
        authorId,
        messageOwnerId: originInstanceId,
        actorId: events.PROTOCOL_ACTOR,
        occurredAt: now(),
        destination: originInstanceId,
      }, { destination: originInstanceId });
    }
    return {
      applied: false,
      subject: 'message',
      refused: true,
      reason: gate.reason,
      originInstanceId,
      originCommunityId: serverId,
      originMessageId: messageId,
    };
  }

  // It is kept as a relayed message: the origin's author, the origin's
  // timestamps, the origin's ids. It is not a local message - it grants
  // nothing here and it is nobody's - and it is the owner's to moderate.
  //
  // A deletion is the same message taken back: the copy here goes, so that
  // it does not outlive the original.
  const deletion = kind === 'message.deleted';
  await store.upsertRelayMessage({
    originInstanceId,
    originMessageId: messageId,
    originCommunityId: serverId,
    originChannelId: channelId,
    authorOriginId: authorId,
    authorUsername: origin.author_username,
    authorDisplayName: origin.author_display_name,
    content: deletion ? null : payload.message.content,
    createdAt: payload.message.created_at || origin.occurred_at,
    editedAt: payload.message.edited_at || null,
    deletedAt: deletion ? (origin.occurred_at || now()) : null,
    threadRootId: origin.thread_root_origin_id || null,
    eventId: event.event_id,
  });

  // The owner answers about a message, but not about a message that is
  // gone: there is nothing left to accept.
  if (publish && !deletion) {
    await publish('message.accepted', {
      sourceKind: 'decision',
      decision: 'accepted',
      reason: null,
      serverId,
      channelId,
      messageId,
      originInstanceId,
      authorId,
      messageOwnerId: originInstanceId,
      actorId: events.PROTOCOL_ACTOR,
      occurredAt: now(),
      destination: originInstanceId,
    }, { destination: originInstanceId });
  }

  return {
    applied: true,
    subject: 'message',
    originInstanceId,
    originCommunityId: serverId,
    originMessageId: messageId,
    authorOriginId: authorId,
  };
}

// The owner's answer about a message this instance wrote.
//
// The answer arrives at the instance that wrote the message, which is the
// one that knows what to do with it: the writer's message is marked as
// taken, or as refused with the reason the owner gave.
async function applyDecision(event, origin, payload) {
  const decision = payload.decision;
  const messageId = origin.message_origin_id;
  const owner = origin.message_owner_id || origin.instance_id;
  if (owner !== identity.getInstanceId()) {
    return {
      applied: false,
      subject: 'decision',
      reason: 'the decision is not about a message of this instance',
    };
  }
  const outgoing = await store.findOutgoing(messageId);
  if (!outgoing) {
    return { applied: false, subject: 'decision', reason: 'no such message' };
  }
  await store.updateOutgoing(outgoing.id, {
    state: decision.decision === 'accepted' ? 'accepted' : 'refused',
    reason: decision.reason || null,
    decidedAt: now(),
  });
  return {
    applied: true,
    subject: 'decision',
    decision: decision.decision,
    reason: decision.reason || null,
    authorId: outgoing.author_id,
    originInstanceId: origin.instance_id,
    originCommunityId: outgoing.origin_community_id,
    originMessageId: messageId,
  };
}

// Apply one accepted event to the relay store.
//
// The store is keyed by (origin instance, origin id), so applying the same
// event twice leaves the same state: a message that arrives twice is one
// relayed message, and an edit that arrives twice is the same edit.
async function apply(event, options = {}) {
  const publish = options.publish;
  const originInstanceId = String(event.instance_id);
  const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
  const origin = payload.origin;
  const kind = event.kind;
  const instanceId = identity.getInstanceId();

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

  if (events.isSubjectKind(kind, 'decision')) {
    return applyDecision(event, origin, payload);
  }

  if (events.isSubjectKind(kind, 'message')) {
    const messageId = origin.message_origin_id || payload.message.id;
    const serverId = origin.community_origin_id;

    // Which way does this message travel? A message about a community this
    // instance owns was written here by a member on another instance, and it
    // is this instance's to accept or refuse.
    const local = await db.get('SELECT id FROM servers WHERE id = ?', [serverId]);
    const direction = events.directionOf(origin, instanceId, !!local);
    if (direction === 'foreign') {
      return {
        applied: false,
        subject: 'message',
        reason: 'the event is about a community that neither instance owns',
        originInstanceId,
        originCommunityId: serverId,
      };
    }
    if (direction === 'return') {
      return applyReturnMessage(event, origin, payload, publish);
    }

    // The message this instance owns, taken back at its owner.
    const messageOwner = origin.message_owner_id || origin.instance_id;
    if (messageOwner === instanceId && kind === 'message.deleted') {
      const outgoing = await store.findOutgoing(messageId);
      if (!outgoing) {
        return {
          applied: false,
          subject: 'message',
          reason: 'no such message',
          originInstanceId,
          originCommunityId: serverId,
        };
      }
      await store.updateOutgoing(outgoing.id, {
        state: 'deleted',
        deletedAt: origin.occurred_at,
        decidedAt: now(),
      });
      return {
        applied: true,
        subject: 'message',
        deleted: true,
        authorId: outgoing.author_id,
        originInstanceId,
        originCommunityId: serverId,
        originMessageId: messageId,
      };
    }

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
    const memberInstanceId = payload.membership.member_instance_id || origin.instance_id;

    // The owner changing a member's standing. Only the owner may do it: a
    // peer that says "this member is muted" about somebody else's community
    // is not believed.
    if (kind === 'membership.updated') {
      const owner = origin.community_owner_id || origin.instance_id;
      if (owner !== origin.instance_id) {
        return {
          applied: false,
          subject: 'membership',
          reason: 'only the owner of a community may change a member\'s standing',
        };
      }
      // The change reaches the instance the member lives on, and nowhere else.
      if (memberInstanceId !== instanceId) {
        return {
          applied: false,
          subject: 'membership',
          reason: 'the member does not live on this instance',
        };
      }
      const membership = await store.findMembership(
        payload.membership.user_id, origin.instance_id, communityId
      );
      if (!membership) {
        return { applied: false, subject: 'membership', reason: 'no such membership' };
      }
      await store.upsertMembership({
        userId: payload.membership.user_id,
        originInstanceId: origin.instance_id,
        originCommunityId: communityId,
        state: payload.membership.state,
      });
      return {
        applied: true,
        subject: 'membership',
        state: payload.membership.state,
        userId: payload.membership.user_id,
        originInstanceId: origin.instance_id,
        originCommunityId: communityId,
      };
    }

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

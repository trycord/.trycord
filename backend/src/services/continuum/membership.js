// Joining and leaving a community that lives on another instance.
//
// Joining is a local record and one relayed event:
//
//   - the local account is recorded as following that remote community
//   - a membership.joined event is addressed to the instance that owns the
//     community, and that instance records the member against its own
//     community
//
// What joining does not do is give the person any authority over the
// community. They get no role, no permission and no moderation power here or
// there: the instance that owns the community decides what a member of it
// may do, and that instance is the one that enforces it.

const db = require('../../db');
const { now } = require('../../util');
const store = require('./store');
const remoteCommunities = require('./remote-communities');

// The instance that owns the community has to be a trusted peer. Joining a
// community on an instance this instance does not trust would send the
// member's identity to an instance the operator has not vouched for.
async function trustedPeer(originInstanceId) {
  const peer = await db.get('SELECT * FROM continuum_instances WHERE id = ?', [String(originInstanceId)]);
  if (!peer) throw { code: 'NOT_FOUND', message: 'that instance is not known here' };
  if (peer.trust_status !== 'trusted') {
    throw { code: 'PERMISSION_DENIED', message: 'that instance is not trusted' };
  }
  return peer;
}

async function join({ user, originInstanceId, originCommunityId, publish }) {
  const community = await store.findCommunity(originInstanceId, originCommunityId);
  if (!community) {
    throw { code: 'NOT_FOUND', message: 'that community is not known here' };
  }
  await trustedPeer(originInstanceId);

  await store.upsertMembership({
    userId: user.id,
    originInstanceId,
    originCommunityId,
    state: 'joined',
  });
  await remoteCommunities.setRelationshipState(originInstanceId, originCommunityId, 'joined');

  const result = await publish('membership.joined', {
    serverId: String(originCommunityId),
    communityName: community.name,
    userId: String(user.id),
    username: user.username,
    displayName: user.display_name || user.username,
    state: 'joined',
    occurredAt: now(),
  }, { destination: String(originInstanceId), actorId: String(user.id) });

  return {
    origin_instance_id: String(originInstanceId),
    origin_community_id: String(originCommunityId),
    state: 'joined',
    relayed: !!(result && result.ok),
  };
}

async function leave({ user, originInstanceId, originCommunityId, publish }) {
  const community = await store.findCommunity(originInstanceId, originCommunityId);
  if (!community) {
    throw { code: 'NOT_FOUND', message: 'that community is not known here' };
  }
  await trustedPeer(originInstanceId);

  const existing = await store.findMembership(user.id, originInstanceId, originCommunityId);
  if (!existing) {
    throw { code: 'NOT_A_MEMBER', message: 'you have not joined that community' };
  }

  await store.upsertMembership({
    userId: user.id,
    originInstanceId,
    originCommunityId,
    state: 'left',
  });
  const relationship = await remoteCommunities.relationshipState(originInstanceId, originCommunityId);
  await remoteCommunities.setRelationshipState(originInstanceId, originCommunityId, relationship);

  const result = await publish('membership.left', {
    serverId: String(originCommunityId),
    communityName: community.name,
    userId: String(user.id),
    username: user.username,
    displayName: user.display_name || user.username,
    state: 'left',
    occurredAt: now(),
  }, { destination: String(originInstanceId), actorId: String(user.id) });

  return {
    origin_instance_id: String(originInstanceId),
    origin_community_id: String(originCommunityId),
    state: 'left',
    relayed: !!(result && result.ok),
  };
}

// The communities a local account follows.
async function listForUser(userId) {
  const memberships = await store.listMemberships(userId);
  const out = [];
  for (const membership of memberships) {
    const community = await store.findCommunity(membership.origin_instance_id, membership.origin_community_id);
    out.push({
      ...membership,
      community: community
        ? { id: community.id, name: community.name, origin_community_id: community.origin_community_id }
        : null,
    });
  }
  return out;
}

module.exports = { join, leave, listForUser, trustedPeer };

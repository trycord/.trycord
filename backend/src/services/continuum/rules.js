// The relay rules.
//
// These decide what leaves this instance. They are the security boundary of
// the protocol, so they live in one file and every publication path asks
// them the same questions - a rule that is applied in one place and not in
// another is not a rule.
//
// The questions:
//
//   1. Is the community public? A private community produces no outbound
//      event at all, and is never listed in the discovery document.
//   2. May the members of that community post in this channel? A channel
//      whose permissions deny the community's members - a staff-only channel -
//      produces no outbound event, whatever the sender may do in it.
//   3. Could the sender post there? The sender's own permission is what
//      counts: the same check the send path makes.
//   4. Is the content end-to-end encrypted? Encrypted content is never
//      federated. See the note on encryptedContent() below.
//
// Every answer is { ok: true } or { ok: false, reason }, and the reason is
// what the operator is told when they ask why something was not relayed.
//
// The same questions are asked in the other direction - of a message a member
// of a federated community wrote here, arriving at the instance that owns the
// community - and they are asked here too. The origin is the authority over
// its community, so the origin's rules are the ones that decide; a rule that
// guarded only the outbound direction would not be a rule.

const db = require('../../db');
const permissions = require('../permissions');
const store = require('./store');

// The community's baseline role is what an ordinary member holds: every
// member is given it when they join, and it is the only role the system
// assigns on its own. Its permission set, after the category and channel
// overrides are applied, is therefore the answer to "may the members of this
// community post in this channel".
async function memberPermissions(serverId, channelId) {
  const baseline = await db.get(
    'SELECT permissions FROM roles WHERE server_id = ? AND is_default = 1 LIMIT 1',
    [serverId]
  );
  const granted = new Set();
  if (baseline && baseline.permissions) {
    let parsed = [];
    try { parsed = JSON.parse(baseline.permissions); } catch { parsed = []; }
    for (const permission of parsed) {
      if (permissions.isKnown(permission)) granted.add(permission);
    }
  }

  const channel = await db.get(
    'SELECT id, category_id FROM channels WHERE id = ? AND server_id = ?',
    [channelId, serverId]
  );
  if (!channel) return null;

  // The same precedence the permission service applies: the category first,
  // then the channel, and an explicit deny always beats an allow.
  const apply = (overrides) => {
    for (const [permission, effect] of Object.entries(overrides || {})) {
      if (!permissions.isKnown(permission)) continue;
      if (effect === 'deny') granted.delete(permission);
      else if (effect === 'allow') granted.add(permission);
    }
  };
  if (channel.category_id) {
    apply(await permissions.overridesFor('category_permission_overrides', channel.category_id));
  }
  apply(await permissions.overridesFor('channel_permission_overrides', channelId));
  return granted;
}

// Is the community one this instance federates?
//
// A private community is never federated. Not its messages, not its channel
// list, not its name: it produces no outbound event of any kind, and the
// discovery document does not mention it.
async function communityMayFederate(serverId) {
  if (!serverId) return { ok: false, reason: 'no community' };
  const community = await db.get(
    'SELECT id, is_public FROM servers WHERE id = ?',
    [serverId]
  );
  if (!community) return { ok: false, reason: 'the community does not exist' };
  if (!community.is_public) return { ok: false, reason: 'the community is private' };
  return { ok: true, community };
}

// May the members of this community post in this channel?
//
// The decision is per channel, not per community: a community may expose
// one channel and keep another to its staff.
async function channelMayFederate(serverId, channelId) {
  if (!channelId) return { ok: false, reason: 'no channel' };
  const community = await communityMayFederate(serverId);
  if (!community.ok) return community;
  const channel = await db.get(
    'SELECT id, name, type, topic FROM channels WHERE id = ? AND server_id = ?',
    [channelId, serverId]
  );
  if (!channel) return { ok: false, reason: 'the channel does not exist' };
  const granted = await memberPermissions(serverId, channelId);
  if (!granted) return { ok: false, reason: 'the channel does not exist' };
  if (!granted.has('SEND_MESSAGES')) {
    return { ok: false, reason: 'the members of the community cannot post in this channel' };
  }
  return { ok: true, community: community.community, channel, memberPermissions: granted };
}

// Could this author post in this channel right now?
//
// The same check the send path makes, so a relayed message is always one the
// author was allowed to write in the first place. The owner is not special
// here: ownership grants every permission inside the community, but it does
// not make a staff-only channel federable.
async function authorMayPost(userId, serverId, channelId) {
  if (!userId) return { ok: false, reason: 'no author' };
  const allowed = await permissions.hasChannelPermission(userId, serverId, channelId, 'SEND_MESSAGES');
  if (!allowed) return { ok: false, reason: 'the author cannot post in this channel' };
  return { ok: true };
}

// The whole gate for one message-shaped event.
async function mayFederateMessage({ serverId, channelId, authorId }) {
  const channel = await channelMayFederate(serverId, channelId);
  if (!channel.ok) return channel;
  const author = await authorMayPost(authorId, serverId, channelId);
  if (!author.ok) return author;
  return { ok: true, community: channel.community, channel: channel.channel };
}

// The whole gate for a reaction-shaped event. A reaction is a thing written
// in a channel, so it answers to the same channel rule, and to the same
// question of whether the person who wrote it could write there.
async function mayFederateReaction({ serverId, channelId, userId }) {
  const channel = await channelMayFederate(serverId, channelId);
  if (!channel.ok) return channel;
  const author = await authorMayPost(userId, serverId, channelId);
  if (!author.ok) return author;
  return { ok: true, community: channel.community, channel: channel.channel };
}

// End-to-end encrypted content is never federated.
//
// The rule is not "relay the ciphertext": a remote instance cannot read it,
// so relaying it would put a blob nobody can use into a conversation that
// looks readable. Nor is it "relay it and call it encrypted": the
// encryption belongs to the two endpoints of the original conversation and
// does not travel to a third party.
//
// So an encrypted conversation is not federated at all. In this build the
// encrypted conversations are the direct-message ones, which the relay never
// carries, and the rule below is the belt to that braces: anything that
// declares itself encrypted is refused, whatever it is.
function encryptedContent(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.encrypted === true) return true;
  if (payload.message && payload.message.encrypted === true) return true;
  // A direct conversation is end-to-end encrypted by construction here.
  if (payload.conversation_id) return true;
  return false;
}

// The channels this community exposes to the federation: the ones the
// members may post in. A restricted channel is not among them.
async function federableChannels(serverId) {
  const community = await communityMayFederate(serverId);
  if (!community.ok) return [];
  const channels = await db.all(
    'SELECT id, name, type, topic FROM channels WHERE server_id = ? ORDER BY position ASC, name ASC',
    [serverId]
  );
  const exposed = [];
  for (const channel of channels) {
    const granted = await memberPermissions(serverId, channel.id);
    if (granted && granted.has('SEND_MESSAGES')) exposed.push(channel);
  }
  return exposed;
}

// ---- the return direction ---------------------------------------------------

// The origin's answer to a message a member of its community wrote on
// another instance.
//
// The same questions as the outbound direction, asked about the receiver's
// own community:
//
//   1. Is the community still federated? A community that has been made
//      private takes no messages from anywhere, and certainly not from a
//      member writing on a mirror of it.
//   2. May the members of the community post in this channel? A restricted
//      channel takes no messages, and a member who may not post there does
//      not post there by writing to a federated copy of it.
//   3. Is the writer a member of this community here, and may they write?
//      A member of a federated community holds the community's baseline role
//      - joining grants nothing else - so the question is the one the
//      channel rule already asks, asked about the member rather than about
//      the sender of a local message.
//   4. Has the owner muted or removed them?
//
// A member who may not post in the origin's channel does not post there by
// writing on a federated mirror: the answer is the origin's, and the origin
// is the only one who may give it.
async function mayAcceptRemoteMessage({ serverId, channelId, originInstanceId, originUserId }) {
  const channel = await channelMayFederate(serverId, channelId);
  if (!channel.ok) return channel;
  if (!originInstanceId || !originUserId) {
    return { ok: false, reason: 'the event does not say who wrote it' };
  }
  const member = await store.findRelayMembership(originInstanceId, serverId, originUserId);
  if (!member) return { ok: false, reason: 'the writer is not a member of this community' };
  if (member.state === 'removed') {
    return { ok: false, reason: 'the member was removed from this community' };
  }
  if (member.state === 'muted') {
    return { ok: false, reason: 'the member is muted in this community' };
  }
  if (member.state !== 'joined') {
    return { ok: false, reason: 'the writer is not a member of this community' };
  }
  return { ok: true, community: channel.community, channel: channel.channel };
}

// The writer's side of the same question.
//
// What this instance knows: the peer is trusted, the community is one the
// peer federates and has not withdrawn, the channel is one the peer exposes,
// and the writer has joined the community here.
//
// What this instance cannot know is whether the member may post in that
// channel over there: the owner decides that, and its answer arrives later
// as an acceptance or a refusal. So the check here is about what may be
// *sent*, and the owner's rules are applied on arrival.
//
// A removal is a special case: a message the writer has taken back has to
// be able to leave whatever the writer's standing is by now, or a member
// who leaves the community could never take their words back.
async function mayPublishRemoteMessage({
  originInstanceId, originCommunityId, originChannelId, userId, removal,
}) {
  if (!originInstanceId) return { ok: false, reason: 'no instance to send it to' };
  const peer = await db.get('SELECT id, trust_status FROM continuum_instances WHERE id = ?', [String(originInstanceId)]);
  if (!peer) return { ok: false, reason: 'that instance is not known here' };
  if (peer.trust_status !== 'trusted') {
    return { ok: false, reason: 'that instance is not trusted' };
  }
  const community = await store.findCommunity(originInstanceId, originCommunityId);
  if (!community) return { ok: false, reason: 'that community is not known here' };
  if (community.state === 'revoked') {
    return { ok: false, reason: 'that community is no longer federated here' };
  }
  const exposed = store.channelsOf(community).some((channel) => String(channel.id) === String(originChannelId));
  if (!exposed) {
    return { ok: false, reason: 'that channel is not one the community exposes' };
  }
  if (!removal) {
    const membership = await store.findMembership(userId, originInstanceId, originCommunityId);
    if (!membership || membership.state !== 'joined') {
      return { ok: false, reason: 'you have not joined that community' };
    }
  }
  return { ok: true, community, channelId: String(originChannelId) };
}

// The owner's answer about a message travels even when the community has
// been closed.
//
// The decision carries no content of the community - not its name, not its
// channels - and the writer is entitled to know whether their message was
// taken. What it does need is a community that exists here (there is no
// decision to make about a community that is not) and a peer that is trusted
// (nothing is federated to a peer that is not).
async function mayPublishDecision({ serverId, destinationInstanceId }) {
  const community = await db.get('SELECT id FROM servers WHERE id = ?', [serverId]);
  if (!community) return { ok: false, reason: 'the community does not exist' };
  const peer = await db.get(
    'SELECT id, trust_status FROM continuum_instances WHERE id = ?',
    [String(destinationInstanceId)]
  );
  if (!peer) return { ok: false, reason: 'that instance is not known here' };
  if (peer.trust_status !== 'trusted') {
    return { ok: false, reason: 'that instance is not trusted' };
  }
  return { ok: true };
}

module.exports = {
  memberPermissions,
  communityMayFederate,
  channelMayFederate,
  authorMayPost,
  mayFederateMessage,
  mayFederateReaction,
  encryptedContent,
  federableChannels,
  mayAcceptRemoteMessage,
  mayPublishRemoteMessage,
  mayPublishDecision,
};

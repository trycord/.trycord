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

const db = require('../../db');
const permissions = require('../permissions');

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

module.exports = {
  memberPermissions,
  communityMayFederate,
  channelMayFederate,
  authorMayPost,
  mayFederateMessage,
  mayFederateReaction,
  encryptedContent,
  federableChannels,
};

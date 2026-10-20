// Writing in a community that lives on another instance.
//
// A member of a federated community reads it here. This module is the other
// half: writing in it from here.
//
// The message is kept here until the owner answers, and the answer is the
// owner's - this instance does not decide whether a member of somebody
// else's community may write in it. It applies the rules it can see (the
// peer is trusted, the community is one the peer federates, the channel is
// one the peer exposes, the writer has joined) and publishes the message to
// the owner. The owner applies its own rules to it, and its answer arrives
// here as an acceptance or a refusal - and a refusal is told to the writer,
// because a message that vanishes without a word is worse than one that is
// refused.

const { now } = require('../../util');
const identity = require('./identity');
const store = require('./store');
const rules = require('./rules');
const relay = require('./relay');

// A message body is capped rather than truncated: slicing to the limit loses
// whatever the writer typed past it with no indication at all. The same cap
// the local send path uses.
const MAX_CONTENT = 2000;

function readContent(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) {
    throw { code: 'VALIDATION_ERROR', message: 'content required' };
  }
  if (text.length > MAX_CONTENT) {
    throw { code: 'VALIDATION_ERROR', message: 'message must be ' + MAX_CONTENT + ' characters or fewer' };
  }
  return text;
}

// The thread a reply hangs from.
//
// The root is named by the id it has on the instance that holds it: a reply
// to a message the owner published hangs from that message's id there, and a
// reply to a message another member wrote here hangs from that message's id
// here. The two are not the same id, and the owner has to be able to tell
// them apart.
async function resolveThread(originInstanceId, originCommunityId, replyToId) {
  if (!replyToId) return { rootId: null, rootInstanceId: null };

  const outgoing = await store.findOutgoing(replyToId);
  if (outgoing
    && String(outgoing.origin_instance_id) === String(originInstanceId)
    && String(outgoing.origin_community_id) === String(originCommunityId)) {
    return { rootId: outgoing.id, rootInstanceId: identity.getInstanceId() };
  }

  const relayed = await store.findRelayMessage(originInstanceId, replyToId);
  if (relayed) return { rootId: relayed.origin_message_id, rootInstanceId: originInstanceId };

  return { rootId: null, rootInstanceId: null };
}

// Write a message in a community that lives on another instance.
//
// It is published as soon as it is written: the writer is waiting for it,
// and the ledger keeps the record of what was published, so a second
// publication of the same message is not a second message.
async function write({
  user, originInstanceId, originCommunityId, originChannelId, content, replyToId, publish,
}) {
  const text = readContent(content);

  // The rules of this side. The owner's rules are applied when it receives
  // the message.
  const gate = await rules.mayPublishRemoteMessage({
    originInstanceId,
    originCommunityId,
    originChannelId,
    userId: user.id,
  });
  if (!gate.ok) throw { code: 'PERMISSION_DENIED', message: gate.reason };

  const thread = await resolveThread(originInstanceId, originCommunityId, replyToId);

  const id = await store.createOutgoing({
    originInstanceId,
    originCommunityId,
    originChannelId,
    authorId: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    content: text,
    createdAt: now(),
    threadRootId: thread.rootId,
    threadRootInstanceId: thread.rootInstanceId,
  });

  const outgoing = await store.findOutgoing(id);
  const result = await publish('message.posted', relay.outgoingInput(outgoing), {
    destination: originInstanceId,
    actorId: String(user.id),
  });

  // A publication that was refused leaves the message pending: the feed's
  // scan is the safety net, and it will try again and record the refusal if
  // the rules still say no.
  if (result && result.ok) {
    await store.updateOutgoing(id, { eventId: result.eventId });
  }
  const current = await store.findOutgoing(id);
  return {
    ...store.shapeOutgoing(current),
    published: !!(result && result.ok),
    reason: result && result.ok ? null : (result && result.reason) || null,
  };
}

// Edit a message written here for a community that lives elsewhere.
//
// Only the author may edit it, and only while it is there: an edit is a
// write, so it is subject to the same rules a new message is. The change
// itself is published by the feed, like every other change.
async function edit({ user, outgoingId, content }) {
  const outgoing = await store.findOutgoing(outgoingId);
  if (!outgoing) throw { code: 'NOT_FOUND', message: 'no such message' };
  if (String(outgoing.author_id) !== String(user.id)) {
    throw { code: 'PERMISSION_DENIED', message: 'only the author can edit it' };
  }
  if (outgoing.deleted_at) throw { code: 'NOT_FOUND', message: 'the message is gone' };
  const text = readContent(content);
  await store.updateOutgoing(outgoing.id, { content: text, editedAt: now() });
  return store.shapeOutgoing(await store.findOutgoing(outgoing.id));
}

// Take back a message written here for a community that lives elsewhere.
//
// The row goes, and the feed publishes the deletion - so the owner's copy
// does not outlive the writer's.
async function remove({ user, outgoingId }) {
  const outgoing = await store.findOutgoing(outgoingId);
  if (!outgoing) throw { code: 'NOT_FOUND', message: 'no such message' };
  if (String(outgoing.author_id) !== String(user.id)) {
    throw { code: 'PERMISSION_DENIED', message: 'only the author can delete it' };
  }
  await store.deleteOutgoing(outgoing.id);
  return { ok: true, id: outgoing.id };
}

// The messages this account has written into communities that live
// elsewhere, with what the owner said about them.
async function listForUser(userId, filter) {
  const rows = await store.listOutgoing(Object.assign({ userId }, filter || {}));
  return rows.map(store.shapeOutgoing);
}

module.exports = {
  write,
  edit,
  remove,
  listForUser,
  readContent,
  MAX_CONTENT,
};

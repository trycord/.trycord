// The publisher.
//
// Everything that leaves this instance goes through here: the rules decide
// whether it may leave at all, the ledger says whether it has left before,
// and the payload is built so that the receiver can tell what happened
// without having to know anything about this instance's tables.
//
// The shape of an event is described in ./events.js. This module is the
// policy behind it.

const crypto = require('crypto');
const db = require('../../db');
const { now } = require('../../util');
const events = require('./events');
const rules = require('./rules');
const ledger = require('./ledger');
const sequences = require('./sequences');
const identity = require('./identity');

// A hash of the state that was published. Two states with the same hash are
// the same state, so a changed hash is a change worth relaying.
function fingerprint(parts) {
  return crypto.createHash('sha256')
    .update(parts.map((p) => (p === null || p === undefined ? '' : String(p))).join(' '))
    .digest('hex')
    .slice(0, 40);
}

// The author's name as it was when the event was published. A rename on this
// instance must not rewrite what a remote instance already knows about who
// wrote a message.
async function authorSnapshot(userId) {
  if (!userId) return { username: null, display_name: null };
  const row = await db.get('SELECT username, display_name FROM users WHERE id = ?', [userId]);
  if (!row) return { username: null, display_name: null };
  return { username: row.username, display_name: row.display_name || row.username };
}

// ---- local rows ------------------------------------------------------------

// Read the local row a publication is about.
async function readSource(sourceKind, sourceId) {
  if (sourceKind === 'message') {
    return db.get(
      'SELECT id, channel_id, author_id, content, created_at, edited_at, thread_root_id '
      + 'FROM messages WHERE id = ?',
      [String(sourceId)]
    );
  }
  if (sourceKind === 'reaction') {
    const parts = String(sourceId).split('|');
    if (parts.length !== 3) return null;
    return db.get(
      'SELECT message_id, user_id, emoji, created_at FROM reactions '
      + 'WHERE message_id = ? AND user_id = ? AND emoji = ?',
      [parts[0], parts[1], parts[2]]
    );
  }
  if (sourceKind === 'channel') {
    return db.get(
      'SELECT id, server_id, name, topic, type, position, category_id FROM channels WHERE id = ?',
      [String(sourceId)]
    );
  }
  if (sourceKind === 'community') {
    return db.get(
      'SELECT id, name, description, icon_url, banner_url, is_public, owner_id, created_at FROM servers WHERE id = ?',
      [String(sourceId)]
    );
  }
  return null;
}

// The fingerprint of a local row's state.
function sourceFingerprint(sourceKind, row) {
  if (!row) return null;
  if (sourceKind === 'message') return fingerprint([row.content, row.edited_at]);
  if (sourceKind === 'reaction') return fingerprint([row.emoji]);
  if (sourceKind === 'channel') {
    return fingerprint([row.name, row.topic, row.type, row.position, row.category_id]);
  }
  if (sourceKind === 'community') {
    return fingerprint([row.name, row.description, row.icon_url, row.banner_url, row.is_public]);
  }
  return null;
}

// The context a publication needs later: where the thing was, who wrote it,
// and - for a message - the ids and the author snapshot the deletion event
// has to carry once the row itself is gone.
async function contextFor(sourceKind, row) {
  if (sourceKind === 'message') {
    const channel = await db.get('SELECT id, server_id FROM channels WHERE id = ?', [row.channel_id]);
    const author = await authorSnapshot(row.author_id);
    return {
      serverId: channel ? channel.server_id : null,
      channelId: row.channel_id,
      authorId: row.author_id,
      username: author.username,
      displayName: author.display_name,
      createdAt: row.created_at,
      threadRootId: row.thread_root_id || null,
    };
  }
  if (sourceKind === 'reaction') {
    const message = await db.get('SELECT channel_id, server_id FROM messages WHERE id = ?', [row.message_id]);
    const author = await authorSnapshot(row.user_id);
    return {
      serverId: message ? message.server_id : null,
      channelId: message ? message.channel_id : null,
      messageId: row.message_id,
      userId: row.user_id,
      emoji: row.emoji,
      username: author.username,
      displayName: author.display_name,
      createdAt: row.created_at,
    };
  }
  if (sourceKind === 'channel') {
    return { serverId: row.server_id, channelId: row.id };
  }
  if (sourceKind === 'community') {
    return { serverId: row.id };
  }
  return null;
}

// The local row an event is about, and the fingerprint of its state.
//
// The source is what the ledger is keyed by, so it is also what makes a
// second publication of the same thing a no-op.
async function resolveSource(kind, input) {
  let sourceKind = null;
  let sourceId = null;
  if (events.isSubjectKind(kind, 'message')) {
    sourceKind = 'message';
    sourceId = input.messageId;
  } else if (events.isSubjectKind(kind, 'reaction')) {
    sourceKind = 'reaction';
    sourceId = reactionKey(input.messageId, input.userId, input.emoji);
  } else if (events.isSubjectKind(kind, 'channel')) {
    sourceKind = 'channel';
    sourceId = input.channelId;
  } else if (events.isSubjectKind(kind, 'community')) {
    sourceKind = 'community';
    sourceId = input.serverId;
  }
  if (!sourceKind || !sourceId) return null;

  const row = await readSource(sourceKind, sourceId);
  if (!row) return null;
  return {
    kind: sourceKind,
    id: String(sourceId),
    row,
    fingerprint: sourceFingerprint(sourceKind, row),
    context: await contextFor(sourceKind, row),
  };
}

// A reaction has no id of its own: it is the triple (message, user, emoji),
// and that triple is what the ledger keys it by.
function reactionKey(messageId, userId, emoji) {
  return [messageId, userId, emoji].join('|');
}

// ---- rules ----------------------------------------------------------------

// The rules that apply to a kind.
async function gateFor(kind, input) {
  if (kind === 'message.deleted' || kind === 'reaction.removed') {
    // The row is gone - that is what a deletion means - so the author's
    // permission cannot be asked about. The question that can still be
    // answered is whether the channel may be federated at all, and that is
    // the one that matters: a community that has been made private relays
    // nothing more, not even the removals.
    return rules.channelMayFederate(input.serverId, input.channelId);
  }
  if (events.isSubjectKind(kind, 'message')) {
    const message = await db.get('SELECT author_id FROM messages WHERE id = ?', [input.messageId]);
    if (!message) return { ok: false, reason: 'the message does not exist' };
    return rules.mayFederateMessage({
      serverId: input.serverId,
      channelId: input.channelId,
      authorId: message.author_id,
    });
  }
  if (events.isSubjectKind(kind, 'reaction')) {
    return rules.mayFederateReaction({
      serverId: input.serverId,
      channelId: input.channelId,
      userId: input.userId,
    });
  }
  if (events.isSubjectKind(kind, 'channel')) {
    return rules.channelMayFederate(input.serverId, input.channelId);
  }
  if (events.isSubjectKind(kind, 'community')) {
    return rules.communityMayFederate(input.serverId);
  }
  // A membership event is about a community that lives on another instance.
  // The rules that apply to it are the trust rules, and those are applied
  // when the event is delivered.
  return { ok: true };
}

// The kind an event is actually published under. A message that is a reply is
// published as a reply, whichever way the caller asked for it: the reply is
// what happened, and the receiver needs the thread it belongs to.
function effectiveKind(kind, source) {
  if (kind !== 'message.posted') return kind;
  if (source && source.row && source.row.thread_root_id) return 'thread.reply';
  return kind;
}

// ---- payload --------------------------------------------------------------

// When the thing the event is about happened, on this instance.
function occurredAt(kind, source, input) {
  if (source && source.row) {
    if (source.kind === 'message' || source.kind === 'reaction') return source.row.created_at;
    if (source.kind === 'community') return source.row.created_at;
  }
  if (input.occurredAt) return String(input.occurredAt);
  return now();
}

// Who caused the event.
//
// A community answers for itself and its channels, so both are spoken for by
// the community's owner. A message is spoken for by its author, a reaction by
// the person who reacted.
async function actorFor(kind, source, input) {
  if (input.actorId) return String(input.actorId);
  if (source && source.row) {
    if (source.kind === 'message') return source.row.author_id;
    if (source.kind === 'reaction') return source.row.user_id;
    if (source.kind === 'community') return source.row.owner_id;
    if (source.kind === 'channel') {
      const community = await db.get('SELECT owner_id FROM servers WHERE id = ?', [source.row.server_id]);
      return community ? community.owner_id : null;
    }
  }
  if (input.authorId) return String(input.authorId);
  if (input.userId) return String(input.userId);
  return null;
}

// The community as the origin describes it.
async function communitySection(serverId, full) {
  const row = await db.get('SELECT id, name, description, icon_url FROM servers WHERE id = ?', [serverId]);
  if (!row) return null;
  if (!full) return { id: row.id, name: row.name };
  const channels = await rules.federableChannels(serverId);
  return {
    id: row.id,
    name: row.name,
    description: row.description == null ? null : String(row.description),
    icon_url: row.icon_url == null ? null : String(row.icon_url),
    channels: channels.map((channel) => events.channelDescriptor(channel, true)),
  };
}

// The channel as the origin describes it.
async function channelSection(serverId, channelId, full) {
  const row = await db.get(
    'SELECT id, name, type, topic FROM channels WHERE id = ? AND server_id = ?',
    [channelId, serverId]
  );
  if (!row) return null;
  if (!full) return { id: row.id, name: row.name, type: row.type };
  const granted = await rules.memberPermissions(serverId, channelId);
  return events.channelDescriptor(row, !!(granted && granted.has('SEND_MESSAGES')));
}

// Build the payload for one event.
async function buildPayload(kind, input, source, opts) {
  const actorId = await actorFor(kind, source, input);
  if (!actorId) return { ok: false, reason: 'the event has no actor' };
  const snapshot = input.username
    ? { username: input.username, display_name: input.displayName || input.username }
    : await authorSnapshot(actorId);

  const origin = events.originBlock({
    instance_id: identity.getInstanceId(),
    actor_id: actorId,
    author_username: snapshot.username,
    author_display_name: snapshot.display_name,
    community_origin_id: input.serverId || null,
    channel_origin_id: input.channelId || null,
    message_origin_id: input.messageId || null,
    thread_root_origin_id: (source && source.row && source.row.thread_root_id)
      || input.threadRootId
      || null,
    occurred_at: occurredAt(kind, source, input),
    seq: await sequences.nextOutbound(actorId),
  });

  const payload = { origin };
  // An event addressed to one instance says so. The receiver ignores it - it
  // is the sender's business - but the delivery path needs it.
  if (opts.destination) payload.destination_instance_id = String(opts.destination);

  if (events.isSubjectKind(kind, 'membership')) {
    // The community of a membership event lives on the instance the event is
    // addressed to, not here, so it is described rather than looked up.
    payload.community = {
      id: String(input.serverId),
      name: input.communityName ? String(input.communityName) : 'Unknown community',
    };
  } else if (events.isSubjectKind(kind, 'community')) {
    const community = await communitySection(input.serverId, true);
    if (!community) return { ok: false, reason: 'the community does not exist' };
    payload.community = community;
  } else if (input.serverId) {
    const community = await communitySection(input.serverId, false);
    if (!community) return { ok: false, reason: 'the community does not exist' };
    payload.community = community;
  }

  if (events.isSubjectKind(kind, 'channel')) {
    const channel = await channelSection(input.serverId, input.channelId, true);
    if (!channel) return { ok: false, reason: 'the channel does not exist' };
    payload.channel = channel;
  } else if (input.channelId) {
    const channel = await channelSection(input.serverId, input.channelId, false);
    if (!channel) return { ok: false, reason: 'the channel does not exist' };
    payload.channel = channel;
  }

  if (events.isSubjectKind(kind, 'message')) {
    const message = source && source.row;
    if (message) {
      payload.message = {
        id: message.id,
        content: kind === 'message.deleted' ? null : message.content,
        created_at: message.created_at,
        edited_at: message.edited_at || null,
        deleted_at: kind === 'message.deleted' ? now() : null,
      };
    } else {
      // A deletion: the row is gone, so what the event carries is what the
      // ledger kept about it.
      payload.message = {
        id: String(input.messageId),
        content: null,
        created_at: String(input.createdAt || origin.occurred_at),
        edited_at: null,
        deleted_at: now(),
      };
    }
  }

  if (events.isSubjectKind(kind, 'reaction')) {
    const reaction = source && source.row;
    const snapshot2 = reaction
      ? await authorSnapshot(reaction.user_id)
      : { username: input.username || null, display_name: input.displayName || null };
    payload.reaction = {
      message_id: String((reaction && reaction.message_id) || input.messageId),
      emoji: String((reaction && reaction.emoji) || input.emoji),
      user_id: String((reaction && reaction.user_id) || input.userId),
      username: snapshot2.username,
      display_name: snapshot2.display_name,
      created_at: String((reaction && reaction.created_at) || input.createdAt || origin.occurred_at),
    };
  }

  if (events.isSubjectKind(kind, 'membership')) {
    payload.membership = {
      user_id: String(input.userId),
      username: input.username == null ? null : String(input.username),
      display_name: input.displayName == null ? null : String(input.displayName),
      state: String(input.state || 'joined'),
    };
  }

  return { ok: true, payload };
}

// ---- preparing a publication ----------------------------------------------

// Prepare one publication.
//
// Returns { ok: true, kind, payload, source, fingerprint } when the event may
// be published, and { ok: false, reason, withhold } when it may not. The
// reason is what the operator is told; withhold says the refusal was a rule
// rather than a fault, so the caller can record it and stop asking.
async function prepare(kind, payload, opts = {}) {
  const input = payload || {};
  if (!events.isKnownKind(kind)) return { ok: false, reason: 'unknown event kind' };

  const source = await resolveSource(kind, input);

  // What the ledger already says comes first: a row that was withheld stays
  // withheld, and a row that was published in exactly this state has nothing
  // left to say.
  if (source) {
    const existing = await ledger.find(source.kind, source.id);
    if (existing && existing.state === 'live' && existing.fingerprint === source.fingerprint) {
      return { ok: false, reason: 'already published', duplicate: true, eventId: existing.last_event_id, source };
    }
    if (existing && existing.state === 'withheld') {
      return {
        ok: false,
        reason: 'this content was not federable when it was written',
        withhold: true,
        source,
      };
    }
  }

  const gate = await gateFor(kind, input);
  if (!gate.ok) return { ok: false, reason: gate.reason, withhold: true, source };

  // Encrypted content is never relayed, not even as a ciphertext nobody can
  // read. See rules.encryptedContent().
  if (rules.encryptedContent(input)) {
    return { ok: false, reason: 'encrypted content is never federated', withhold: true, source };
  }

  if (source) {
    const existing = await ledger.find(source.kind, source.id);
    if (!existing) {
      const claimed = await ledger.claim(source.kind, source.id, source.fingerprint, source.context);
      if (!claimed) {
        const row = await ledger.find(source.kind, source.id);
        if (row && row.state === 'live' && row.fingerprint === source.fingerprint) {
          return { ok: false, reason: 'already published', duplicate: true, eventId: row.last_event_id, source };
        }
      }
    }
  }

  const effective = effectiveKind(kind, source);
  const built = await buildPayload(effective, input, source, opts);
  if (!built.ok) return { ok: false, reason: built.reason, source };

  return {
    ok: true,
    kind: effective,
    payload: built.payload,
    source,
    fingerprint: source ? source.fingerprint : null,
  };
}

// The input a change event carries, for a row that still exists.
async function updateInput(sourceKind, row) {
  if (sourceKind === 'message') {
    const channel = await db.get('SELECT server_id FROM channels WHERE id = ?', [row.channel_id]);
    return { serverId: channel ? channel.server_id : null, channelId: row.channel_id, messageId: row.id };
  }
  if (sourceKind === 'channel') {
    return { serverId: row.server_id, channelId: row.id };
  }
  if (sourceKind === 'community') {
    return { serverId: row.id };
  }
  return null;
}

// The input a deletion event carries, for a row that is gone. Everything it
// needs was kept in the ledger when the row was published.
function deletionInput(sourceKind, sourceId, context) {
  const ctx = context || {};
  if (sourceKind === 'message') {
    return {
      serverId: ctx.serverId,
      channelId: ctx.channelId,
      messageId: String(sourceId),
      authorId: ctx.authorId,
      username: ctx.username,
      displayName: ctx.displayName,
      createdAt: ctx.createdAt,
      occurredAt: ctx.createdAt,
    };
  }
  if (sourceKind === 'reaction') {
    return {
      serverId: ctx.serverId,
      channelId: ctx.channelId,
      messageId: ctx.messageId,
      userId: ctx.userId,
      emoji: ctx.emoji,
      username: ctx.username,
      displayName: ctx.displayName,
      createdAt: ctx.createdAt,
      occurredAt: ctx.createdAt,
    };
  }
  return null;
}

module.exports = {
  fingerprint,
  reactionKey,
  authorSnapshot,
  readSource,
  sourceFingerprint,
  contextFor,
  resolveSource,
  prepare,
  updateInput,
  deletionInput,
  effectiveKind,
};

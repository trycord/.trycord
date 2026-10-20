// The event vocabulary.
//
// One table, one place. A kind that is not listed here is not part of the
// protocol: the publisher cannot produce it and the receiver refuses it. That
// is deliberate - an unknown kind is either a mistake or an attempt to make
// the receiver run something it was never asked to understand.
//
// Every event carries the same four payload sections plus the section its
// kind is about:
//
//   origin      - who and where the event came from. The instance id, the
//                 author id on that instance, the author's name as it was at
//                 the time (so a later rename does not rewrite history), the
//                 ids of the community, channel and message on the instance
//                 that owns them, the time the thing happened, and the
//                 per-actor sequence number.
//
//                 Every id in this section is the id the thing has on the
//                 instance that owns it. For a message written here, that is
//                 this instance. For a membership event about a community
//                 that lives somewhere else, it is the instance that owns
//                 that community - which is why the fields say "origin id"
//                 rather than just "id".
//   community   - the community the event is about, as the origin describes
//                 it. Only on community and channel events.
//   channel     - the channel the event is about. Only on channel, message,
//                 reaction and membership events.
//   message     - the message the event is about. Only on message and thread
//                 events.
//   reaction    - the reaction the event is about. Only on reaction events.
//   membership  - the member the event is about. Only on membership events.
//   decision    - the owner's answer about a message a member wrote on
//                 another instance: taken, or refused, and why.
//
// The `origin` section is the part that matters for authority: it says which
// instance speaks, and the receiving instance checks the signature against
// the key it recorded for exactly that instance before it reads any of it.
//
// The origin section also says which instance *owns* each of the ids it
// carries. The community is owned by the instance that hosts it, the message
// by the instance it was written on, and the thread root by the instance that
// holds it - and those are not always the same instance. Without that, a
// receiver cannot tell a message the owner wrote from one a member wrote on
// another instance, and the two are governed by different rules.

const KINDS = {
  'community.published': { sections: ['origin', 'community'], subject: 'community' },
  'community.updated': { sections: ['origin', 'community'], subject: 'community' },
  'channel.published': { sections: ['origin', 'community', 'channel'], subject: 'channel' },
  'channel.updated': { sections: ['origin', 'community', 'channel'], subject: 'channel' },
  'message.posted': { sections: ['origin', 'community', 'channel', 'message'], subject: 'message' },
  'message.edited': { sections: ['origin', 'community', 'channel', 'message'], subject: 'message' },
  'message.deleted': { sections: ['origin', 'community', 'channel', 'message'], subject: 'message' },
  'thread.reply': { sections: ['origin', 'community', 'channel', 'message'], subject: 'message' },
  'reaction.added': { sections: ['origin', 'community', 'channel', 'reaction'], subject: 'reaction' },
  'reaction.removed': { sections: ['origin', 'community', 'channel', 'reaction'], subject: 'reaction' },
  'membership.joined': { sections: ['origin', 'community', 'membership'], subject: 'membership' },
  'membership.left': { sections: ['origin', 'community', 'membership'], subject: 'membership' },
  // The owner's answer about a message a member wrote on another instance.
  // The decision travels even when the community has been closed: it carries
  // no content of the community, and a writer left without an answer would
  // have no way of knowing that their message was refused.
  'message.accepted': { sections: ['origin', 'decision'], subject: 'decision' },
  'message.refused': { sections: ['origin', 'decision'], subject: 'decision' },
  // The owner changed a member's standing: muted, removed, or restored.
  'membership.updated': { sections: ['origin', 'community', 'membership'], subject: 'membership' },
};

// The actor of an event that the instance itself causes rather than a person:
// the owner accepting or refusing a message, for instance. It has its own
// sequence counter, so the protocol's own events never overtake a member's.
const PROTOCOL_ACTOR = 'continuum';

// How far an event's timestamp may be from the receiver's clock. An event
// that claims to have happened more than an hour ago, or to happen in the
// future, is refused: the sequence numbers and the event ids already refuse
// replays, and this refuses the ones that were never real.
const CLOCK_SKEW_MS = 60 * 60 * 1000;

function isKnownKind(kind) {
  return Object.prototype.hasOwnProperty.call(KINDS, String(kind || ''));
}

function sectionsFor(kind) {
  return KINDS[String(kind || '')] ? KINDS[String(kind || '')].sections : [];
}

function isSubjectKind(kind, subject) {
  const spec = KINDS[String(kind || '')];
  return !!spec && spec.subject === subject;
}

// A timestamp is accepted when it is a real time and it is near enough to
// now. Returns the parsed time, or null.
function acceptableTimestamp(timestamp, nowMs) {
  const parsed = Date.parse(String(timestamp || ''));
  if (!Number.isFinite(parsed)) return null;
  const reference = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (Math.abs(parsed - reference) > CLOCK_SKEW_MS) return null;
  return parsed;
}

// Check a payload against its kind. Returns { ok: true } or { ok: false,
// reason } - the reason is what the operator is told, so it says which field
// was wrong rather than that something was.
function validatePayload(kind, payload) {
  if (!isKnownKind(kind)) return { ok: false, reason: 'unknown event kind' };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'payload must be an object' };
  }
  for (const section of sectionsFor(kind)) {
    const value = payload[section];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: 'payload.' + section + ' is missing' };
    }
  }
  const origin = payload.origin;
  if (!origin.instance_id) return { ok: false, reason: 'payload.origin.instance_id is missing' };
  if (!origin.actor_id) return { ok: false, reason: 'payload.origin.actor_id is missing' };
  if (!origin.community_origin_id) return { ok: false, reason: 'payload.origin.community_origin_id is missing' };
  if (!origin.occurred_at) return { ok: false, reason: 'payload.origin.occurred_at is missing' };

  if (isSubjectKind(kind, 'community')) {
    if (!payload.community.id) return { ok: false, reason: 'payload.community.id is missing' };
    if (!payload.community.name) return { ok: false, reason: 'payload.community.name is missing' };
  }
  if (isSubjectKind(kind, 'channel')) {
    if (!payload.channel.id) return { ok: false, reason: 'payload.channel.id is missing' };
    if (!payload.channel.name) return { ok: false, reason: 'payload.channel.name is missing' };
  }
  if (isSubjectKind(kind, 'message')) {
    if (!payload.message.id) return { ok: false, reason: 'payload.message.id is missing' };
    // A deletion carries no content: the content is what is being removed.
    if (kind !== 'message.deleted' && typeof payload.message.content !== 'string') {
      return { ok: false, reason: 'payload.message.content is missing' };
    }
  }
  if (isSubjectKind(kind, 'reaction')) {
    if (!payload.reaction.message_id) return { ok: false, reason: 'payload.reaction.message_id is missing' };
    if (!payload.reaction.emoji) return { ok: false, reason: 'payload.reaction.emoji is missing' };
    if (!payload.reaction.user_id) return { ok: false, reason: 'payload.reaction.user_id is missing' };
  }
  if (isSubjectKind(kind, 'membership')) {
    if (!payload.membership.user_id) return { ok: false, reason: 'payload.membership.user_id is missing' };
  }
  if (isSubjectKind(kind, 'decision')) {
    const decision = payload.decision.decision;
    if (decision !== 'accepted' && decision !== 'refused') {
      return { ok: false, reason: 'payload.decision.decision is not a known decision' };
    }
    // A refusal has to say why: the writer is told, and "no" without a
    // reason is not an answer they can act on.
    if (decision === 'refused' && !payload.decision.reason) {
      return { ok: false, reason: 'payload.decision.reason is missing' };
    }
  }
  return { ok: true };
}

// Which way does an event travel?
//
// 'forward' - the speaker owns the community, and the message is one of its
//             own, published to the peers that read it.
// 'return'  - the speaker is a member elsewhere, and the message is one it
//             wrote in a community the receiver owns. The receiver is the
//             authority here and applies its own rules.
// 'foreign' - the event claims a community that neither the speaker nor the
//             receiver owns. The protocol does not carry that: an event
//             received from a peer is not relayed onwards, so a community
//             owned by a third instance has no business here.
//
// The claim is a field rather than an inference, but a receiver that meets an
// event without one falls back to what it can check for itself: a message
// about a community it owns is a return-direction message whatever the sender
// says, and a message about a community it does not own is a forward one.
function directionOf(origin, receiverInstanceId, ownsCommunity) {
  const owner = origin.community_owner_id;
  if (!owner) {
    return ownsCommunity ? 'return' : 'forward';
  }
  if (owner === origin.instance_id) return 'forward';
  if (owner === receiverInstanceId) return 'return';
  return 'foreign';
}

// The origin block every event carries.
//
// The author snapshot is taken when the event is published, not when it is
// read: a rename on the origin must not rewrite what a remote instance
// already knows about who wrote a message.
function originBlock(fields) {
  return {
    instance_id: String(fields.instance_id || ''),
    actor_id: String(fields.actor_id || ''),
    author_username: fields.author_username == null ? null : String(fields.author_username),
    author_display_name: fields.author_display_name == null ? null : String(fields.author_display_name),
    community_origin_id: fields.community_origin_id == null ? null : String(fields.community_origin_id),
    channel_origin_id: fields.channel_origin_id == null ? null : String(fields.channel_origin_id),
    message_origin_id: fields.message_origin_id == null ? null : String(fields.message_origin_id),
    thread_root_origin_id: fields.thread_root_origin_id == null ? null : String(fields.thread_root_origin_id),
    // Which instance each of those ids belongs to. The owner of the
    // community is the instance that hosts it; the owner of the message is
    // the instance the message was written on; the owner of the thread root
    // is the instance that holds it. A receiver needs these to know whose
    // message it is holding and whose rules apply to it.
    community_owner_id: fields.community_owner_id == null ? null : String(fields.community_owner_id),
    message_owner_id: fields.message_owner_id == null ? null : String(fields.message_owner_id),
    thread_root_owner_id: fields.thread_root_owner_id == null ? null : String(fields.thread_root_owner_id),
    occurred_at: String(fields.occurred_at || ''),
    seq: Number.isFinite(fields.seq) ? fields.seq : null,
  };
}

// The channel descriptor a community publishes: what the channel is on the
// origin, and whether the members of that community may post in it.
function channelDescriptor(channel, isPublic) {
  return {
    id: String(channel.id),
    name: String(channel.name),
    type: String(channel.type || 'text'),
    topic: channel.topic == null ? null : String(channel.topic),
    is_public: !!isPublic,
  };
}

module.exports = {
  KINDS,
  PROTOCOL_ACTOR,
  isKnownKind,
  sectionsFor,
  isSubjectKind,
  acceptableTimestamp,
  validatePayload,
  originBlock,
  channelDescriptor,
  directionOf,
};

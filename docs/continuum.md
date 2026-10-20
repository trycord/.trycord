# Community Continuum

Federation between compatible Trycord instances. **Opt-in and opt-out at
will**: while `continuum.enabled` is off (default), this instance is
local-only - nothing is sent, nothing is accepted, and the discovery document
answers 404.

Continuum federates *communities*, not accounts. A community that lives on
another instance stays there: it is described here, it is read here, and it is
never copied into this instance's own tables. The instance that owns a
community remains the only authority over it.

The relay runs both ways. A community this instance owns is published to the
instances that read it, and a member of such a community may write in it from
here: the message travels to the instance that owns it, is kept there as
something the owner can see and act on, and the owner answers - taken, or
refused, with the reason.

## The event

Every event is a JSON envelope signed with Ed25519 (`node:crypto` - no custom
cryptography). The signature covers every field except the signature itself
and the key id, so a receiver can verify the sender without trusting the
transport:

```json
{
  "id": "b3a1...",
  "kind": "message.posted",
  "actor": "0f2c...",
  "target": "9d41...",
  "timestamp": "2026-10-19T21:14:02.418Z",
  "payload": { "origin": { ... }, "community": { ... }, "channel": { ... }, "message": { ... } },
  "signature": "c2Fs...",
  "key_id": "instance-a"
}
```

The payload carries the sections its kind is about:

| Section | What it says |
| --- | --- |
| `origin` | the instance that speaks (`instance_id`), the author on that instance (`actor_id`), the author's name as it was at the time (`author_username`, `author_display_name`), the ids the community, channel and message have **on the instance that owns them** (`community_origin_id`, `channel_origin_id`, `message_origin_id`, `thread_root_origin_id`), **which instance owns each of those ids** (`community_owner_id`, `message_owner_id`, `thread_root_owner_id`), when it happened (`occurred_at`) and the per-actor sequence number (`seq`) |
| `community` | the community as the origin describes it: its id, name, description, icon and the channels it exposes |
| `channel` | the channel: its id, name, type, topic and whether the members may post in it |
| `message` | the message: its id, content, the origin's timestamps |
| `reaction` | the reaction: the message it is on, the emoji, who reacted and their name at the time |
| `membership` | the member: their id on the origin, the instance that id belongs to (`member_instance_id`), their name, and whether they joined, left, were muted or were removed |
| `decision` | the owner's answer about a message a member wrote elsewhere: `accepted` or `refused`, the reason, and who wrote it |

The author snapshot is taken when the event is published, not when it is
read. A rename on the origin does not rewrite what a remote instance already
knows about who wrote a message.

**Why the owner fields are in the origin block.** A message about a community
this instance owns may have been written here or on another instance, and the
two are governed by different rules. The community is owned by the instance
that hosts it; the message is owned by the instance it was written on; the
thread root is owned by the instance that holds it - and those are not always
the same instance. Without those fields a receiver cannot tell a message the
owner wrote from one a member wrote elsewhere, and cannot tell whose rules
apply to it. A receiver that meets an event without them falls back to what
it can check for itself: a message about a community it owns is treated as a
member's message whatever the sender says.

## The vocabulary

| Kind | What it carries |
| --- | --- |
| `community.published` | a community this instance federates, and the channels it exposes |
| `community.updated` | the same, after the community's own details changed |
| `channel.published` | a channel the community exposes |
| `channel.updated` | the same, after the channel changed |
| `message.posted` | a message written in a federated channel |
| `message.edited` | the same message after its author edited it |
| `message.deleted` | the same message after its author deleted it |
| `thread.reply` | a reply, with the thread root it belongs to |
| `reaction.added` | a reaction on a federated message |
| `reaction.removed` | the same reaction, taken back |
| `membership.joined` | a local account joined a community that lives on another instance |
| `membership.left` | the same account left it again |
| `message.accepted` | the owner took a message a member wrote on another instance |
| `message.refused` | the owner would not take it, and says why |
| `membership.updated` | the owner changed a member's standing: muted, removed or restored |

A kind that is not in this table is not part of the protocol: the publisher
cannot produce it and the receiver refuses it. That is deliberate - an
unknown kind is either a mistake or an attempt to make the receiver run
something it was never asked to understand.

## The relay rules

These decide what leaves this instance, and what it accepts. They live in one
place (`backend/src/services/continuum/rules.js`) and every publication path
and every inbound path asks them the same questions.

- **A private community is never federated.** A community with
  `is_public = 0` produces no outbound event of any kind, and the discovery
  document does not list it. It also accepts nothing: a member of a community
  that has been made private is refused, with the reason.
- **A restricted channel is never federated.** The decision is per channel,
  not per community: the channel is federable when the community's baseline
  role - the role every member holds - may still post in it, after the
  category and channel overrides are applied. A channel that has been made
  staff-only produces no outbound event, whatever the sender may do in it,
  and a member writing in it from another instance is refused.
- **The sender's own permission is what counts.** A message is federated only
  if its author could post in that channel - the same check the send path
  makes, with the same timeout rule.
- **A member of a federated community holds the baseline role, and nothing
  else.** Joining grants no role, no permission and no moderation power. So
  the question the owner asks about a member's message is the question it
  asks about its own members: may the members of this community post in this
  channel?
- **A member may not write in a community they have not joined, and a muted
  or removed member may not write at all.** The owner keeps the record of who
  its members are (`continuum_relay_memberships`) and what it has decided
  about them.
- **Nothing is federated to an instance that is not trusted.** Only `trusted`
  peers are delivery targets. A `pending` or `blocked` peer is not asked, and
  its earlier attempts are not retried. Nothing is accepted from a peer that
  is not trusted either.
- **Encrypted content is never federated.** Not relayed in the clear, and not
  relayed as a ciphertext the far end cannot read. An end-to-end encrypted
  conversation is not federated at all. In this build the encrypted
  conversations are the direct-message ones, which the relay never carries;
  the rule is enforced regardless, and it is what a channel that gains
  encryption will meet.
- **What was not federable when it was written is not federated later.** A
  message posted in a private community stays here even after the community
  is made public. The decision is kept in the ledger, with the reason that
  produced it, so the operator is told which rule stopped it rather than
  only that something did.

A deletion is relayed, so the remote copy does not outlive the original. A
remote instance that has never seen the message records the deletion as a
no-op, not as an error: the outcome the sender wanted is already true.

### The rules are asked in both directions

Every rule above governs the relay in both directions, and they are enforced
in both:

| Rule | Leaving this instance | Arriving here |
| --- | --- | --- |
| A private community | nothing leaves it | a member's message in it is refused |
| A restricted channel | nothing leaves it | a member's message in it is refused |
| The sender's own permission | only what the author may write leaves | the member's standing here decides what the owner accepts |
| A trusted peer only | only trusted peers are targets | only trusted peers are believed |
| Encrypted content | it does not leave | it is refused on arrival |
| Not federable when written | it stays here | the owner's answer is a refusal, not a delay |

## The trust model

Trust is per instance and operator-managed. A peer is `trusted`, `pending`
or `blocked`:

| Trust | Outbound | Inbound |
| --- | --- | --- |
| `trusted` | events are delivered to it | its events are accepted, after its signature is verified against the key the operator recorded |
| `pending` | nothing | nothing - the instance is not vouched for yet, so its events are refused |
| `blocked` | nothing | nothing |

Removing a peer is the same decision, taken further: an instance that is no
longer known is one whose signatures mean nothing here, and its events are
refused.

The signature is verified against the key recorded for the sending instance,
which is bound to the envelope by `key_id` rather than by the address the
event came from. A peer that is blocked mid-flight stops receiving: the
delivery path reads the trust of every destination at the moment it
delivers, so an event that is already in flight is not retried to a peer
that has since been blocked.

**Identity survives restarts.** The signing key pair is generated once and
kept in `continuum_keys` (one row). Remote peers verify this instance's
signatures against the key they recorded; a restart that regenerated it would
strand every relationship.

## A remote community is a reference, never a copy

A community on another instance becomes a row in `continuum_communities`:
the instance it lives on, its id there, its name, description, icon, the
channels it exposes, when it was last synced, and its state
(`discovered`, `joined`, `left`, `revoked`). It is **not** a row in
`servers`. It grants no role, no permission and no moderation power here,
and the instance that owns it decides who may read its channels, who may
post, and who may remove whom.

The state says where the relationship stands: `discovered` when nobody here
has joined it, `joined` when somebody has, `left` when everybody who joined
has left again, and `revoked` when the instance that owns it has been
removed - the community is still on record, and the relationship is over.

The messages that arrive are kept in the **relay store**, keyed by
`(origin instance, origin id)` so that a remote id can never collide with a
local one and the same message arriving twice lands on the same row:

- `continuum_relay_messages` - the message, the origin's author, the
  origin's timestamp, whether it was edited or deleted, and the thread it
  belongs to.
- `continuum_relay_reactions` - the reactions on those messages.
- `continuum_relay_memberships` - the members of **this** instance's
  communities who live on another instance. This instance decides what such
  a member may do; the row is the record of them and grants nothing.

A relayed message is presented as a relayed message: it keeps the origin's
timestamp and the origin's author, it says which instance it came from, and
it is marked `relayed` so the interface can say so.

### Joining

A local account may join a federated community. Joining records the
membership locally (`continuum_memberships`) and relays a `membership.joined`
event to the instance that owns the community, which records the member
against its own community.

**Joining grants no authority over the remote community.** No role, no
permission, no moderation power - here or there. The origin instance decides
what a member of its community may do, and the origin instance is the one
that enforces it. The origin also decides whether to accept the join at all:
a join for a community that does not exist here, or for one that is not
federated, is recorded and not applied.

Leaving relays `membership.left` in the same way.

### Writing

A member of a federated community may write in it from the instance they are
on:

```
POST /api/continuum/communities/:instanceId/:communityId/channels/:channelId/messages
```

The message is kept here until the owner answers, and the answer is the
owner's. This instance applies the rules it can see - the peer is trusted,
the community is one the peer federates, the channel is one the peer
exposes, and the writer has joined - and publishes the message to the owner.
The owner applies its own rules to it and answers:

- **accepted** - the owner took the message. It is kept at the owner as a
  relayed message in the community it belongs to, with the author's name as
  the other instance had it, and with the timestamp the writer gave it.
- **refused** - the owner would not take it, and the reason says why: the
  community is private, the channel is one the members may not post in, the
  writer is not a member, the writer is muted or has been removed.

The answer reaches the writer, and the writer is told - the message the
writer wrote carries the answer and the reason. A message that vanishes
without a word is worse than one that is refused.

The message the writer wrote is kept here in `continuum_relay_outgoing`, with
its state: `pending` until the owner answers, then `accepted`, `refused` or
`deleted`. It is not a local message: the community is not here, and the
message grants nothing over it. The writer may edit it and take it back
while it is there, and both changes travel to the owner.

**Writing grants no authority.** A member of a federated community gains no
role, no permission and no moderation power on either instance. The message
is not a message of the owner's community: it is not in the owner's message
table, the writer is not in the owner's member list, and the writer's
account is not an account on the owner's instance at all. The owner decides
what its members may do, and it enforces it there.

## Moderation across instances

The owner of a community can see what its members wrote elsewhere, and act
on it. The surfaces are:

- `GET /api/continuum/moderation/messages` - the messages members of this
  instance's communities wrote on other instances, with the author and the
  timestamps as the other instance had them. A community moderator sees the
  messages of their own community; a platform administrator sees all of them.
- `DELETE /api/continuum/moderation/messages/:instanceId/:messageId` - take
  one back. The message goes from here, and the instance that wrote it is
  told, so the copy over there does not outlive this one. The writer is told
  that their message was taken back.
- `GET /api/continuum/moderation/members` - the members of this instance's
  communities who live on another instance, with what this instance has
  decided about them.
- `POST /api/continuum/moderation/members/:instanceId/:userId` - mute,
  remove or restore one. A muted member's messages are refused with the
  reason; a removed member's are refused too. The member's own instance is
  told, so the member stops writing rather than finding out one message at a
  time.

Everything done here is recorded in `audit_logs`, the same trail the local
moderation writes to: who did it, to whom, in which community, and why.

## Delivery

Delivery is an HTTPS POST to the remote inbox. An event that has not been
delivered yet is retried with a bounded backoff and jitter
(`CONTINUUM_MAX_ATTEMPTS`, default 5, and `CONTINUUM_RETRY_BASE_MS`, default
1000). A destination that has already received an event is not asked again,
so one unreachable peer does not stop the others from receiving it.

When the attempts are spent the event is a terminal `failed` state with the
reason it failed, and it is not retried again.

Events for one actor are delivered in the order they were published, so the
receiver sees the sequence numbers in order.

Every attempt is logged in `continuum_deliveries`. `GET
/api/continuum/deliveries` adds that log up per event and per destination:
`pending`, `delivered` or `failed`, the attempt count, the reason and when
the last attempt was made.

## The change feed

The relay publishes from this instance's own state rather than from a hook
in every write path. A hook in every write path is a promise that every
write path remembers to keep it, and one that forgets does it silently: the
message is posted, and the peer never hears about it.

So the relay reconciles instead. It keeps a ledger of what it has already
federated (`continuum_publications`), and each pass compares that ledger
against the local tables:

- rows the ledger does not know about are new: publish them
- rows whose state has changed are updates: publish the change
- rows that are gone are deletions: publish the deletion

**The ledger is the record.** A row that is in it has been published, and a
second pass over the same row publishes nothing. A row the rules decided
against is kept as decided against, with the reason, and it is not published
later.

**A change is published once it has settled.** The feed publishes the state
a row is in, not every state it was in, so a message that is edited twice in
a moment is one change and not two. A row whose last change is more recent
than the feed interval waits for the next pass. The bound on a change being
noticed is therefore **two intervals** - one to notice it, one to be sure it
has stopped moving.

**The lag is visible.** `GET /api/continuum/feed` says how often the feed
runs, when it last ran, how long ago that was, what it published, what the
rules refused, and whether it is behind the bound. A feed that falls behind
is not quiet about it.

## What is not federated

- **Private communities.** Not their messages, not their channel list, not
  their name.
- **Restricted channels.** A channel the community's members may not post in.
- **Encrypted conversations.** Not in the clear, not as a ciphertext.
- **Direct messages.** The relay carries communities, not conversations
  between accounts.
- **Roles, permissions and moderation.** A remote community's staff are the
  remote community's staff. Nothing about them crosses.
- **Transitive federation.** An event received from a peer is stored here and
  is not relayed onwards to a third instance.
- **The members of a remote community.** A remote member's name is carried
  when they write something, and that is all.
- **Attachments.** A relayed message carries its text, not its files.

## The routes

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /.well-known/trycord` | public | the discovery document: instance id, protocol version, capabilities, public key, and the communities this instance federates |
| `POST /api/continuum/inbox` | rate-limited, public | the event inbox; verifies signatures against the recorded key |
| `GET /api/continuum/instances` | platform admin, federation on | the peers this instance knows |
| `POST /api/continuum/instances` | platform admin | add a peer (id, name, origin, public key) |
| `DELETE /api/continuum/instances/:id` | platform admin | remove a peer; its events are refused from then on |
| `PATCH /api/continuum/instances/:id/trust` | platform admin | trust / block / set pending |
| `POST /api/continuum/instances/:id/sync` | platform admin | fetch a peer's federated community list and record it |
| `GET /api/continuum/events` | platform admin | the durable outbox with delivery status and attempts |
| `GET /api/continuum/events/:id` | platform admin | one event in full, with its payload |
| `GET /api/continuum/deliveries` | platform admin | the delivery status per event and per destination |
| `GET /api/continuum/inbox` | platform admin | what arrived, processed or held |
| `GET /api/continuum/probe?origin=` | platform admin | fetch a remote discovery document server-side, with the same origin guard delivery itself enforces |
| `GET /api/continuum/communities` | platform admin | the remote communities this instance knows about |
| `GET /api/continuum/communities/:instanceId/:communityId/messages` | signed in | the relayed messages of one remote community |
| `POST /api/continuum/communities/:instanceId/:communityId/join` | signed in | join a community that lives on another instance |
| `POST /api/continuum/communities/:instanceId/:communityId/leave` | signed in | leave it again |
| `GET /api/continuum/memberships` | signed in | the remote communities this account follows |
| `POST /api/continuum/communities/:instanceId/:communityId/channels/:channelId/messages` | signed in | write in a federated channel from here |
| `GET /api/continuum/outgoing` | signed in | the messages this account wrote into communities that live elsewhere, and what their owners said about them |
| `PATCH /api/continuum/outgoing/:messageId` | signed in | edit one of them |
| `DELETE /api/continuum/outgoing/:messageId` | signed in | take one of them back |
| `GET /api/continuum/moderation/messages` | signed in, per community | what members of this instance's communities wrote elsewhere |
| `DELETE /api/continuum/moderation/messages/:instanceId/:messageId` | signed in, per community | take one of those messages back |
| `GET /api/continuum/moderation/members` | signed in, per community | the members of this instance's communities who live elsewhere |
| `POST /api/continuum/moderation/members/:instanceId/:userId` | signed in, per community | mute, remove or restore one of them |
| `GET /api/continuum/feed` | signed in | the change feed's state: when it last ran and how far behind it is |
| `GET /api/continuum/relay/messages` | platform admin | everything that arrived from another instance |
| `GET /api/continuum/relay/memberships` | platform admin | the members of this instance's communities who live elsewhere |

## The tables

The federation tables live in `backend/src/db/tables/continuum.js`, next to
the ones that were already there.

| Table | What it holds |
| --- | --- |
| `continuum_instances` | the peers: id, name, origin, public key, trust status |
| `continuum_events` | the outbox: one signed event awaiting delivery, with its attempts and its status |
| `continuum_deliveries` | the delivery log: one row per attempt, per event and per destination |
| `continuum_inbox` | the received events, used for deduplication and replay protection |
| `continuum_keys` | this instance's own signing identity, generated once |
| `continuum_communities` | the remote communities: origin instance, origin id, name, description, icon, the channels they expose, the sync time and the state |
| `continuum_memberships` | which local account follows which remote community |
| `continuum_relay_messages` | the messages that arrived: origin instance, origin message id, origin community and channel, the origin's author, the origin's timestamps, the edit and the deletion |
| `continuum_relay_reactions` | the reactions that arrived, keyed by origin instance, message, user and emoji |
| `continuum_relay_memberships` | the members of this instance's communities who live on another instance, and what this instance has decided about them |
| `continuum_relay_outgoing` | the messages written here for a community that lives elsewhere: the owner instance, the community and channel as they are there, the author, the content, the state and the owner's answer |
| `continuum_publications` | the relay's ledger: what has been federated, the state it was in, and the context a later deletion needs |
| `continuum_sequences` | the per-actor sequence counters, outbound and inbound |
| `continuum_feed_state` | where the change feed stopped, and what it last did |

## The environment

| Variable | Default | What it does |
| --- | --- | --- |
| `CONTINUUM_ENABLED` | off | the master switch: `continuum.enabled` |
| `CONTINUUM_ALLOW_LOCALHOST` | off | whether a peer may live on a loopback or private address. It is off because a peer address is attacker-controlled; it is on for a private network that legitimately hosts a peer |
| `CONTINUUM_MAX_ATTEMPTS` | 5 | how many times a delivery is attempted before it is given up on |
| `CONTINUUM_RETRY_BASE_MS` | 1000 | the first wait between attempts; it doubles, with jitter, up to an hour |
| `CONTINUUM_FEED_INTERVAL_MS` | 2000 | how often the change feed reconciles the local state against the ledger, and how long a change has to have settled before it is published |

## Where an operator touches it

The **Continuum page** of the instance console (desktop and the phone's admin
carry the same manager). The master switch is the settings store's
`continuum.enabled`, flipped live. Adding a peer: enter the remote origin,
run the check (the probe fetches the remote discovery document and fills the
form), confirm, then trust the peer. The outbox and the inbox show the real
traffic, including delivery failures after every retry was spent.

### Realtime

A relayed message or reaction is pushed to the local accounts that follow the
remote community, as a user-scoped event:

| Event | What it says |
| --- | --- |
| `continuum:relay-message` | a message arrived in a remote community the account follows |
| `continuum:relay-reaction` | a reaction arrived on one of those messages |
| `continuum:relay-outgoing` | the state of a message this account wrote into a community that lives elsewhere changed: taken, refused, or taken back |

They carry `relayed: true` and the origin's ids. They belong in the
realtime vocabulary (`backend/src/ws/events.js`), which is where every event
name in this codebase is written down.

## How it was verified

Federation is proved against **two** real instances: separate databases,
separate signing keys, separate ports, separate administrative authority.
`backend/tests/continuum/` is the evidence.

`relay.test.js` starts both instances, peers them through the real
administration routes, and then watches one community travel between them: a
public community is federated and recorded as a remote community; a message
arrives as a relayed message with its author, its origin instance and its
original timestamp; an edit, a reaction, a reply and a deletion all arrive;
a local account on the far instance joins the community and the origin
records the remote member. The refusals are part of the same exercise: a
private community produces no outbound event and is not in the discovery
document; a channel the members cannot post in produces no outbound event; a
peer that is pending or blocked receives nothing, and the outbox does not
keep trying it; a replayed event is refused and changes nothing; a duplicate
delivery is one relayed message; an event signed with the wrong key is
refused; an event whose timestamp is outside the accepted window is refused;
an event whose sequence is not newer than the last one accepted from that
actor is refused; and an event from a peer that was removed is refused.

The same file proves the return direction: a member of a federated
community writes in it from the other instance, and the owner keeps the
message with its author, its origin ids and its original timestamp, and
answers; the writer is told the answer. Writing grants no role, no
permission and no moderation power on either instance - the writer is in no
member list, holds no role, and has no account on the owner at all. The
owner takes a message back and the removal reaches the writing instance; the
owner mutes a member and the member is refused; a message in a channel the
members may not post in is refused; a message in a community the owner has
made private is refused; and every one of those refusals reaches the writer
with the reason.

`queue.test.js` watches the outbox: an event to a peer that cannot be
reached stays pending, is retried a bounded number of times, ends in a
reported `failed` state with a reason, and is not retried again; a delivery
that works is recorded as `delivered` with its attempt count, and the peer
really did receive the envelope over HTTP. It also watches the change feed:
a change is published once and not again, a message edited twice in a moment
is published as one change and not three, and the feed's lag is visible to
the operator.

`permissions.test.js` covers the rules where they live, in both directions:
a private community produces no events and refuses what a member wrote
elsewhere; a restricted channel produces no events and refuses what a member
wrote elsewhere; a sender who may not post produces no event, and a member
who may not post is refused; encrypted content is refused in either
direction; a peer that is not trusted is neither a delivery target nor a
destination; and what was not federable when it was written is not federated
later.

The one guard that decides which addresses may be reached lives in
`backend/src/services/netguard.js`, shared by the federation probe, the
delivery path and the instance discovery reader, so the three cannot drift
apart. A private-range origin is rejected by the keep-out list before
anything is sent, the probe is an administrative route, and a
federation-disabled instance answers 404 everywhere.

## The limits of the protocol

- **A relayed message is not in the owner's channel history.** It is in the
  federation moderation surface, where the owner and its moderators can see
  it, and it is nobody's message in the community: putting it in the
  channel's own history would make it look like a local message written by
  one of the owner's own members. Merging the relay store into the channel
  history is a change in the channel and message routes.
- **A member's message does not notify the owner's members in real time.**
  The owner sees it in the moderation surface; the community at large does
  not see it in the channel.
- **The return direction needs version 1.2 on both ends.** A peer that
  speaks 1.1 does not know the answer kinds (`message.accepted`,
  `message.refused`, `membership.updated`) and refuses them, so a writer
  there is never told what the owner decided. A 1.1 peer also treats a
  member's message as a relayed message about a community it does not own,
  rather than as something to accept or refuse.
- **Reactions do not travel back.** A member of a federated community can
  write in it, but a reaction they leave on a message stays on their
  instance.
- **A removal does not travel when the community has been closed.** A
  community that has been made private federates nothing more, not even the
  removals - the same rule in both directions. The owner's answer to a
  member's message does travel, because it carries no content of the
  community.
- **A channel that is closed on the origin is not relayed as closed.** The
  origin's channel list is corrected by the next `community.updated`.
- **The change feed that finds edits, deletions and reactions reconciles
  continuously, in bounded batches.** On a large instance a change is noticed
  within a pass or two rather than instantly, and a change that has not
  settled waits for one more interval.
- **Attachments are not federated**, and neither are the files behind a
  relayed message.
- **The protocol version is `1.2`.** A peer that speaks `1.1` understands the
  kinds it knows; it refuses the ones it does not, and the refusal is
  visible in the delivery log.

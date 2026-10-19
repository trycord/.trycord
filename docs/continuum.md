# Community Continuum

Federation between compatible Trycord instances. **Opt-in and opt-out at
will**: while `continuum.enabled` is off (default), this instance is
local-only - nothing is sent, nothing is accepted, and the discovery document
answers 404.

Continuum federates *communities*, not accounts. A community that lives on
another instance stays there: it is described here, it is read here, and it is
never copied into this instance's own tables. The instance that owns a
community remains the only authority over it.

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
| `origin` | the instance that speaks (`instance_id`), the author on that instance (`actor_id`), the author's name as it was at the time (`author_username`, `author_display_name`), the ids the community, channel and message have **on the instance that owns them** (`community_origin_id`, `channel_origin_id`, `message_origin_id`, `thread_root_origin_id`), when it happened (`occurred_at`) and the per-actor sequence number (`seq`) |
| `community` | the community as the origin describes it: its id, name, description, icon and the channels it exposes |
| `channel` | the channel: its id, name, type, topic and whether the members may post in it |
| `message` | the message: its id, content, the origin's timestamps |
| `reaction` | the reaction: the message it is on, the emoji, who reacted and their name at the time |
| `membership` | the member: their id on the origin, their name, and whether they joined or left |

The author snapshot is taken when the event is published, not when it is
read. A rename on the origin does not rewrite what a remote instance already
knows about who wrote a message.

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

A kind that is not in this table is not part of the protocol: the publisher
cannot produce it and the receiver refuses it. That is deliberate - an
unknown kind is either a mistake or an attempt to make the receiver run
something it was never asked to understand.

## The relay rules

These decide what leaves this instance. They live in one place
(`backend/src/services/continuum/rules.js`) and every publication path asks
them the same questions.

- **A private community is never federated.** A community with
  `is_public = 0` produces no outbound event of any kind, and the discovery
  document does not list it.
- **A restricted channel is never federated.** The decision is per channel,
  not per community: the channel is federable when the community's baseline
  role - the role every member holds - may still post in it, after the
  category and channel overrides are applied. A channel that has been made
  staff-only produces no outbound event, whatever the sender may do in it.
- **The sender's own permission is what counts.** A message is federated only
  if its author could post in that channel - the same check the send path
  makes, with the same timeout rule.
- **Nothing is federated to an instance that is not trusted.** Only `trusted`
  peers are delivery targets. A `pending` or `blocked` peer is not asked, and
  its earlier attempts are not retried.
- **Encrypted content is never federated.** Not relayed in the clear, and not
  relayed as a ciphertext the far end cannot read. An end-to-end encrypted
  conversation is not federated at all. In this build the encrypted
  conversations are the direct-message ones, which the relay never carries;
  the rule is enforced regardless, and it is what a channel that gains
  encryption will meet.
- **What was not federable when it was written is not federated later.** A
  message posted in a private community stays here even after the community
  is made public.

A deletion is relayed, so the remote copy does not outlive the original. A
remote instance that has never seen the message records the deletion as a
no-op, not as an error: the outcome the sender wanted is already true.

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
| `continuum_relay_memberships` | the members of this instance's communities who live on another instance |
| `continuum_publications` | the relay's ledger: what has been federated, the state it was in, and the context a later deletion needs |
| `continuum_sequences` | the per-actor sequence counters, outbound and inbound |
| `continuum_feed_state` | where the change feed stopped, so the next pass picks up where it left off |

## The environment

| Variable | Default | What it does |
| --- | --- | --- |
| `CONTINUUM_ENABLED` | off | the master switch: `continuum.enabled` |
| `CONTINUUM_ALLOW_LOCALHOST` | off | whether a peer may live on a loopback or private address. It is off because a peer address is attacker-controlled; it is on for a private network that legitimately hosts a peer |
| `CONTINUUM_MAX_ATTEMPTS` | 5 | how many times a delivery is attempted before it is given up on |
| `CONTINUUM_RETRY_BASE_MS` | 1000 | the first wait between attempts; it doubles, with jitter, up to an hour |
| `CONTINUUM_FEED_INTERVAL_MS` | 2000 | how often the change feed reconciles the local state against the ledger |

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

Both carry `relayed: true` and the origin's ids. They belong in the
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

`queue.test.js` watches the outbox: an event to a peer that cannot be
reached stays pending, is retried a bounded number of times, ends in a
reported `failed` state with a reason, and is not retried again; a delivery
that works is recorded as `delivered` with its attempt count, and the peer
really did receive the envelope over HTTP.

`permissions.test.js` covers the rules where they live: a private community
produces no events, a restricted channel produces no events, a sender who
may not post produces no event, encrypted content is refused, and a peer that
is not trusted is not a delivery target.

The one guard that decides which addresses may be reached lives in
`backend/src/services/netguard.js`, shared by the federation probe, the
delivery path and the instance discovery reader, so the three cannot drift
apart. A private-range origin is rejected by the keep-out list before
anything is sent, the probe is an administrative route, and a
federation-disabled instance answers 404 everywhere.

## The limits of the protocol

- The relay is one-way for content. A member of a federated community reads
  it here; this build does not yet carry their messages back to the origin,
  so the origin cannot act on them.
- A channel that is closed on the origin is not relayed as closed. The
  origin's channel list is corrected by the next `community.updated`.
- The change feed that finds edits, deletions and reactions reconciles
  continuously, in bounded batches. On a large instance a change is noticed
  within a pass or two rather than instantly.
- Attachments are not federated, and neither are the files behind a relayed
  message.
- The protocol version is `1.1`. A peer that speaks `1.0` understands the
  kinds it knows; it refuses the ones it does not, and the refusal is
  visible in the delivery log.

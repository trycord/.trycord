# Community Continuum

Federation between compatible Trycord instances. **Opt-in and opt-out at will**:
while `continuum.enabled` is off (default), this instance is local-only - nothing
is sent, nothing is accepted, and the discovery document answers 404.

## What it is, honestly

- Events are **JSON envelopes signed with Ed25519** (`node:crypto` - no custom
  cryptography). Each envelope carries an id, a kind, an actor, a target, a
  payload, a timestamp and a signature; `key_id` names which public key the
  receiver verifies against.
- Delivery is an **HTTPS POST to the remote inbox**, retried with bounded
  backoff and jitter, deduplicated on receipt by event id. Exactly-once is the
  receiver's job and the outbox keeps trying until it is.
- **What today federates**: posting a message to a community enqueues one
  `message.posted` event, delivered to every trusted peer. A peer records it,
  verifies the signature, deduplicates it, and stores it. **Messages are not
  transitively created on the remote instance**: a `message.posted` received
  over federation does not become a local message, deliberately - accepting one
  blindly would bypass the receiving instance's moderation and verification.
  That is the current protocol, and everything the interface says about it
  says exactly that.
- **Trust is per-instance and operator-managed**: `trusted` instances receive
  outbound events and their inbound events are verified against the key an
  operator pasted when adding them. `blocked` receives nothing. `pending`
  receives nothing and delivers nothing.
- **Identity survives restarts.** The signing key pair is generated once and
  kept in `continuum_keys` (one row). Remote peers verify this instance's
  signatures against the key they recorded; a restart that regenerated it would
  strand every relationship.

## Who can reach what

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /.well-known/trycord` | public | the discovery document: instance id, protocol version, capabilities, public key, enabled |
| `POST /api/continuum/inbox` | rate-limited, public | the event inbox; verifies signatures against the recorded key |
| `GET /api/continuum/instances` | platform admin, federation on | the peers this instance knows |
| `POST /api/continuum/instances` | platform admin | add a peer (id, name, origin, public key) |
| `PATCH /api/continuum/instances/:id/trust` | platform admin | trust / block / set pending |
| `GET /api/continuum/events` | platform admin | the durable outbox with delivery status and attempts |
| `GET /api/continuum/inbox` | platform admin | what arrived, processed or held |
| `GET /api/continuum/probe?origin=` | platform admin | fetch a remote discovery document server-side, with the same origin guard delivery itself enforces |

## Where an operator touches it

The **Continuum page** of the instance console (desktop and the phone's admin
carry the same manager). The master switch is the settings store's
`continuum.enabled`, flipped live. Adding a peer: enter the remote origin, run
the check (the probe fetches the remote discovery document and fills the
form), confirm, then trust the peer. The outbox and the inbox show the real
traffic, including delivery failures after every retry was spent.

## How it was verified

Federation is proved against **two** real instances: separate databases, separate
keys, separate administrative authority. The second instance is configured to
trust the first, an event is signed by the first and delivered over HTTPS, and
the second verifies the signature, records the event in its durable inbox, and
delivers it to the community it was addressed to. The delivery is acknowledged,
the outbox records it, and the whole path survives a restart of the sending
instance: the key is republished and the peer relationship still verifies.

The refusals are part of the same exercise. A private-range origin is rejected
by the keep-out list before anything is sent, the probe is an administrative
route, and a federation-disabled instance answers 404 everywhere. The one
guard that decides which addresses may be reached lives in
`backend/src/services/netguard.js`, shared by the federation probe, the
delivery path and the instance discovery reader, so the three cannot drift
apart.

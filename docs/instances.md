# Instances, discovery and federation

Three different things, often confused. This document says which is which,
because an instance that is *listed* is not thereby *reachable*, not thereby
*compatible*, and certainly not thereby *trusted*.

| | What it means | Who decides it |
|---|---|---|
| **Discoverable** | this instance appears in the public listing | the operator, with `instance.discoverable` |
| **Reachable** | the address answers | the network |
| **Compatible** | it speaks the protocol this client speaks | the code, through `apiVersion` and `protocolVersion` |
| **Accepting registrations** | it will create an account | the operator, with `registration.enabled` |
| **Trusted** | signed events from it are accepted as genuine | the operator, by trusting the peer in Continuum |

Discovery never implies trust. A directory can list an instance that is
hostile, and a hostile directory can list an instance that is perfectly fine.
The client checks the instance itself before offering it.

## The instance in force

The client talks to exactly one instance at a time. Which one is decided in
one place, `frontend/packages/config.js`, in this order:

1. the address the reader chose in this browser,
2. the build's own `backend.json`,
3. the origin that served the page,
4. the hosted default.

A `?api=` argument is a *hint*. It is offered to the reader at boot and stored
only on their say-so. Applying it silently was the whole of the repointing
attack: one click on a link, and every bearer request from then on went to the
attacker's origin.

### Sessions belong to an instance

A token is stored under the origin of the backend in force, not in one global
slot. Switching instances therefore cannot carry the previous instance's
session across, which is what a single global key would do. The switch also
closes the socket, drops the cached communities, conversations, people and
presence, and forgets the old instance's token.

An account on one instance is not an account on another. Registration creates
an account on the instance it was made on, and nowhere else.

## Choosing an instance

`/instances` lists what the current instance knows about and accepts an
address typed by hand. An address is checked against the instance itself -
`/api/instance` for its identity and registration state, and
`/.well-known/trycord` for its Continuum document - before it is accepted.
An instance that does not federate has no Continuum document, and that is a
fact about it rather than a failure.

The same page exists on the phone.

## The public instance document

`GET /api/instance` is public and carries only what a reader needs:

```json
{
  "instanceId": "official",
  "name": "Trycord Official",
  "description": "",
  "supportUrl": "https://trycord.dev/support",
  "apiVersion": 1,
  "protocolVersion": "trycord-continuum/1.0",
  "registration": {
    "enabled": true,
    "approvalRequired": false,
    "emailVerificationRequired": false
  },
  "features": { "publicDiscovery": true, "uploads": true, "email": false }
}
```

No operator configuration, no internal address and no secret appears in it.

## Discovery

`GET /api/discovery/instances` is the public listing. It has two sources,
neither of which is required:

- this instance, when the operator has set `instance.discoverable`;
- directories the operator has configured in `instance.discoverySources`.

A directory is a plain JSON document served by whoever runs it, holding either
a list or `{ "instances": [...] }`. Each record may carry `url`, `name`,
`description`, `instanceId`, `registrationOpen` and `verified`. A record that
is not well formed, or that points at an address the guard refuses, is dropped
and the rest of the answer still comes back. A directory that is slow, broken
or hostile costs the reader nothing.

### The guard

The rules that decide which addresses this instance may reach live in
`backend/src/services/netguard.js`, and one copy of them serves the federation
probe, the federation delivery path and the discovery reader. Two copies would
drift, and a rule that drifted is how a private network gets reached by
accident.

What it refuses:

- a host that resolves into a private, loopback, link-local or multicast
  range, unless the operator explicitly allowed local addresses;
- the cloud metadata endpoints, by name and by their well-known address;
- embedded credentials in a URL;
- a scheme that is not http or https;
- a redirect - a redirect is the easiest way to arrive somewhere else.

A name that resolves to `127.0.0.1` is refused as well: a hostname that looks
harmless is the classic way past a hostname check.

## Federation

Federation is Continuum, and it is opt-in. The instance publishes
`/.well-known/trycord`, which carries its identity, its public key, the
protocol version it speaks and the capabilities it offers. Events between
instances are signed, delivered over HTTPS, recorded in a durable outbox on
the sending side and a durable inbox on the receiving side, and deduplicated
on the way in.

`docs/continuum.md` describes the protocol itself.

Federation being off changes nothing about the local product. An instance
with federation off still registers people, sends messages, keeps its
communities, and answers the discovery listing.

## What an operator controls

| Setting | Meaning |
|---|---|
| `instance.discoverable` | whether this instance is listed publicly |
| `instance.discoverySources` | the directories to read, if any |
| `instance.publicUrl` | the address other instances and readers should use |
| `registration.enabled` | whether new accounts can be created at all |
| `registration.approval` | whether a new account waits for an administrator |
| `registration.emailVerification` | whether a new account must confirm an address |
| `continuum.enabled` | whether this instance federates |

All of them live in the Admin Configuration, are persisted in the instance
database, and are enforced on the server. The registration rules are enforced
in the registration handler itself: a client that calls the API directly is
refused exactly as the form would refuse it.

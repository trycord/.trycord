# Voice and video

Trycord can carry a call in three ways. This document says what each one is,
what it needs before it can carry anything, and how an operator finds out
whether it works.

The short version:

- **Mesh** is the instance's own path. The media travels between the
  participants and the server carries the signalling. It suits a small room.
- **Cloudflare Realtime** is the Cloudflare SFU. The media is carried by
  Cloudflare and the instance holds the authorisation.
- **Third-party SFU** is a media server the operator runs, reached over HTTP.

Only one of them is in force at a time. Each keeps its own settings, so
choosing a different one does not erase what was saved for the one before it.

---

## The providers

### Mesh

The media travels between every participant. The server never sees it: it
carries the offers, the answers and the ICE between the room members, and that
is all.

That has one consequence worth stating plainly: **the traffic a room produces
grows with the square of the number of people in it.** With six participants
each is sending five copies of its own audio. It is a small room by design,
and the limit is a setting (`voice.mesh.maxParticipants`, six by default).

A peer that cannot be reached directly - behind a symmetric NAT, or behind a
firewall that drops UDP - is reached through the **TURN relay**. That is what
the relay is for: the peers try each other first, and the relay carries the
media for the ones that cannot be met.

The mesh asks for no SFU credentials. It needs no application id and no
application secret, because there is no media server to authenticate to.

### Cloudflare Realtime

The instance creates a session on the Cloudflare API for each participant and
relays the SDP. The application id and the application secret are the
credential: the secret is sent to Cloudflare and to nothing else, and it never
reaches a browser.

The health check creates a session on the provider. That is the cheapest
authenticated call the API offers, and it proves the application id and the
secret together.

### Third-party SFU

A media server the operator runs. It is reached over HTTP, and the protocol it
speaks is small and written down here so that an operator knows what their
server has to offer.

With `{endpoint}` the base URL of the media server:

| Call | Answer |
|---|---|
| `POST {endpoint}/sessions` | `{ "sessionId": "..." }` |
| `POST {endpoint}/sessions/{id}/negotiate` | `{ "sessionDescription": { ... }, "tracks": [ ... ] }` |
| `POST {endpoint}/sessions/{id}/answer` | `{}` |
| `GET {endpoint}/sessions/{id}` | `{ "tracks": [ ... ], "dataChannels": [ ... ] }` |
| `DELETE {endpoint}/sessions/{id}` | `{}` |
| `GET {endpoint}/health` | anything; used by the health check |

The token is sent as `Authorization: Bearer <token>` with every request. It is
never sent to a browser.

---

## The settings

### Shared

| Key | What it is |
|---|---|
| `voice.enabled` | Whether this instance offers voice at all. |
| `voice.screenSharing` | Whether a member may share their screen. |
| `voice.stageChannels` | Whether stage channels are available. |
| `voice.provider` | Which provider is in force: `mesh`, `cloudflare` or `sfu`. |

### The mesh

| Key | What it is |
|---|---|
| `voice.mesh.maxParticipants` | How many people one mesh room holds. |
| `voice.mesh.publicUrl` | The address the relay is published at. It has to point straight at this instance. |

The instance supplies its own STUN and TURN servers and mints a short-lived
credential for each voice session. There are no Mesh URLs, usernames or
passwords to enter in the console: the one thing an operator has to state is
the address clients can reach the relay on.

### Cloudflare Realtime

| Key | What it is |
|---|---|
| `voice.cloudflare.appId` | The application id from the Cloudflare dashboard. |
| `voice.cloudflare.appSecret` | The application secret. A secret. |
| `voice.cloudflare.endpoint` | Where sessions are created. `https://rtc.live.cloudflare.com/v1` by default. |
| `voice.cloudflare.maxParticipants` | How many people one channel holds. |

### The third-party SFU

| Key | What it is |
|---|---|
| `voice.sfu.endpoint` | The base URL of the media server. |
| `voice.sfu.token` | The bearer token. A secret. |
| `voice.sfu.stunUrls` | STUN servers, comma-separated. |
| `voice.sfu.turnUrl` | The TURN relay. |
| `voice.sfu.turnUsername` | The username for a static TURN credential. |
| `voice.sfu.turnCredential` | The password half of a static TURN credential. A secret. |
| `voice.sfu.maxParticipants` | How many people one channel holds. |

The participant limit is shared in meaning and per-provider in value: each
provider holds its own, and the console shows the one belonging to the provider
in force.

### Settings from earlier releases

Cloudflare IDs and the old participant limit still carry forward:

| Old key | It is now |
|---|---|
| `voice.sfuAppId` | `voice.cloudflare.appId` |
| `voice.sfuAppSecret` | `voice.cloudflare.appSecret` |
| `voice.maxParticipants` | `voice.mesh.maxParticipants` |

Old manually entered Mesh STUN and TURN settings are left in storage, but the
runtime no longer uses them. New writes are refused: Mesh always uses the
instance's own relay, and its credentials are issued per session.

---

## The relay the instance runs itself

The instance ships a STUN and TURN server (`backend/src/services/turn.js`) and
nothing else starts it, so the voice subsystem does. The relay this instance
runs is the one the peers are given.

There is nothing to write down. No STUN address, no TURN address, no
username, no password: the instance starts the relay, publishes the address
it listens on, and mints a credential for the caller that asked.

The deployment decides two things - where the relay listens, and the address
the peers are given:

| Variable | What it is |
|---|---|
| `TRYCORD_TURN_HOST` | The address the relay listens on. A wildcard (`0.0.0.0` or `::`) means every interface. |
| `TRYCORD_TURN_PORT` | The port, `3478` by default. |
| `TRYCORD_TURN_REALM` | The realm used for the credential. |
| `TRYCORD_TURN_SECRET` | The secret the credential is derived from. |
| `TRYCORD_VOICE_PUBLIC_URL` | The address the peers are given. It has to be an address a browser can reach, and it is a voice address: a hostname that points straight at this instance, DNS only and not proxied. The console writes the same value as `voice.mesh.publicUrl`. |
| `TRYCORD_VOICE_PUBLIC_URL_V4` | The IPv4 address, when the voice URL is the IPv6 one and the instance has both. |
| `TRYCORD_VOICE_PUBLIC_URL_V6` | The IPv6 address, when the voice URL is the IPv4 one and the instance has both. |

How long the connectivity probe waits for an answer is
`TRYCORD_VOICE_PROBE_TIMEOUT_MS`, two and a half seconds by default.

The address the peers are given is chosen in this order, and the console says
which one it used:

1. `TRYCORD_VOICE_PUBLIC_URL`, or the `voice.mesh.publicUrl` setting the
   console writes.
2. `TRYCORD_TURN_HOST`, when it is not a wildcard.
3. `TRYCORD_PUBLIC_URL` - which is usually the address of a proxy that
   terminates TLS. A proxy carries HTTP and not the arbitrary UDP a TURN
   service needs, so a relay published at the site's address is a relay nobody
   can reach. The diagnostics say so rather than handing out an address that
   cannot work.

Both families are published when the instance has both, because a peer on an
IPv6-only network cannot reach an IPv4 address and the other way round. The
browser tries the list, so one list carries both.

The credential is derived from the secret and is minted for one session and one
caller. **The secret itself never leaves the process**: it is not in the
capability answer, not in a diagnostic, and not in a log. A client asks
`POST /api/voice/credentials` for it, and that route only answers for a
session that belongs to the caller.

One thing an operator should know: `TRYCORD_TURN_HOST` is the address the
relay listens on, and a wildcard is not an address a peer can reach. `0.0.0.0`
and `::` mean every interface, which is what a relay that has to be reached
from outside wants; the address the peers are given then comes from the voice
URL. When there is no voice URL either, the diagnostics say so.

### When the relay does not answer

The relay answers a STUN binding request, and it answers a TURN allocate with
a credential it issued itself - both are covered by the test suite
(`backend/tests/voice/turn-stack.test.js`).

The check in the console asks the relay for real, and says what it found:

> 2 of 2 ICE addresses answered a binding request. The relay listens on every
> interface and is published as [2001:db8::1], which is the address the clients
> are given.

The addresses it asks are the **published** ones - the addresses the clients
are given - because those are the ones that have to answer. A peer that is
handed an address that does not answer waits for it to time out.

The local address is asked as well, but only to explain a failure. A relay
that answers here and not there is a working relay and an unreachable
address, and those two have different fixes, so the console says which one it
is:

> Nothing answered a binding request at [2001:db8::1]:3478. The relay this
> instance runs is listening on :::3478, so it is running but not answering.
> Something answered a binding request at 127.0.0.1:3478, so the relay is
> running here, but the address the clients are given is not reachable.

An answer from the local address never makes the check pass on its own. Any
process on the host can be listening on the local port, and one that has
nothing to do with voice must not be taken for the relay.

A mesh whose relay does not answer **refuses to start a session**, because a
call that cannot connect is worse than a refusal. The way out is to publish
the relay at an address a browser can reach - `TRYCORD_VOICE_PUBLIC_URL` - or
to configure a STUN server for the mesh (`voice.mesh.stunUrls`).

---

## The runtime

- **One provider is in force.** It is `voice.provider`.
- **A provider that is selected but not configured cannot start a session.** The
  refusal names what is missing, and it is the same list the diagnostics show.
- **A provider whose endpoint does not answer is degraded**, not working. A
  provider is never reported as working because its configuration was saved.
- **A call that is running keeps the provider it started on.** The provider is
  remembered beside the participant, so changing the setting while people are
  talking does not move the call underneath them. A new participant joining
  that call joins it on the same provider; a new call elsewhere starts on the
  provider now in force, and is refused if that one is not ready.
- **The permission checks, the participant limit and the screen-sharing rule
  are the same for every provider.** They are asked of Trycord's own data before
  a session is created.
- **The instance starts with a voice configuration that cannot work.** It says
  so in the log, the console shows what is missing, and a session is refused
  with the same list. An operator who has pointed the instance at a provider
  they have not finished configuring has to be able to come in and finish it.

The provider a session is carried on is remembered in `voice_provider_sessions`,
one row per participant. That is what makes "the call finishes on the provider
it started on" a fact rather than a hope.

---

## The diagnostics

One answer per provider: the state, what is missing, and whether the other end
answered.

| State | What it means |
|---|---|
| `disabled` | Voice and video are off on this instance. |
| `configured` | The provider is not in force, or it has not been checked yet. |
| `active` | The provider is in force, complete, and the other end answered. |
| `degraded` | The provider is in force and complete, but the other end did not answer. |
| `failed` | The provider is in force and something it needs is missing. |

The checks are real. The mesh sends a STUN binding request to the addresses it
hands to its peers; Cloudflare creates a session; the third-party path asks the
media server whether it is there.

---

## The console

The **Voice and video** section of the administrative console:

- The provider is chosen first. Then **only that provider's fields** are shown,
  plus the controls every provider shares.
- The mesh shows its peer-connection, ICE and participant settings and asks for
  no SFU credentials. Cloudflare shows its application id, its application
  secret and its endpoint. The third-party path shows its endpoint, its token
  and its STUN and TURN settings.
- A credential is **managed, not typed**: a masked field that says whether one
  is set, a replace action and a clear action. A saved secret is never sent to
  the client, so there is nothing to display and nothing to leak.
- **Test connection** checks one provider for real and reports what it found.
- The shared controls - voice available, screen sharing, stage channels and the
  participant limit - are shown once.

---

## The API

| Route | What it does |
|---|---|
| `GET /api/voice/capabilities` | What this instance can do. Carries no credential. |
| `GET /api/voice/providers` | The providers, their settings and their states. Administrators only. |
| `POST /api/voice/providers/:id/check` | One provider's connectivity, checked for real. Administrators only. |
| `POST /api/voice/credentials` | The ICE configuration for a session that belongs to the caller. |
| `POST /api/voice/channels/:id/join` | Join a voice channel. |
| `POST /api/voice/channels/:id/leave` | Leave a voice channel. |
| `POST /api/voice/channels/:id/negotiate` | The SDP relay, for the providers that use one. |
| `POST /api/voice/channels/:id/screen` | Start sharing a screen. |
| `GET /api/voice/channels/:id/session` | The provider's view of the call. |
| `GET /api/voice/channels/:id/participants` | Who is in the channel. |

The instance settings are saved through the ordinary settings endpoint
(`PUT /api/admin/settings`), so the configuration console and the voice console
write the same rows through the same precedence.

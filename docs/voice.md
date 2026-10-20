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
| `voice.mesh.stunUrls` | STUN servers, comma-separated. |
| `voice.mesh.turnUrl` | The TURN relay. |
| `voice.mesh.turnUsername` | The username for a static TURN credential. |
| `voice.mesh.turnCredential` | The password half of a static TURN credential. A secret. |

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

### The settings the previous release used

The keys below are the ones the previous release saved. They still work, and an
operator does not have to retype anything:

| Old key | It is now |
|---|---|
| `voice.sfuAppId` | `voice.cloudflare.appId` |
| `voice.sfuAppSecret` | `voice.cloudflare.appSecret` |
| `voice.stunUrls` | `voice.mesh.stunUrls` |
| `voice.turnUrl` | `voice.mesh.turnUrl` |
| `voice.turnUsername` | `voice.mesh.turnUsername` |
| `voice.turnCredential` | `voice.mesh.turnCredential` |
| `voice.maxParticipants` | the limit of the provider in force |

The rule is one sentence: **the newer key wins; the older key is read only
while the newer one has never been saved.** The first save of a provider's
configuration writes the newer key, and from that moment the older one is not
consulted again. The console says where a value came from - `saved here`, `from
the environment`, `the default`, or `from the older setting voice.stunUrls` -
so an operator can see which of the two is in force.

The old keys are not shown in the configuration catalogue: the console edits the
new ones, and showing two fields for one value would be a trap.

---

## The relay the instance runs itself

The instance ships a STUN and TURN server (`backend/src/services/turn.js`) and
nothing else starts it, so the voice subsystem does: with the mesh in force and
no STUN or TURN address configured, the relay this instance runs is the one the
peers are given.

The address comes from the deployment:

| Variable | What it is |
|---|---|
| `TRYCORD_TURN_HOST` | The address the relay listens on, and the one peers are given. |
| `TRYCORD_TURN_PORT` | The port, `3478` by default. |
| `TRYCORD_TURN_REALM` | The realm used for the credential. |
| `TRYCORD_TURN_SECRET` | The secret the credential is derived from. |

The credential is derived from the secret and is minted for one session and one
caller. **The secret itself never leaves the process**: it is not in the
capability answer, not in a diagnostic, and not in a log. A client asks
`POST /api/voice/credentials` for it, and that route only answers for a
session that belongs to the caller.

Two things an operator should know:

- `TRYCORD_TURN_HOST` has to be an address a browser can reach. `0.0.0.0` is a
  listen address, not a reachable one; the diagnostics say so when it is set to
  a wildcard and the instance has no public URL to fall back on.
- The relay the instance ships does not currently answer. See
  *The relay is not answering* below.

### The relay is not answering

`services/turn.js` is complete on the page and does not work. Four defects stop
it answering a single packet:

1. The `STUN_*` names the request handler switches on (`STUN_BIND_REQUEST` and
   the rest) do not exist. The constants are `STYPE.BINDING_REQUEST` and the
   rest, so every case throws a `ReferenceError` before the packet is handled.
2. `xorMappedAddress` reads `MAGIC[i]`, and no `MAGIC` is declared. The
   constant it means is the magic cookie's bytes, `[0x21, 0x12, 0xa4, 0x42]`.
3. `handleBinding` reads `body.length` in the call that declares `body`, which
   is a temporal dead zone error, and it builds the response without the
   XOR-mapped-address attribute.
4. `parseStun` does not return the raw buffer, and `verifyAuth` needs it to
   find the message-integrity attribute - so the TURN allocate path throws
   before it can answer.

The voice subsystem does not work around any of this. It probes the relay for
real, and the diagnostic says exactly what it found:

> Nothing answered a binding request at 127.0.0.1:3478. The relay this instance
> runs is listening on 127.0.0.1:3478, so it is running but not answering.

A mesh whose relay does not answer **refuses to start a session**, because a
call that cannot connect is worse than a refusal. The way out is to configure a
STUN server for the mesh (`voice.mesh.stunUrls`), or to fix the four defects
above.

There is a second, smaller mismatch: `issueCredentials` mints a short-lived
credential from the secret, and `verifyAuth` expects the secret itself. The
credential the voice subsystem hands out is the one `issueCredentials` mints, so
the two agree with each other and not with the verifier.

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

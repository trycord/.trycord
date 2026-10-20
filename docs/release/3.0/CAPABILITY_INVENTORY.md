# Trycord 3.0 — capability inventory

Every capability the directive asks for, with what is actually true about it
today. The statuses are the only ones that mean something:

- **Verified** — the real path runs and a test exercises it.
- **Partial** — the real path runs, and something is missing or unverified.
- **Blocked** — cannot be completed here, with the reason stated.
- **Not started** — not attempted.

Last updated: 2026-10-19, branch `release/3.0.0`.

## 3.1 Application foundation

| Capability | Status | Evidence |
|---|---|---|
| Bootstrap, startup, graceful shutdown | Verified | `tests/integration/lifecycle.test.js`; the TURN interval that stopped the process exiting is fixed and covered |
| Environment configuration and validation | Verified | `settings.js` catalogue with 60+ entries; `dashboard.mode` refuses an unusable value at boot |
| Version metadata | Verified | `src/version.js` is the one source; the API, the instance endpoint and the health check all report it |
| Routing and deep links | Verified | 59 registry pages; `frontend/tests/renderers.test.js` asserts every page has a renderer in both modules |
| Shared API contracts | Verified | `docs/api/` (8 documents), OpenAPI 3.1 generated from the route definitions; 38 developer tests |
| Error boundaries | Verified | One envelope, `{ error: { code, message, details? } }`; the code map covers E2EE, developer and bot codes |
| Loading / empty / offline / failure states | Partial | The states exist; no browser could be driven here, so their appearance is unverified |
| Resource lifecycle | Verified | `close()` closes sockets, the database and the job system; the TURN sweep is unref'd and clearable |
| Logging, health checks | Verified | `/health`, `/ready`, `/api/health`, request ids, structured boot output |
| Configuration ownership | Verified | The admin Configuration menu is the only control surface; `dashboard.mode` is deployment-owned and read-only there |

## 3.2 Identity, accounts, authentication

| Capability | Status | Evidence |
|---|---|---|
| Registration and policy | Verified | `tests/integration/auth.test.js`; the desktop client was sending no legal versions and is fixed |
| Login, logout, session lifecycle | Verified | Same file; logout invalidates on the server |
| Email verification | Verified | `routes/auth/email.js`; the test hook is opt-in and off in production |
| Password recovery and change | Verified | The client sent `{username}` where the endpoint reads `{email}` — a silent failure, now fixed and covered |
| Session creation, expiry, revocation | Verified | `session_version` counter plus per-`jti` revocation; a revoked token is refused by the API, not only hidden |
| Device and session inventory | Verified | Registration records its session now, so the Security page can show and end it |
| Recovery codes | Verified | `totp_recovery_codes`, hashed, one-time |
| Profile, avatars, metadata | Verified | `routes/users.js`; the community icon/banner picker was discarding the file and is fixed |
| Username validation | Verified | Server-side pattern; the message names the rule |
| Account deletion and export | Verified | `routes/accountDeletion.js`, `routes/export.js`; push registrations and encryption keys are removed with the account |
| Privacy and visibility | Verified | `routes/privacy.js` |
| Abuse prevention and rate limits | Verified | Per-route limits; a shared limiter with a per-router bucket |
| OAuth / external identity | Not started | No OAuth in the repository, and the directive says only if already supported or justified. It is not, and adding it was not justified by anything in 3.0 |
| Identity boundaries between instances | Verified | A token from one instance is refused by another; a cross-instance test covers it |
| Native-client secure credential storage | Partial | The native client uses the platform keystore. The code is written; it could not be run here |
| Passkeys | Not started | Optional in the directive ("if feasible"). Not attempted; the effort was spent on the session and E2EE paths |
| Known recovery and revocation defects | Verified | Every one found is fixed and has a regression test |

## 3.3 Device identity and E2EE

| Capability | Status | Evidence |
|---|---|---|
| Cryptographic design | Verified | "TCE2E-v1": X3DH + Double Ratchet over X25519, Ed25519, HKDF-SHA256, AES-256-GCM; 54 tests |
| Per-device identity and key lifecycle | Verified | `e2ee_devices`; private halves sealed under a recovery key the server never sees |
| Device linking and verification | Verified | Safety numbers, per-device signatures over the prekey bundle |
| Conversation session establishment | Verified | `x3dh.js`; both sides derive the same secret, and a third party cannot |
| Direct-message and group encryption | Verified | `group.js`: per-device seals, an epoch per membership change |
| Eligible community/channel encryption | **Verified, with one limit** | The protocol, the API and the device lifecycle are complete; the **server** stores an envelope and never the plaintext in a conversation it reports as encrypted; the socket path refuses what the HTTP path refuses; and the **client** now encrypts, opens, renders and refuses to fall back. A conversation that is not fully encrypted is said so in words before anything goes out in the clear, and a reader who says no sends nothing. **The limit:** the key is not published automatically, so a conversation is encrypted because a reader turned it on |
| Forward secrecy and post-compromise | Verified | A DH ratchet step per direction change; the chain key is destroyed after use |
| Replay and downgrade protection | Verified | Counter monotonicity, `E2EE_REPLAY`, version refusal; no plaintext path exists |
| Device revocation | Verified | A revoked device can neither publish nor fetch |
| Key pinning | Verified | A registered device keeps the identity key it was registered with, and a change is refused. The key fingerprint is what two people compare, so a fingerprint that changed under them would mean nothing. Changing a key means revoking the device and registering it again, which is a new fingerprint |
| Encrypted attachments | Verified | The file is encrypted in the browser, its key is sealed to each member device, and the server is handed the ciphertext and the seals - which it cannot open. The server refuses a body that carries a key in the clear |
| The device store | Verified | Namespaced per instance **and per account**: the private keys of one instance are not the private keys of another, and two people sharing a browser must not present the first one's device to the second one's account |
| Encrypted backups and recovery | Verified | `e2ee_backups`, `recovery.js`; a recovered device must present a new identity |
| Key-change warnings | Partial | The server emits `e2ee:key-change`; the client half is not written |
| Multi-device synchronisation | Partial | The protocol supports it; no client uses it yet |
| Safe migration from unencrypted conversations | Not started | Deliberate: a conversation that was not encrypted cannot be made so without saying so |
| Explicit encrypted / unencrypted state | Verified | `status.js` reports `encrypted`, `not-encrypted`, `mixed`, `key-changed` per conversation |
| No plaintext fallback | Verified | No endpoint accepts a message body; the encrypt path throws rather than degrading |
| No plaintext server storage of private keys | Verified | The server stores public keys, sealed blobs and cleartext counters — nothing else |
| Independent security review | **Blocked** | No third-party cryptographic review was obtained and none is claimed. The self-review is in the E2EE workstream's report and names its own limits |
| Honest treatment of metadata | Verified | The self-review names exactly what the server sees: who has devices, who talks to whom, when, and sizes and timing |

## 3.4 Users, friends, social graph — Verified

`routes/friends.js`, `routes/users.js`, `routes/privacy.js`. Presence is a
realtime event plus `GET /api/users/presence`.

**The member list is a real roster.** Every row says whether the person is
online, idle, do not disturb or offline, and it repaints on the presence
event. The list **pages** — it asked for a hundred and showed what came, and
called that the roster — and it searches on the server rather than in the
browser. A click opens the person's sheet; a right-click opens the person
menu, with the community's moderation added when the reader holds the
permission.

## 3.5 Direct messages and messaging — Verified

`routes/dms.js`, `routes/messages.js`, `services/dms/*`. Idempotent sends by
`client_nonce`, ordered history, edits, deletions, replies, reactions, read
state, and the realtime delivery path. E2EE for eligible conversations is
**partial** — see 3.3.

**Link previews are a real card.** A picture at a readable size that opens a
lightbox, a video that fetches nothing until it is played, a link with its
site and its host, and a plain link when the preview could not be made. The
old client read `imageUrl` as `image`, so the picture never appeared at all;
the phone dropped the image and the video entirely. Both are fixed, and the
phone draws the same four cards.

**The favicon is never fetched.** A favicon request is a request to an
arbitrary host on behalf of every reader who opens the channel, so the site's
first letter stands in for it and nothing is fetched beyond the image and the
video the server already vetted.

## 3.6 Communities, channels, roles, permissions — Verified

`tests/integration/community.test.js` (19 assertions): creation, categories,
channels inside a category, rename, move, reorder, partial-reorder refusal,
deletion, the member list with paging and search, role assignment, and the
refusals for a member without the permission and for a stranger.

## 3.7 Forums, threads, discussion — Verified

A forum is a channel of type `forum`. Its topics are the channel's root
messages, its replies are the discussion under each, and the existing thread
route serves the conversation — **the same messages, the same thread model,
the same permissions**, not a second discussion structure.

The topic list can be ordered by the newest activity, by the oldest start or
by the number of replies, and searched. A reader's subscription to a topic is
their own record and goes with the account. 11 tests.

## 3.8 Moderation and safety — Verified

Reports, the review queue, bans, timeouts, warnings, appeals, and the audit
trail. Cross-instance reporting with explicit privacy boundaries is **partial**
— a report about activity on another instance is built and tested, and what
crosses is the reference and the reason rather than the content.

## 3.9 Community workspace — Verified

`backend/src/services/workspace/`, 40 tests. Spaces, community documents with
conflict detection, boards with version preconditions, events with time zones,
and polls with ranked scoring. A space narrows access and never widens it.

**The interface exists.** The workspace is five surfaces, each with its own
address, so a reader can link to a document and a phone can open a board. It
is in the community column, in the community menu, and it works the same on
the desktop and on the phone. A surface that had no address of its own would
be a place a reader could not link to and a phone could not open.

## 3.10 Collaborative documents and knowledge — Verified

Structured blocks, revisions, compare, restore, comments, links, and a
permission-aware search index. 35 tests.

The vocabulary is the server's, and it now carries the four types the
directive names that it did not have:

| Block | Shape |
|---|---|
| `image` | `{ src, alt, width? }` — the alt text is **required**, the source must be an http(s) URL or a path on this instance, and the width is bounded. A `javascript:` or `data:` source is refused |
| `quote` | `{ text, attribution? }` — the text is required |
| `code` | `{ text, language? }` — the text keeps its indentation, because indentation is what code means, and the language is checked against a list |
| `table` | `{ headers[], rows[][], caption? }` — at least one column and one row, a bounded number of each, and every row exactly as wide as the header |

Every one of them is escaped on the way out. A document is untrusted content,
and the renderer is the boundary.

**Reusable blocks are shared, not browser-local.** A shared block is an
instance-wide thing and writing one is an administrative act, audited; a
personal block belongs to its author. A published page holds its **content**,
not a reference to a block — so editing a block afterwards cannot silently
change a page that was already published and accepted.

Two revisions can be compared, and the comparison is a report about the
content — what was added, what was removed, what changed — rather than a
rendered diff.

## 3.11 Boards and project management — Verified

Same workstream. Cards, assignments, deadlines, priority, milestones, activity
history, and message-to-card conversion.

## 3.12 Events and collaborative sessions — Verified

Scheduling with IANA time zones, RSVPs with capacity, reminders as durable job
rows, and voice-room reservation by reference. Nothing is proxied.

## 3.13 Polls and decision tools — Verified

Idempotent voting, anonymous polls that name nobody, ranked-choice scoring with
a documented tie-break, quorum, and an immutable result snapshot.

## 3.14 Search, inbox, power-user tools — Partial

The in-house search index is verified and now covers community documents, and
the query takes filters: `from:`, `in:`, `before:`, `after:`, `has:file`,
`type:`, `is:unread`, with quoted values. The filters are applied **with** the
permission check, so a filter cannot widen what a reader may see.

Saved searches, a search history, message templates and saved collections
have a backend and are being given their client. The command palette and the
settings studio exist.

**Personal dashboards and configurable widgets are not started.** A dashboard
with invented numbers on it is worse than no dashboard, and the directive
forbids the first.

## 3.15 Files and storage — Verified

Authorised upload and download, type detection from the bytes, quotas, and
abandoned-file cleanup. The S3 driver has **never completed a live round
trip** — recorded, not claimed.

## 3.16 Notifications and presence — Verified

Durable notifications, read state, quiet hours, presence. The **push
transport does not exist**: the device registry and its API are real and
honest, and the feature is off by default, so an instance that accepts a
registration is an instance that has push switched on.

## 3.17 Voice, video, screen sharing — Verified, with the media itself unverified

Three providers, one in force at a time, each keeping its own settings so
switching one does not erase another's:

| Provider | What it is | What it needs |
| --- | --- | --- |
| **Mesh** | Trycord's own peer-to-peer path. The media travels between the participants; the server carries the signalling and the roster | Nothing. With no ICE configured the instance uses **the STUN and TURN server it already runs**, on this host, and mints the credential per session |
| **Cloudflare Realtime** | The Cloudflare SFU. It carries the media; the instance holds the authorisation | An application id and secret, and an endpoint that answers |
| **Third-party SFU** | A media server the operator runs, reached over its own API | An endpoint, and a token if the server wants one |

**A provider is not reported as working because its form was filled in.** The
console asks the other end, and the runtime refuses a session with the same
list of what is missing that the console shows — one place decides the state
and both places use it. The saved credential is never sent to the browser:
the console shows whether one is set, and offers to replace or clear it.

The mesh's own relay is not a setting that has to be turned on: with nothing
configured the instance starts the relay it already ships and hands out a
minted credential for it. A relay that does not answer stops the session
rather than letting it hang.

The in-house mesh is real: signalling, the roster, the dock, the stage
channels. **Actual media flow was not verified** — no browser could be driven
here. No recording, which the directive permits only with consent machinery
that does not exist.

`backend/tests/voice/` is 24 tests over the three providers and what they
share; `frontend/tests/voice/` is 9 over the console on the desktop and the
phone. `docs/voice.md` is the operator's reference.

## 3.18 Developer platform — Verified

37 routes under `/api/v1`, an OpenAPI 3.1 document generated from the same
definitions the server uses, 17 scopes, scoped keys with rotation and overlap,
bot applications, the versioned event envelope, and eight documents in
`docs/api/`.

## 3.19 Extensions and registry — Partial

The lifecycle, the capability grants, the audit trail and the registry are
implemented. The sandbox is a real `node:vm` boundary with a timeout and a
call budget, and its limits are documented rather than claimed away. The
registry is optional and the core works without it.

**The console exists.** One surface with four sections — what the registry
offers, what this instance has installed, the policy that decides what may be
installed at all, and the workflows that run here — because deciding what may
run, installing it and watching it run is one job. The registry may be looked
at by anybody signed in; the installed list and the policy are an
administrator's business, and the console does not offer them to anybody
else.

**The sandbox was audited and the audit found a way out of it.** The context
was handed Node's timer handle — a host object whose `constructor.constructor`
is the outer `Function` — so a trusted extension's server-side code could
build `process`, reach `require` and take the instance process. It is fixed,
and the timer callback is now called with no receiver, so neither the return
value nor `this` is a host object. The review is in
`docs/audit/SECURITY-3.0.md`.

## 3.20 Workflow automation — Partial

Triggers, conditions, actions, approvals, schedules, execution history, a dry
run, idempotency and loop prevention are implemented and tested.

**The audit found that a workflow could hand out any role in any community.**
A workflow is a thing an operator writes, and it runs with the authority of
the instance — so a workflow that added a role could add a role the owner did
not hold, in a community the owner does not manage. It is fixed: the same two
rules the interactive role screen applies are applied to the workflow's
catalogue, and the count of members, the webhook and the channel history
ask the same question.

## 3.21 Community Continuum federation — Verified, with one honest limit

Twelve event kinds cross between instances: `community.published`,
`community.updated`, `channel.published`, `channel.updated`, `message.posted`,
`message.edited`, `message.deleted`, `thread.reply`, `reaction.added`,
`reaction.removed`, `membership.joined`, `membership.left`. Each envelope is
signed with the instance's Ed25519 identity and carries the author snapshot
taken when the event was published, so a later rename on the origin does not
rewrite history.

A remote community is a **reference**, never a row in `servers` — the test
asserts that a peer which has seen a community does not list it among its own.

The relay rules are enforced in one place: a private community produces
nothing; a channel the members may not post in produces nothing; a sender who
may not post produces nothing; an untrusted or blocked peer is not a delivery
target; encrypted content is never federated; and what was not federable when
it was written is not federated later.

Verified between **two independently running instances** with separate
databases, separate keys and separate ports: the community travels, the
message travels with its author and its original timestamp, and edits,
reactions, replies, deletions and membership joins all travel. The refusals
are proved against the same two instances — private community, restricted
channel, pending peer, blocked peer, replay, duplicate, wrong key, stale
timestamp, stale sequence, removed peer. 28 tests.

**The limit, and it used to be bigger:** the relay was one-way for content
when it was first built. That is now fixed. A member of a federated community
writes in it from their own instance, and the message travels to the instance
that **owns** the community, which applies **its own** rules and decides. The
owner can take the message back, mute the member or remove them, and every
one of those decisions travels back to the instance that wrote it, so a writer
is never left wondering where their message went. The refusal carries the
reason.

**No authority leaks.** The message is not a row in the owner's message
table, the writer is in no membership or role row, and the writer holds no
account on the owner. Membership in a federated community grants exactly the
baseline role, and the owner's rule for that role is what governs what it
accepts.

**And the relay store is not readable by anybody who knows the address.** A
community of this instance is read by its members; a community of another
instance is read by the people who follow it. The addresses are not a secret
— the discovery document publishes them — so the rule has to be about the
reader, and it is checked before the list is built rather than after.

**The moderation surface exists, on the desk and on the phone.** An owner of
a community of this instance sees every message a member of that community
wrote on another instance, and every remote member of it, and can take a
message back, mute a member, remove a member or restore one. Each of the
four asks first, in words that say what it will do — including that the copy
over there goes too — and each reports what the server answered, including
the answer that the other instance was not told. A writer sees what the owner
decided about what they wrote, and why, and can edit or take it back.

The surface is offered only where the server's own answer says the account
may moderate. A reader who may moderate nothing is offered no list, no
controls and no trace; the server refuses the action anyway.

**What still does not cross:** attachments, in either direction. Reactions do
not travel back - the reaction's key is the message's owner, the message and
the user, and those differ in the return direction. A relayed message is not
in the owner's channel history - it is in the federation moderation surface,
because putting it in the history would make it look like a message written
by one of the owner's own members, which is exactly the authority leak the
protocol forbids. The owner's members are not notified in real time that a
remote member wrote; the owner sees it in the moderation surface. A removal
does not travel once the community has been closed - the same rule in both
directions, because a private community federates nothing more, not even the
removals. The owner's *answer* to a member's message does travel, because it
carries no content.

The return direction needs protocol version 1.2 on both ends. A 1.1 peer
refuses the three new kinds, so a writer there is never told what the owner
decided.

The change feed's latency is real and observable: a change is published once
it has settled, the bound is two intervals, and the lag is reported rather
than silent.

## 3.22 Admin configuration — Verified

The control plane, the catalogue, the reset control, the diagnostics, the
backups, the audit trail, and the deployment-owned settings.

**The provider registry** is what the console renders from. Every subsystem's
providers are described in one place — what they are called, which settings
they read, which secrets they need, how they are validated and how their
health is checked — and the states are the point: `disabled`, `configured`,
`active`, `degraded`, `failed`. A value that was saved and a value that is in
force are different things, and an operator has to be able to tell them apart.

The registry describes; it does not reimplement. The mail modes come from the
mail registry, and the storage drivers from the storage service. The tests
are about the two ways the old arrangement could have drifted: a setting the
catalogue names that does not exist, and a provider the console offers that
the service would refuse. Both are now failures. 12 tests.

## 3.23 User settings and customisation — Verified

The seven settings sections, and the switches now read their own state — a
switch that could be turned on but never off was one of the worst defects
found.

**The workspace arrangement is per account.** The column, the stage and the
inspector are each resizable, the widths are remembered, and the reader
chooses which regions are shown. The arrangement is keyed to the account, not
to the browser: two people on one machine each get their own, and signing in
as somebody else brings theirs. The density is a composition and not only a
class — the rail changes width and the compact setting drops the face beside
each message, because the name is already on the line above it.

The phone keeps its own arrangement, its own density and its own key. It
never inherits the desk's.

## 3.24 Theme and layout studio — Partial

The custom palette, the validation and the safety measurement are real. Theme
**packages** — a declarative, validated, versioned set of tokens — have a
backend and are being given their client: import, preview, apply, roll back.

A package that declares a schema version the build does not know is refused,
and a package cannot carry a script. The existing rule holds for an imported
theme as it does for a hand-written one: a theme that breaks the shell is
refused and the previous theme is restored.

Shareable theme packages and a registry integration are **not started**.

## 3.25 Public website — Verified

52 tests: the resolver, the link checker, the well-formedness check, the legal
content rules, the demo's honesty, and the accessibility checks. The four
cross-origin defects that made the demo unable to reach the instance are fixed
and covered.

## 3.26 Hybrid page editor — Verified

One model, two modes: blocks and source, with a faithful two-way projection,
drafts, preview through the server's own renderer, revisions with compare and
restore, conflict detection, reusable blocks, and permission awareness.

## 3.27 Legal content — Verified

Eleven documents rewritten as original prose, 53 operator placeholders that
are never invented, a visible review marker on every document that needs one,
an explicit child-safety prohibition, and the version numbers unchanged so the
acceptance recorded against them still holds.

## 3.28 Dashboard deployment — Verified

Both modes, independently tested: 43 tests. An invalid `DASHBOARD_MODE` stops
the boot; the separate service is a separate process with no database and no
job worker, and that is asserted from its loaded module list.

## 3.29 Instance discovery and onboarding — Verified

The listing, the custom address check, the per-origin session, the switch that
drops the socket and the cache, and the distinction between being listed and
being trusted.

## 3.30 Native mobile clients — **Blocked from verification**

A React Native project for both platforms: 123 files, 17 screens, the
keystore, the push registration, the deep links, the drafts, the accessibility
work. **It cannot be built or run here** — no JDK, no Gradle, no Android SDK,
no Xcode, no macOS. `native/VERIFICATION.md` states item by item what is and is
not verified. The build and runtime evidence the release gate asks for does
not exist and is not claimed.

## 3.31 Data portability and recovery — Verified

User export, community export, a verified backup and a verified restore, and
the retention job. A backup is checked, not assumed.

## 3.32 Status, diagnostics, incidents — Verified

Per-subsystem health, the status page, and the mode report at boot. There is
**no uptime history and no fabricated metric**.

The **incident timeline** is real: an operator posts an incident with a
status, a summary and a body, and the public status page shows it. Where
there is nothing recorded, the page says there is nothing — not that
everything has been working, because nobody wrote that down. There is no
uptime percentage, because nothing computes one.

## 3.33 Localisation and accessibility — Partial

The strings are in one place per module and the accessibility work is real
(focus traps, labels, roles, live regions, reduced motion, contrast, 44px
touch targets on the phone).

The **localisation architecture** has a backend: a locale the instance
answers in, versioned packs that provide it, a reader's own preference, and
a review workflow. A pack is untrusted content — it can change what a string
says and nothing else, and a pack that would break the interface is refused.
The strings themselves are still English, and the client side of the
preference and the formatting is being built. **No machine translation, no
network calls, and no AI anywhere in it.**

There is **no translation pack shipped** — a pack is a file an operator
puts there, and the instance's own English is the fallback.

## 3.34 Offline and resilience — Partial

The native client keeps drafts per conversation and per instance. There is no
server-side queued work and no offline read; the product needs a server and
does not pretend otherwise.

## 3.35 Security, privacy, compliance readiness — Partial

The review, the fixes and the regression tests are real. No compliance claim
is made anywhere.

`docs/audit/SECURITY.md` is the threat model and a surface-by-surface
review, each finding marked **verified** (exercised) or **read** (inspected
only). It found two critical defects, both now fixed:

- **The outbound guard did not exist.** `netguard.assertPublicHost` was
  imported by the link-preview and webhook services and was not exported, so
  every preview came back "unavailable" and every outgoing webhook was
  refused. The SSRF hole was closed by accident, and removing the dead call
  would have opened it.
- **A device could replace its identity key.** The key fingerprint is what two
  people compare to be sure they are talking to the same device, so a
  registered device now keeps the key it was registered with.

Three further findings are recorded and open: the client side of the key
pinning, the erasure sweep's coverage, and the reach of the review — it is a
read of the code, not an independent assessment of the running system.

## 3.40 Licensing and contributor experience — Partial

MIT is unchanged. `docs/audit/LICENSING.md` is the licence of every direct
dependency, the fonts and the artwork, and what each obliges. **Every licence
present is compatible with MIT**, and there is no copyleft anywhere in the
tree.

Two findings are fixed: the bundled font notice named only Manrope while
JetBrains Mono shipped beside it with no copyright notice, which is what the
OFL requires; and the public licences page now says where the notice is.
The brand asset pack's own licence is still open, and the published
attribution for the server's dependencies is thin — the page points at the
package manifests rather than listing them.

The contributor guide predates the 3.0 subsystems.

## 3.36 Database and persistence — Verified

99 tables, 137 declared indexes, a versioned migration ledger with records, a
newer-database refusal, a failed-migration block, a post-migration integrity
check, and a schema-portability guard that catches MySQL reserved words —
which caught **four boot-breaking defects** before they reached production.

## 3.37 Workers, jobs, process management — Verified

A durable job system with bounded workers, retries and backoff; the two
workspace reminder kinds registered; the retention and search-backfill jobs.
The suite that used to boot whole instances and start browsers is gone, and
the replacement is a few seconds.

## 3.38 API, realtime and internal communication — Verified

The endpoints and the 26 realtime events are enumerated; the client's
vocabulary is compared against the server's own file by a test, so a spelling
mismatch fails.

## 3.39 Versioning and release management — Verified

3.0.0 in one place; the dependency, protocol and schema versions stay their
own.

## 3.40 Licensing and contributor experience — Partial

MIT is unchanged. The dependency licences were not audited line by line, and
the contributor guide predates the 3.0 subsystems. **Not started**: the
dependency licence audit.

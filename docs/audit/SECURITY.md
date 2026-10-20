# Security audit

The threat model, and a review of the controls that answer it.

Every control below is marked with how it was checked:

- **Verified** — the behaviour was exercised by running code: a test in
  `backend/tests/`, a script, or a command whose output is quoted here.
- **Read** — the control was read in the source and its reasoning followed,
  but its behaviour was not exercised in this audit.

That distinction is the point of the document. A control that was only read
is a control that might not do what its comment says, and the first finding
below is exactly that.

The review covers: authentication, sessions and device identity,
authorisation, end-to-end encryption, federation, user-generated content,
file uploads, extensions and bots, the administrative control plane,
instance discovery, custom backend addresses, the native clients, database
and backup access, the public website and the page editor, and the
deployment's secrets.

---

## 1. The threat model

### The assets

| Asset | Why it matters |
|---|---|
| The signing secret (`JWT_SECRET` / `instance/secret.key`) | Forges any session, and decrypts every stored secret. |
| The database | Holds every message, every session, every moderation decision, and the credentials of the mail and storage providers. |
| A reader's session token | A reader's identity. |
| A reader's private key material | The one thing the server is not supposed to be able to read. |
| An instance operator's authority | Can read every account, moderate every community, and read the database. |
| A community's authority | Can read and write its members' data, and install things that run on the instance. |
| The instance's network position | A server that can be made to fetch an address it should not reach is a server inside the operator's network. |

### The actors

| Actor | What they want |
|---|---|
| An unauthenticated caller | An account, or an answer they should not have. |
| A reader | Another reader's messages, another account, a role they were not granted. |
| A community administrator | Authority over communities they do not own. |
| A malicious member | The same, plus the ability to make the instance fetch, store or render something. |
| A hostile peer instance | Content from a private community, an identity it does not own, a way into the operator's network. |
| An extension author | Code on the instance, or the ability to reach the database. |
| A bot application | The same, with a token. |
| An operator of the public site | A page that runs code in a visitor's browser. |

### The trust boundaries

1. **The public edge.** The website, the discovery feeds and the health
   endpoints are reachable without a session.
2. **The session boundary.** A bearer token, a websocket ticket, a bot token,
   an API key. Everything past it is scoped to an identity.
3. **The community boundary.** Membership, roles and channel overrides.
4. **The operator boundary.** The `admins` table, the configuration centre,
   the database and backup tools.
5. **The network boundary.** Every address this instance fetches on somebody
   else's behalf: link previews, webhooks, discovery directories, federation
   peers, extension registries.
6. **The storage boundary.** The upload tree and the object store.
7. **The browser boundary.** What the client's own JavaScript is allowed to
   do, and what the policy forbids.

---

## 2. Findings

### S1 — the guard that stops a webhook or a link preview reaching into the operator's network does not exist

**Severity: high. Two features do not work, and the control that is supposed to protect the network is absent.**

`backend/src/services/webhooks.js:15` and `backend/src/services/embeds.js:16`
both import a function called `assertPublicHost` from `./netguard`:

```js
const { isPrivateAddress, assertPublicHost } = require('./netguard');   // embeds.js:16
const { assertPublicHost } = require('./netguard');                      // webhooks.js:15
```

`backend/src/services/netguard.js` does not define that function and does not
export it. Its export list is `forbiddenHost`, `validateOrigin`,
`resolvesToPrivate`, `fetchJson`, `isPrivateIpv4`, `isPrivateIpv6`
(`netguard.js:221-228`).

**Verified by running:**

```
$ node -e "console.log(typeof require('./src/services/netguard').assertPublicHost)"
undefined
```

What that does:

- `webhooks.js:48` — the check is inside a `try { … } catch { bad('webhook url must be a public address') }`,
  so the `TypeError` is caught and **every outgoing webhook creation is
  refused**, with a message that says the address is private when the
  address was fine. The delivery path (`webhooks.js:177`) throws the same
  way, so a webhook that somehow existed would never be delivered.
- `embeds.js:49` — the fetch throws before it starts, so **link previews
  never appear**. `embeds.js:65`, `:187` and `:219` fail the same way. The
  embed service records the failure as "unavailable", so it degrades
  quietly: an instance with link previews turned on shows none, and nothing
  says why.

The SSRF hole is closed today, but by accident. The guard throws before it
can be bypassed. The obvious repair for the broken feature — "the preview
does not work, so let me take that call out" — opens a hole that lets any
member of any community make this instance fetch an arbitrary address,
including `169.254.169.254` and anything on the operator's LAN, and read
the answer back through the embed row.

The function that is missing is a thin wrapper over what `netguard.js`
already has: `forbiddenHost(hostname, { allowLocalhost: false })` for the
name, and `await resolvesToPrivate(hostname, { allowLocalhost: false })`
for the address the name resolves to. `resolvesToPrivate` is the half that
matters: a hostname that resolves to `127.0.0.1` is the classic way past a
hostname check, and `netguard.js` already implements the DNS answer check
for exactly that reason.

### S2 — an existing encryption device may replace its own identity key

**Severity: medium. It is a property of the design that the clients have to
compensate for, and the shipped web client does not.**

`backend/src/services/e2ee/devices.js:44-69` registers a device. When the
device id already exists, the only check is that it belongs to the same
account (`:54-56`), and then the row is updated with a new identity key, a
new DH key, a new signed prekey and a new signature:

```js
`UPDATE e2ee_devices
    SET label = ?, identity_key = ?, identity_dh_key = ?, signed_pre_key = ?,
        key_fingerprint = ?, signature = ?, wrapped_private_key = ?, …
  WHERE id = ?`
```

The device id is chosen by the client (`input.id || uuid()`), and the
account holder may re-register a device id they own. So a device can change
the key that its peers are supposed to trust, and the server records the
change without refusing it.

The `key_fingerprint` and `signature` columns exist so a change is
*visible*, and the native client fetches the fingerprint
(`native/app/src/e2ee/api.ts:80`). But a client that pins a peer's key and
refuses a change is the only thing that actually prevents a hostile server
from substituting an identity, and there is no such check in the shipped
clients: the native client reads the fingerprint and the web client does not
implement encryption at all (no file under `frontend/` mentions `e2ee`).

**Read, not verified.** No test in the tree exercises a key replacement, and
the clients' pinning behaviour was not exercised in this audit.

The fix belongs in two places: the server should refuse a key change for an
existing device id and require a new device id instead (a rekey is a new
device), and the clients should pin the fingerprint they first saw and
refuse a change they did not make.

### S3 — the account erasure leaves the reader's own rows in the database

**Severity: medium, and it is the defect this work's own erasure sweep
answers.**

The erasure workflow (`backend/src/services/accountDeletion.js:162`) does
not delete the account row: it anonymises it — a tombstone username, no
email, a password hash that can never match — so that messages, moderation
actions and audit rows keep pointing at an author. That is a deliberate and
defensible design, and it is documented at length in that file.

The consequence for per-reader data is that a table with
`FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE` keeps its
rows: the cascade is on **delete**, and the erasure **updates**. The rows
survive an erasure, pointing at an account nobody can sign in to.

The erasure does delete the reader's other rows by hand — friendships,
notifications, muted channels, reactions, profile media, push devices, the
encryption keys — with one `DELETE` per table. Anything added to the schema
after that list was written is not in it.

This work adds the missing half: `backend/src/services/reader-data.js` is a
sweep that takes a reader's own rows away once the erasure has been
processed, and it runs as a background job that queues the next pass, so it
survives a restart. The tables it empties are
`message_templates`, `saved_collections`, `saved_searches`, `search_history`,
`channel_read_cursors` and `reader_locale_settings`.

**Verified by running** — `backend/tests/personal/personal.test.js` runs the
real erasure workflow (`requestDeletion` → `reviewRequest` →
`beginProcessing` → `eraseAccount`), then the sweep, and asserts that the
template and the collection are gone.

The remaining gap is that the sweep is a background job rather than part of
the erasure itself: `services/accountDeletion.js` is outside the ownership
of this change, and the honest fix is one line in `eraseAccount` —
`await require('./reader-data').purgeReaderData(userId)` — after the
anonymisation. Until that line exists, a reader's rows live for up to an
hour after the erasure instead of not at all.

### S4 — the rate limiter is per process

**Severity: low. It matters for a multi-process deployment.**

`backend/src/middleware/ratelimit.js` keeps its buckets in a `Map` in the
process's memory, keyed by router, user and address. The file says so
("Single-process only: each server instance tracks its own callers"). A
deployment running three API processes therefore has three times the limit
it believes it has, and the login throttle
(`security.loginRateLimit`) is three times weaker than the operator set.

The middleware's signature is already the shape a shared store would take,
so the fix is a store, not an interface change.

**Read.**

### S5 — the account lockout and the password policy are read from the wrong place

**Severity: low.** `settings.get('security.loginRateLimit')` is declared and
is read per request by the authentication path, so the ceiling on login
attempts is the one the operator set. The per-account lockout
(`users.login_fail_count`, `users.login_locked_until`) is a separate
mechanism with a separate lifetime, and the two are not reconciled anywhere:
an operator who sets the ceiling to 3 has both a three-per-minute ceiling
and a per-account lockout, and the effective limit is whichever is reached
first.

**Read.**

### S6 — the CSP allows inline scripts on any path containing "showcase"

**Severity: low, and currently inert.** `backend/src/server.js:371` builds
the policy with `allowInlineScripts` true when `req.path` contains
"showcase". The comment at `server.js:290` calls it "the static showcase
gallery, dev-only". No route in this checkout matches a path containing
"showcase", so the branch does not fire — but it is decided by a substring
match on the request path rather than by a route table, so any future route
whose path contains that word silently gets inline scripts, and any
deployment that mounts a page under such a path inherits it.

**Read.**

### S7 — the extension sandbox is not a jail, and says so

**Severity: low, and it is disclosed.** `backend/src/services/extensions/sandbox.js`
runs trusted extension code in a `node:vm` context inside a worker thread
with a memory ceiling, a deadline and a call budget. The module's own
comment says: "Node does not provide a security boundary between a vm
context and its host, and a determined attacker may find a route this
implementation has not closed."

That is the right thing to say, and the mitigation is structural: server-side
code is off by default, it needs an operator to allow it, it is trusted
code, and the declarative path exists so most extensions never need it.

**Read.**

### S8 — the native client will send a bearer token over plain HTTP if the reader asks it to

**Severity: low, and it is a deliberate choice.**
`native/app/src/session/instance.ts:32` accepts an `http://` instance
address. The client is careful about the rest — a bare hostname is refused,
so a token is never sent to a host the reader did not name, and the session
is filed under the instance's origin so a token for one instance is never
presented to another — but a reader who types `http://192.168.1.10:9971`
gets their token over the LAN in the clear.

**Read.**

---

## 3. The surfaces

### Authentication

| | |
|---|---|
| **Surface** | Registration, sign-in, sign-out, password reset, e-mail verification, two-factor, account recovery. |
| **Attack surface** | Credential stuffing, password spraying, account enumeration, token forgery, reset-link theft, second-factor bypass. |
| **Controls** | `bcrypt` for passwords (`BCRYPT_COST`, default 10). A per-account lockout (`login_fail_count`, `login_locked_until`). A per-address rate limit on the login path (`security.loginRateLimit`, default 30/minute, with `RATE_LIMIT_MAX` able to raise every ceiling). Tokens are HS256 JWTs, verified with an explicit algorithm allowlist (`backend/src/middleware/auth.js`: `jwt.verify(token, secret(), { algorithms: ['HS256'] })`), so an `alg: none` or mismatched-algorithm token is refused rather than treated as a signature to check. A token is checked against the revocation table, the password-change marker, the session-invalidation marker and the session version in **one** query. Approval can be required for new accounts. Two-factor can be required, with the platform administrators exempt so the requirement cannot lock out the people who turn it on. |
| **Verified or read** | The token algorithm allowlist, the single-query session check and the markers are **read**. The lockout, the rate limit and the two-factor requirement are **read**. The password hashing and the reset flow are **read**. |

### Sessions and device identity

| | |
|---|---|
| **Surface** | JWT sessions, the session table, the websocket ticket, encryption devices. |
| **Attack surface** | Session fixation, session theft, replay, a token accepted after a password change, a token leaking through a URL or a log. |
| **Controls** | A session is identified by a `jti` and recorded, so one session can be revoked without ending the others. `sessions_invalidated_at` ends every session at once, and `session_version` makes the ending exact even for a token minted in the same second. The websocket never carries the JWT in its URL: the client exchanges it for a 60-second single-use ticket (`backend/src/ws.js:11-15`), and the ticket's claims are re-validated against revocation and the session version mid-session, so a revoke does not wait for a reconnect. The encryption device is a row with its own identity key, a fingerprint and a signature. |
| **Verified or read** | **Read.** The one exception is S2, where a device may replace its identity key. |

### Authorisation

| | |
|---|---|
| **Surface** | Every community, channel and category: who may read, write, moderate. |
| **Attack surface** | Broken object-level authorisation — reading or writing another community's data by guessing an id. |
| **Controls** | One permission registry (`backend/src/services/permissions.js`) with server-side evaluation; the owner holds every permission; the community-level, category-level and channel-level overrides resolve in a stated order and an explicit deny always beats an allow. Membership is checked on the path, not in the client: `visibleChannel()` returns null for a channel in a community the reader is not in, and the routes answer "not found or not a member" rather than revealing the row. The moderation surfaces are behind `adminGuard`, which reads the `admins` table and answers a fixed generic message so the gate is not an admin-name oracle. |
| **Verified or read** | **Verified** for the surfaces this work added: the search filters (`backend/tests/search/`), the collections and templates (`backend/tests/personal/`), the community packs and themes (`backend/tests/localisation/`, `backend/tests/themes/`). Each test asserts that a reader outside the scope gets nothing rather than everything. **Read** for the rest. |

### End-to-end encryption

| | |
|---|---|
| **Surface** | Direct messages, the device registry, the prekeys, the ratchet, the sealed attachments, the key backup. |
| **Attack surface** | A server that reads what it should not; a substituted identity key; a replayed envelope; a stolen sealed key. |
| **Controls** | The server holds public keys, sealed key material and counters — not plaintext. The envelope's signature binds the ephemeral key, the identity key and the signed prekey. Prekeys are consumed exactly once, and the counters are kept in the clear so a replay can be refused. The relay rules refuse encrypted content outright: encrypted conversations are not federated at all, because relaying ciphertext puts a blob nobody can use into a conversation that looks readable. |
| **Verified or read** | **Read.** S2 is the finding: the server permits a key change, and no shipped client pins a fingerprint against it. The web client does not implement encryption at all, so a web reader's direct messages are not encrypted — the server supports envelopes, and only the native client produces them. |

### Federation

| | |
|---|---|
| **Surface** | The peer registry, the outbox, the delivery log, the inbox, the relay rules. |
| **Attack surface** | A hostile peer forging an event, replaying one, or using the relay to reach into the operator's network; a private community federating by accident. |
| **Controls** | Every event is signed with an Ed25519 key, and the receiver verifies the signature against the key recorded for that peer before it reads the content. Only a trusted peer may send, and an unknown peer is refused before the signature is even checked. The inbox deduplicates by event id, the per-actor sequence number refuses a replay, and a timestamp more than an hour from now is refused. The relay rules (`backend/src/services/continuum/rules.js`) ask three questions of everything that would leave the instance: is the community public, may the community's members post in this channel, and could this author post there. Encrypted content is refused. |
| **Verified or read** | **Verified** that this work's cross-instance reports ask the same rules rather than a second set (`backend/tests/reports/`). **Read** for the relay itself. |

### User-generated content

| | |
|---|---|
| **Surface** | Messages, community names, topics, profile text, page bodies, embeds. |
| **Attack surface** | Stored XSS in a reader's browser, in another reader's browser, or in an administrator's console. |
| **Controls** | The client builds DOM with `textContent` for text and never assigns user content to `innerHTML`; the one `innerHTML` in the DOM helper (`frontend/packages/dom.js:95`) takes an explicit `html` property, and nothing in the tree passes user content to it. The BBCode parser (`backend/src/services/bbcode.js`) is a tokeniser, not a set of regular expressions, and its own header lists the safety rules: no tag can carry an attribute, `[url]` goes through a scheme allowlist, `[color]` takes a named colour or a hex, `[size]` is an integer mapped to a class, and `[code]` contents are escaped and not parsed. The content security policy is built from configured origins and never from request input, and the comment at `backend/src/server.js:362` names the attack it prevents — a query parameter must not be able to add an origin to `connect-src`, or an attacker link could be granted the exact allowance it needs to receive the reader's bearer-carrying requests. `X-Frame-Options: DENY`, `nosniff`, `frame-ancestors 'none'` and `object-src 'none'` are set on every response. |
| **Verified or read** | **Read**, except for the surfaces this work added, where the validation is **verified** by test: a localisation pack may not contain markup or a script address, and a theme package may not carry a field that is not a value. |

### File uploads

| | |
|---|---|
| **Surface** | Message attachments, direct-message attachments, avatars, community icons. |
| **Attack surface** | A file that is served as something it is not, a filename that escapes the upload tree, a file big enough to exhaust the host, a file that reaches the disk as executable content. |
| **Controls** | The multipart parser is built per request against the live size limit, so it stops at the limit that applies rather than buffering a fixed 100 MB. The allowed types are checked against the bytes' detected type, never against what the client claims (`content.allowedUploadTypes` says so in as many words). Object keys are built from validated ids (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`), and the local driver additionally resolves the key and refuses a path outside the storage root, so a bug in key construction still cannot read or write outside the tree. Attachments are never mounted as a public static directory: every read goes through the authenticated route. |
| **Verified or read** | **Read.** |

### Extensions and bots

| | |
|---|---|
| **Surface** | The extension registry, the installed extensions, the workflow engine, the bot applications, their tokens and their commands. |
| **Attack surface** | Third-party code running with more authority than it was granted; a bot token usable against another application; a workflow reaching the database. |
| **Controls** | An extension is declarative by default — triggers and actions with no code in them — and that is the real isolation. Server-side code is off unless an operator allows it, and it is explicitly trusted code (S7). A bot's token is stored as a SHA-256 hash and compared with `timingSafeEqual`; the API key is hashed the same way. A bot application is scoped to one community, and the community's own permission checks apply to what it posts. |
| **Verified or read** | **Read.** |

### The administrative control plane

| | |
|---|---|
| **Surface** | `/api/admin/*`, `/api/admin/pages`, `/api/admin/settings`, `/api/admin/database`, the dashboard. |
| **Attack surface** | A reader reaching an administrative action; an operator's browser executing something an attacker wrote; the database tools doing something irreversible. |
| **Controls** | `adminGuard` on every administrative router, reading the `admins` table and answering a fixed message. The database router is behind the same guard and behind its own rate limits. The dashboard is served by the same process by default, and the separate mode is an operator's choice. The configuration centre keeps secrets out of the catalogue: a secret's value is never returned, a blank write leaves it alone, and clearing one is explicit. |
| **Verified or read** | **Read.** |

### Instance discovery

| | |
|---|---|
| **Surface** | The public discovery feed, the instance directory, the well-known document, the directories the operator configures. |
| **Attack surface** | Using the discovery reader to fetch an address inside the operator's network; publishing an instance that should not be published. |
| **Controls** | `netguard.fetchJson` is used for every configured directory, and `validateOrigin` refuses a private, loopback, link-local or metadata address, refuses embedded credentials and refuses a scheme that is not http(s). An instance is only listed when `instance.discoverable` is on, and a community only when it opted in (`content.discovery`). |
| **Verified or read** | **Read.** |

### Custom backend addresses

| | |
|---|---|
| **Surface** | `backend.json`, the client's settings screen, the desktop app's API picker. |
| **Attack surface** | A reader's bearer token being sent to an attacker's server; a query parameter choosing the API origin. |
| **Controls** | The client asks the operator-configured origin, and the CSP's `connect-src` is built from configured origins only — never from a request parameter, which the code names explicitly. The native client refuses a bare hostname, so the reader has to name a full address, and it files the session under that origin so a token for one instance is never presented to another. |
| **Verified or read** | **Read.** |

### The native clients

| | |
|---|---|
| **Surface** | The iOS and Android applications. |
| **Attack surface** | A token in the wrong keystore entry, a token sent in the clear, a deep link that opens something it should not. |
| **Controls** | The token is in the platform keystore (`react-native-keychain`), keyed by the instance origin. The instance address must be a full http(s) URL. The deep-link parser is a separate module with its own tests. |
| **Verified or read** | **Read** (S8 is the finding). |

### Database and backup access

| | |
|---|---|
| **Surface** | The configuration centre's database page, the backup and restore tools, the dump scripts. |
| **Attack surface** | A database credential leaving the instance; a restore from an untrusted dump; a command injection through a database name or a file path. |
| **Controls** | Every one of those routes is behind `adminGuard`. There is no `child_process` anywhere in the server: the backup is written in JavaScript, so there is no shell to inject into. The database configuration is masked when it is reported (`db.config.mask`), and the live configuration is only exposed to server-side callers. The instance's database directory is created 0700 and the generated signing secret 0600. |
| **Verified or read** | **Read.** The absence of `child_process` was checked by search across `backend/src`. |

### The public website and the page editor

| | |
|---|---|
| **Surface** | The static site, the operator's editable pages, the status page, the community pages. |
| **Attack surface** | A page body that runs code in a visitor's browser; a visitor's content injected into the page; a hostile link on the site. |
| **Controls** | The page body is BBCode, and the parser emits every tag itself from validated values (see user-generated content above). The public site's own JavaScript writes text with `textContent`. The site loads nothing from a third party: no CDN, no remote font, no remote script. The status page reads what the instance recorded and shows nothing else. |
| **Verified or read** | **Read.** |

### Deployment secrets

| | |
|---|---|
| **Surface** | `.env`, the signing secret, the stored credentials, the instance directory. |
| **Attack surface** | A secret in a log, in a response, in a backup, or in the repository. |
| **Controls** | The signing secret comes from the environment, or from `instance/secret.key`, which is created 0600 inside a 0700 directory with an exclusive create so two processes cannot disagree about it. The stored credentials are encrypted under a key derived from that secret and are never returned by the catalogue — only their presence is reported. The public instance metadata is explicitly "never secrets, paths, or credentials". The health endpoints return a boolean and the instance id. |
| **Verified or read** | **Read.** The secret's file mode and the encryption of stored credentials were checked by reading `backend/src/clock.js` and `backend/src/services/secrets.js`. |

---

## 4. What is verified by running, in one place

| What | How |
|---|---|
| The missing `assertPublicHost` (S1) | `node -e "…"` against the installed module; the output is quoted above. |
| The erasure sweep (S3) | `backend/tests/personal/personal.test.js` runs the real erasure workflow and the sweep. |
| The permission scoping of the search filters | `backend/tests/search/` — a reader outside the community gets nothing from a filtered search. |
| The permission scoping of the collections and templates | `backend/tests/personal/` — a private collection is invisible to a member of the community; a shared one is invisible outside it. |
| The pack and theme validation | `backend/tests/localisation/`, `backend/tests/themes/` — a pack with markup, a pack with a changed placeholder, a pack with an unknown format version, a theme with a script, and a theme with an unknown schema version are each refused. |
| The federation rules applied to a cross-instance report | `backend/tests/reports/` — a report about a private community is refused, and the payload carries the identifier and the reason and not the content. |
| The CSP being built from configuration only | Read at `backend/src/server.js:325-371`. |

## 5. Summary

| | |
|---|---|
| **Highest-severity finding** | **S1** — `assertPublicHost` does not exist (`backend/src/services/netguard.js`), so the SSRF guard for link previews and outgoing webhooks is absent. Two features do not work; the network is protected by an accident rather than by a control. |
| **Second** | **S3** — the account erasure leaves a reader's own rows behind; this work adds the sweep, and the one-line call in `eraseAccount` is the remaining gap. |
| **Third** | **S2** — an encryption device may replace its identity key, and no shipped client pins a fingerprint against it. |
| **The parts that hold up** | The authentication path (an explicit algorithm allowlist, one round trip for the whole session check, a websocket ticket instead of a token in a URL), the authorisation model (one registry, server-side evaluation, membership checked on the path), the content security policy (built from configuration only, with the parameter-injection attack named in the code), the storage keys (validated ids plus a resolved-path check), the extension sandbox (honest about what it is), and the relay rules (one place, asked by everything that would leave the instance). |

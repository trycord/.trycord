# V2 state

What this document is: a record of the current architecture and of the problems
found and fixed while working on it. It is not a plan.

Anything listed under **Still open** is a real, known gap. Anything not listed
there is either implemented or was never broken. Where a fix was subtle enough
that the obvious implementation would reintroduce the bug, the reason is
recorded next to it, because the code alone does not say it.

Last full verification: 27/27 suites, 38 tables.

## Architecture

```
Trycord
├── trycord-server    authoritative backend: API, WebSocket, auth, storage
├── trycord-client    WAC, the web client
├── trycord-desktop   DAC, an Electron shell that bundles the same client
└── public            the public site, separate from the authenticated app
```

The server is the only authoritative backend. The WAC and the DAC are two
packagings of one client; the DAC has no client logic of its own. The public
site is a separate static tree served by the same process on different routes,
and is never merged into the app shell.

Cloudflare deployment is isolated in its own repository,
[trycord/.trycord-cloudflare](https://github.com/trycord/.trycord-cloudflare).
It fetches this repository at a pinned ref and builds `dist/` from it, so there
is no deployment-specific code, configuration or assumptions in the product
repository. Self-hosting requires no Cloudflare account, Workers, R2, Tunnel or
Access.

## Public identifiers

All primary keys are UUIDs generated in the application. No table uses an
auto-increment primary key, so no internal sequence is exposed in a URL, an API
response or a log line.

Human-readable routes are separate from identifiers and are additive:

| Entity | Identifier | Readable form |
|---|---|---|
| User | UUID | username |
| Community | UUID | `slug`, unique globally |
| Channel | UUID | `slug`, unique within its community |

`GET /api/servers/:token` and every other server-scoped route accept either
form. A rename re-slugs and releases the old value rather than retaining it as an
alias, and the UUID route keeps working, so a shared link degrades to the
identifier form instead of 404ing. Message endpoints are mounted without a
community in the path and therefore accept identifiers only; that is deliberate,
because a channel slug is unique per community and resolving one without that
context would be a guess.

Reserved words are escaped, so a community named `settings` cannot take the URL
the settings page owns.

## Security decisions worth knowing

These are the places where the obvious implementation reintroduces the bug.

**Session invalidation is a counter, not a timestamp.** `sign()` stamps `sv`
from `users.session_version`, and the auth middleware compares it on every
request. JWT `iat` has one-second resolution, so a token issued in the same
second as a password change or a 2FA enable is otherwise indistinguishable from
one issued after it and the invalidation silently does nothing. Every path that
ends a session - password change, password reset, revoke-all, revoke-others, 2FA
enable and disable - goes through one helper that bumps the version and returns
it, because a token signed with the previous version is rejected on its next
request. That presents as a successful call followed by a mysterious sign-out.

**A community timeout gates every write, not just posting.** The client hides
the composer as a courtesy, so the server cannot rely on it. Editing, deleting,
reacting and uploading each check `timeout_expires_at`. Moderators holding
`MANAGE_MESSAGES` are exempt, so moderation is not collateral damage.

**The TOTP secret is encrypted at rest, not hashed.** Verification needs the
original secret, so bcrypt does not apply; a plaintext column would make a
database backup a 2FA bypass for every account in it. AES-256-GCM under a key
derived from `JWT_SECRET`, so tampering is detected rather than silently
producing wrong codes.

**A channel slug is never resolved without its community.** Two communities may
each have a `#general`, so a bare channel slug is ambiguous and resolving one
alone could land on somebody else's channel.

**Deletion anonymises rather than cascades.** Message history and moderation
evidence stay coherent, and `audit_logs` deliberately keeps its foreign key:
erasing the actor would destroy the record of who did what.

**Client modules are parsed as modules.** `node --check some.js` reports success
for a `.js` file containing `import` statements, even with a duplicate
declaration in the body. A duplicate `const serverId` shipped to `main` through
it, in `44e1ba8`, and the app would not start. `check-client-modules.js` parses
each module as a module and resolves its imports; CI runs it.

## Storage

Provider-neutral, chosen by `STORAGE_DRIVER`:

| Driver | Notes |
|---|---|
| `local` | default, files under `UPLOAD_DIR`, no dependencies |
| `s3` | any S3-compatible endpoint: Amazon S3, Cloudflare R2, MinIO, Backblaze B2, SeaweedFS |

Object keys are generated from validated ids and never from a user-supplied
filename, so no input can influence a key. Attachments are scoped by channel
rather than message, because an upload happens before the message exists and
re-keying on attach would lose the object if the attach failed.

Uploads are bounded three ways: `MAX_SIZE` per file, a route rate limit, and a
per-account total quota (`STORAGE_QUOTA_MB`, default 512 MB). The first two bound
a single request, not the total.

The S3 signer is pinned against the AWS `aws-sig-v4-test-suite` vectors. The unit
tests cannot prove a real server accepts a signature - a signer that is wrong in
the same way the test is wrong still verifies against itself - so the vectors
decide whether the algorithm is correct, and only a live endpoint can say
whether the credentials are. Those vectors were removed along with the rest of
the suite, so nothing now pins the signer and the remaining open item is
verified by hand.

SeaweedFS topology, for reference: the S3 gateway listens on **8333**. Port
**18333 is the gRPC master port** and answers with `content-type:
application/grpc`; an HTTP client pointed at it sees raw HTTP/2 frames and a
connection error.

## Tests

There is no automated test suite in this repository. Two checks remain and both
run in CI:

| Check | What it covers |
|---|---|
| `npm run check` | applies the schema to a throwaway SQLite database |
| `scripts/check-client-modules.js` | parses every web-client file as an ES module and resolves its relative imports |

The second exists because `node --check` on a `.js` client file reports success
for a file containing `import` statements even when the body has a duplicate
declaration. A duplicate `const serverId` reached `main` through it, in
`44e1ba8`, and the app would not start. It is a syntax gate, not a test suite.

A live S3 round trip has also never completed. The signer was pinned against
the AWS `aws-sig-v4-test-suite` vectors at the time, which proved the algorithm
correct and left the failure attributable to the endpoint or its credentials
rather than to the implementation. That check is no longer in the repository.

## Still open

Real, known gaps. None blocks ordinary use.

- **The S3 driver has never completed a live round trip.** The signer is proven
  correct against AWS's vectors. The endpoint returns `SignatureDoesNotMatch`,
  which is ambiguous between that and credentials the server does not recognise;
  a key known to work against the target would settle it in one run.
- **Any file may be attached, and anything unrecognised is sent as a download.**
  There is no longer a list of accepted types. Size (8 MB), a per-account quota,
  a per-route rate limit, a per-message count (10) and filename cleaning are all
  still enforced; nothing is refused for what it is.

  The type is detected from the bytes rather than trusted - magic bytes for the
  binary formats, and a strict no-NUL / no-stray-C0 / valid-UTF-8 check for the
  four text types - and the detected type is stored in preference to the declared
  one, so a GIF named `photo.png` is stored and served as a GIF. A file that
  matches nothing is stored as `application/octet-stream`.

  What makes accepting every extension safe is the serving side, not the
  accepting side. A recognised image, PDF or text file is served `inline` with
  its real type; **everything else is served as `application/octet-stream` with
  `Content-Disposition: attachment`**, so an `.html` or `.svg` attachment is a
  download rather than script running on the app's origin with the reader's
  session. `X-Content-Type-Options: nosniff` is set on all of them. The
  practical consequence is that an SVG cannot be previewed inline - it downloads.

  Identity media is a separate feature with a real constraint and stays
  images-only: an avatar or community banner that is not PNG, JPEG, GIF or WebP
  is refused.
- **Email verification and password reset need a working SMTP transport.** The
  flows are implemented and rate limited, and the token handling is tested
  directly, but no end-to-end mail delivery is exercised in CI.
- **Full-text search is prefix-based.** There is no index and no ranking, so
  search quality degrades as history grows.
- **`docs/selfhosting.md` is a deployment narrative, not a variable reference.**
  `.env.example` now names every variable the server reads - checked by
  comparing `process.env.X` against the file: 41 read, 41 present - but it stays
  grouped by concern rather than exhaustively commented one by one, so the full
  semantics of the rarer tuning values live in the source beside the code that
  applies them.

## Changed since this was first written

- **Per-device sessions.** Every device the account is signed in on is listed
  with its own revoke, and a revoked device is told over its own socket rather
  than at its next request.
- **Account data export.** `GET /api/me/export` returns the caller's own rows
  in fifteen sections, with `?format=ndjson` for a large enough payload to be
  awkward as one document. A section that fails does not fail the export, and no
  secret is in the query list.
- **Attachments in direct messages.** `attachments.channel_id` was `NOT NULL`
  with a foreign key to `channels`, so a file in a DM was an unrepresentable
  row. It is nullable now and the row carries a conversation instead. On MySQL
  that is an instant `MODIFY`; SQLite cannot alter nullability and takes a
  table rebuild, which runs only when the column is actually still `NOT NULL`.
- **Attachment progress, cancel and retry, drop and paste, and a lightbox.**
  The tray is one module used by both composers. Uploading a file with no text
  was refused by the composer even though the server has always allowed it, and
  filenames were stored doubled (`photo.png.png`).
- **Replies.** Flat threads in channels and in direct messages, one nullable
  indexed column per message table, described once in `services/threads`. A
  reply notifies the author of the message it hangs from. Deleting a message
  clears the link on its replies rather than orphaning them.
- **The member panel took a third of a phone screen.** The `max-width: 599px`
  breakpoint was the only one that never zeroed `--ui-members`, and the panel's
  mobile hide rule had been attached to the public-page selector chain, so it
  never applied on a channel at all.

## Four additions: embeds, analytics, webhooks, bots

Requested after the A-Z pass. Each is a full stack, not a panel.

**Link previews.** A URL in a message gets a small card, in channels and in
direct messages alike. The fetch is the whole
risk, so it lives in one place (`services/embeds`) and obeys a fixed shape:
HTTP and HTTPS only, no credentials in the URL, a 4s timeout, a 512KB cap, no
redirect to a private address, and DNS resolved once and checked so a name
pointing at 127.0.0.1 cannot be used to read the instance's own network. A
preview is resolved after the broadcast and pushed over the socket, so the
message appears immediately and the card arrives when it is ready; history
carries the same cards, which is what a reload reads. A link that could not be
fetched still shows a card, marked unavailable - silence is indistinguishable
from a typo. The renderer is one module used by every message surface.

Previews in direct messages needed the same schema decision attachments already
made: `message_embeds.message_id` is nullable and carries the conversation and
`dm_message_id` beside it, because a direct message is a row in `dm_messages` and
a `NOT NULL` foreign key to `messages` would make the row unrepresentable. The
maintenance backfill that fills in previews for older messages deliberately skips
direct messages - they are private, and a timer should not go reading them.

**Analytics.** Counted from the rows that already exist rather than from a
counter table, because a rollup has to be backfilled and disagrees with the
messages it summarises the moment one is edited or deleted. Totals, a
zero-filled daily series, message volume, channel and member rankings, and
posting streaks, all scoped to one community and a bounded window (7/30/90
days, clamped server-side).

Member churn needed a new table to be answerable at all: a member who leaves
has no `server_members` row, and the audit log records moderator actions rather
than someone clicking leave. `server_membership_events` is append-only and
written as the departure happens. **Consequence: churn figures cover activity
from the migration onward. History before it is not reconstructable and is not
invented** - the analytics page reports zero left for a community whose departures
predate it.

**Webhooks.** HTTPS only, private addresses refused, secret stored hashed and
shown exactly once at creation and on rotate. Deliveries are HMAC-SHA256 signed
over the exact body (`x-trycord-signature`) and recorded, with the delivery log
readable in the UI. Nine event types. The address is re-checked immediately
before each request, not only when the webhook was saved, because a name that
was public then can resolve to a private address now.

**Applications and slash commands.** Created by a community administrator, get a
bearer token shown once and stored hashed, and post through the ordinary message
pipeline under the application's owner - the same permission check, the same
broadcast, the same attachment adoption. There is no second way to write a
message. A slash command posts its configured answer as the application.
Deleting the application invalidates the token immediately.

## Defects found while verifying the above

Each was found by a failing assertion, confirmed against the running instance,
and fixed. They are listed because they are the kind of thing a passing test
suite that never exercised the path would have shipped.

- **SSRF in the webhook validator.** `validateUrl` checked the protocol and the
  absence of credentials, and its comment claimed it also refused private
  addresses. It did not: `https://169.254.169.254/hook` was accepted, and the
  delivery log would have carried the response. The guard is now shared with the
  preview fetcher (`services/netguard`), so there is one implementation rather
  than one per caller.
- **Every deep link 404'd on an origin-root deployment.** The SPA fallback
  derived the path to match from a value that defaulted to `/`, so the first
  segment was empty, which is in no prefix list. The same build worked under
  `/app` and not at its own front door.
- **The document kept the hosted mount on self-host.** `index.html` carries
  `<base href="/app/">` and reaches its assets relatively; the rewrite only ran
  on the deep-link path, so `GET /` asked for `/app/css/app.css` and every asset
  404'd. Entry points now go through one rewriter.
- **A channel id was broadcast to every member of the community.**
  `events.emitChannel` called the gateway's server-room broadcast, which has two
  parameters, with three - so the channel id went out as the payload.
- **Previews never arrived over the socket.** `queue()` returned the map
  `listForMessages` builds, and callers read `.length` on it, so the broadcast
  never fired. History looked right, which is what made it worth a test that
  watches the wire.
- **Bot posts 500'd.** The token middleware assigned the application to
  `req.app`, which Express reserves for the application instance.
- **The settings pane was 284px wide at 1600.** The frame nests its own 240px
  navigation column inside a content column the shell has already spent 240px of
  sidebar and 260px of member panel on, and the comment claiming 1180px was the
  point where "nav + a readable form + a summary all fit" was wrong. Thresholds
  are derived from that arithmetic now, per frame, and the pane never narrows as
  the window widens without a new column appearing.
- **Sections appeared in the nav and opened the wrong page.** The router matched
  settings sections against a hand-kept second list of their names; it is derived
  from the settings information architecture now.
- **Departure counts were always zero.** Eight queries destructured into seven
  names, so the departure total was silently bound to the attachment count.
- **A long message lost its tail silently.** Content was sliced to 2000
  characters with no indication, so a long paste came back looking like a
  successful send of something the writer did not write. It is refused with a
  message now.
- **The webhooks and applications lists never refreshed after a create,** so the
  page looked like it had done nothing.

## Not verified

Worth knowing before trusting any of the above.

- **No MariaDB instance was reachable while this was built** (`sudo` requires a
  password, so no container). Every migration was verified against SQLite,
  including against a populated pre-migration database: 43 tables and 67 indexes
  became 49 and 73 with every row count intact, all 66 declared indexes present,
  and a second boot a no-op. The MySQL statements are standard guarded DDL and
  were read back from a live schema, but they have not been executed. A failed
  `ALTER` warns and the instance still boots: a migration that stops startup is
  worse than a missing feature.
- **Visual checks were headless Chromium only**, and this build's headless
  compositor returns a partially stale frame, so screenshots are evidence about
  layout rather than proof of it. Layout was verified by measuring the rendered
  DOM at 1024, 1280, 1440, 1600, 1920, 2200, 2560 and 3440 - pane width,
  horizontal overflow, and heading/action overlap - not by eye alone. No hover,
  focus order, or real drag pipeline. Drop and paste were exercised with
  synthetic `DragEvent`/`ClipboardEvent`, which tests the handlers and not the
  browser's own drag.
- **The "unreproduced" UI failure from the previous pass was the harness, not
  the product.** A console-error assertion failed intermittently, always on a
  cold instance. Captured, it was `ERR_CONNECTION_REFUSED` and a CORS rejection
  against `trycord-api.wispbyte.app` - the backend named in `backend.json`,
  which the shipped client tries before anything points it elsewhere. Two
  harness faults: a fixed startup delay instead of waiting for the listener, and
  error collection that began before the harness had configured the backend.
  Both fixed; the suite is now stable across cold starts.

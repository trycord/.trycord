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
- **Uploads are bounded but not scanned.** Size, type and extension are checked;
  contents are not inspected, so a file that passes those checks is stored
  unexamined.
- **Email verification and password reset need a working SMTP transport.** The
  flows are implemented and rate limited, and the token handling is tested
  directly, but no end-to-end mail delivery is exercised in CI.
- **No session management UI listing individual devices.** All sessions can be
  revoked at once; they cannot be revoked one at a time.
- **Full-text search is prefix-based.** There is no index and no ranking, so
  search quality degrades as history grows.
- **`docs/selfhosting.md` is a deployment narrative, not a variable reference.**
  `.env.example` now names every variable the server reads - checked by
  comparing `process.env.X` against the file: 41 read, 41 present - but it stays
  grouped by concern rather than exhaustively commented one by one, so the full
  semantics of the rarer tuning values live in the source beside the code that
  applies them.

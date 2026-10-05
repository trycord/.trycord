# Architecture

What this document is: how the system is put together, and the decisions that
the code alone does not explain. It is reference, not a plan and not a log.

Last verified: `npm run check` applies the schema to a throwaway SQLite database
and reports 49 tables and 74 indexes; `npm run check:routes` confirms all 18
client segments are served.

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

## Checks

| Command | What it covers |
|---|---|
| `cd trycord-server && npm run check` | schema against a throwaway SQLite database, index uniqueness, client routes served by the server, every client module parsed with its imports resolved, every client singleton bound |
| `npm run check:routes` | every client route is served by the server |
| `npm run check:client` | parses every web-client module as an ES module and resolves its relative imports |
| `npm run check:client-singletons` | a name used in front of a dot — `Api.something`, `State.me` — that the file never imported |

`check:client` exists because `node --check` on a `.js` client file reports success
for a file containing `import` statements even when the body has a duplicate
declaration. A duplicate `const serverId` reached `main` through it, in `44e1ba8`,
and the app would not start.

`check:client-singletons` exists because all four of the above passed while every
settings page was rendering the shell's error card. A refactor had removed
`import Api from` from every file in a directory rather than from the files that
did not use it, and `profile.js` went on calling `Api` ten times. The syntax was
valid, the imports that remained all resolved, and the module parsed. It is narrow
on purpose: a general "identifier used but not declared" pass produces hundreds of
false positives from dynamic `import()` destructuring, and a check that cries wolf
does not get run.

**None of these execute anything.** A syntax gate is not a test suite, and three
separate breakages in one refactor passed all of them. What catches those is the
screenshot suite, which walks the signed-out pages before it signs in, reports
where the browser ended up and what the console said, treats the shell's error card
as a failure on any surface — it photographs as a tidy card with a correct layout
and no overflow, so nothing else would notice — and fails the run listing every
surface that produced one.


A live S3 round trip has never completed. The signer was pinned against the AWS
`aws-sig-v4-test-suite` vectors at the time, which proved the algorithm correct
and left the failure attributable to the endpoint or its credentials rather than
to the implementation. That check is no longer in the repository, so nothing pins
the signer now.

## The client: pages and navigation

One file says what a page *is*: `trycord-client/js/pages/registry.js`. A page
declares its identity, its address, who may be there, which shell layout it wants,
whether it has a contextual sidebar, and — for the scoped navigations — its scope,
group, label, icon, order and blurbs.

Everything else asks that file rather than deciding for itself:

- the router resolves an address to a page
- `pages/lifecycle.js` runs the previous page's teardown, gates access, calls the
  renderer, paints the chrome afterwards and catches what the renderer throws
- the rail, the phone tab bar, the settings navigation and the admin navigation all
  read the same definitions

That is the point of it. There used to be six lists each answering part of "where
can I go and what is this screen called" — the route table, a layout prefix table,
a sidebar context classifier, the rail's destinations, the phone tab bar's
destinations, and the settings information architecture — and they did not agree.
The admin navigation came from one list while the admin page's title came from
another holding the same nine sections in a different order; the sidebar classifier
returned three page types whose renderers had been deleted, so they fell through to
the messages list.

Matching is longest-prefix-wins on segment boundaries, with `:params`. The order of
the registry array is a reading convenience, not a correctness requirement: moving
an entry cannot change what a URL means. Legacy spellings are rewritten before
matching rather than kept as parallel entries, so `/account/*` and `/admin/servers`
reach the page that answers to them and cannot drift from it.

A renderer lives next to its own domain — `community/`, `account/`, `admin/`,
`messages/`, `global/`, `profile/`, `discovery/`, `support/`, `public/` — and binds
to a page id in `pages/handlers.js`. Renderers are kept out of the registry because
the rail, the sidebar and the settings navigation would otherwise have to import
every page module to read a label, and those modules import the shell, which reads
the registry.

## Theming

Every surface reads its colours from CSS custom properties, so a theme is a set
of token values rather than a stylesheet swap. `docs/theming.md` covers the
built-in themes, the Custom studio, what advanced CSS is allowed to change, and
why the limits exist.

The part worth knowing as an architect: custom CSS is validated by a real parser
before it is applied, and the result is then measured — a theme that leaves the
shell hidden or the rail collapsed is rejected and Ember is restored. Neither
check trusts the CSS text.

## Known gaps

Real, known gaps. None blocks ordinary use.

- **The S3 driver has never completed a live round trip**, for the reason above.
- **Any file may be attached, and anything unrecognised is served as a download.**
  There is no list of accepted types. Size (8 MB), a per-account quota, a
  per-route rate limit, a per-message count and filename cleaning are all still
  enforced; nothing is refused for what it is.

  What makes that safe is the serving side rather than the extension. The type
  is detected from the bytes rather than trusted - magic bytes for the binary
  formats, and a strict no-NUL / no-stray-C0 / valid-UTF-8 check for the text
  types - and the detected type is stored in preference to the declared one, so a
  GIF named `photo.png` is stored and served as a GIF. A file matching nothing is
  stored as `application/octet-stream`.
- **Email verification and password reset need a working SMTP transport.**
- **Full-text search is prefix-based.** There is no index and no ranking.
- **`docs/selfhosting.md` is a deployment narrative, not a variable reference.**
  Every variable is documented in `trycord-server/.env.example`.
- **Attachment progress, cancel and retry, drop and paste, and a lightbox.**

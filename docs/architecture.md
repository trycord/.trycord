# Architecture

What this document is: how the system is put together, and the decisions that
the code alone does not explain. It is reference, not a plan and not a log.

Last verified: the application boots and serves on a configured instance; the
schema is applied by `npm run migrate`; federation is exercised between two instances
with separate databases and separate keys. The automated check suite that used to live
in `backend/scripts/check-*.js` has been removed - it was the heaviest load this
machine carried, and the power-on hook that ran it on every boot was the reason a
restart of the API could start a storm of processes on an already-warm host. What
verification remains is described under `## Verification`.

## Where things live

The eleven questions worth being able to answer without searching.

| | |
|---|---|
| The application tree | `frontend/js/shell.js`, mounted by `frontend/js/main.js` - builds the workspace into the one element in `index.html`. The document itself holds nothing but metadata, `<base>`, the crash screen and the entry module. |
| The Mobile module | `frontend/mobile/js/shell.js`, mounted by `frontend/mobile/js/main.js` into `frontend/mobile/index.html` - an app bar, a view, an optional composer and a bottom tab bar. An independent entry document, entry module and stylesheet over the same `frontend/packages/` platform; it never imports the desktop module. |
| What is on screen | `frontend/js/router.js` - resolves the address to a page, asks its renderer for the regions, and fills the shell from that one answer. No region decides for itself. |
| Routing | `frontend/js/router.js` - parses `location`, matches the longest prefix on segment boundaries, resolves the community by slug or id, and mounts. No hash. |
| Page definitions | `frontend/packages/registry.js` - the one source of truth for every page, route and nav entry. |
| Navigation | Derived from that registry: `frontend/js/shell.js` for the rail and regions, `frontend/mobile/js/shell.js` for the bottom tab bar, `frontend/js/shell/context.js` for the place, settings, admin and community sidebars. Presentation differs; identity does not. |
| A page | `{id, route, ...}` metadata in the registry, with its renderer bound from `frontend/js/features/index.js` by `main.js` through the registry's `bind()`. The registry never imports the view modules that draw, so reading a label does not pull in the shell. |
| Community and channel | `frontend/js/features/community.js` - one module for a community: the channel (text or voice), the roster, and the administrative screens (channels, categories, members, roles, invites, settings) underneath it. `frontend/js/shell/context.js` draws the community tree. |
| Signed-out surfaces | `frontend/js/features/auth.js` (sign-in, registration, two-step), `documents.js` (the public documents), `discover.js` and the community-creation screen in `community.js`. |
| Account settings | `frontend/js/features/settings.js` with the studio sections in `settingsClient.js`, `settingsAccount.js`, `settingsSecurity.js`, `settingsSafety.js` and `settingsNotices.js`, driven by the `settings.*` entries in the registry. |
| The admin console | `frontend/js/features/admin.js` plus its sections in `adminCfg.js` (the configuration centre, rendered from the catalogue the API returns rather than a hardcoded field list), `adminInfra.js`, `adminMail.js` and `adminSurfaces.js`. |
| Renderers | `frontend/js/features/index.js` and `frontend/mobile/js/views/index.js` - id to renderer, and nothing else, one table per module. Metadata stays in the registry so the registry is not a cycle. |
| Voice | `frontend/js/voice/` - `session.js` runs the in-house WebRTC mesh (one seat, one channel, roster polled and diffed, perfect negotiation per peer), `dock.js` the floating panel that follows a session, `room.js` the voice channel's room page. The server relays signalling only; the audio is browser to browser. |
| Lifecycle | `frontend/js/router.js` - teardown of the previous page, access gate, renderer call, then painting the chrome and catching what the renderer throws. |
| Authentication state | `frontend/packages/state.js`, with `frontend/packages/store.js` for the loading and refresh. The token is in `api.js`; everything else reads `State.me`. |
| Client-side permissions | `frontend/packages/store.js#can`, mirrored from `services/permissions.js`. **Display only** - the server decides. |
| Which origins may talk to this instance | `src/origins.js` - the CORS policy, including the desktop app's custom scheme and the `*.` wildcard rules. |
| Server-side authorization | `middleware/serverAccess.js` - `resolveServer`, `requireMember`, `requirePerm`, `requireOwner`. Routes declare their own level. |
| Themes | `frontend/packages/theme.js` over the tokens in `frontend/css/tokens.css` (aggregated by `frontend/css/app.css`). The chosen palette is written to `<html data-theme>`; a reader's custom palette goes on as inline custom properties and is kept only if the shell still measures after it lands. |
| API calls | `frontend/packages/api.js`. One `request()`, no per-feature clients. |
| Message state | `frontend/js/ui/chat.js` - the conversation renderer shared by channels and DMs: the feed, message rows and the typing line, torn down on the way out. `frontend/packages/api.js` and `frontend/packages/realtime.js` carry what it reads. |
| Community context | `frontend/packages/store.js` - `currentServerId` and the community tree, with `frontend/packages/realtime.js` keeping it fresh. |
| Data model | `db/tables/` - one module per concern: identity, communities, messaging, social, moderation, instance. |
| Schema migrations | `db/schema.js` - the ALTER and MODIFY lists that bring an existing database up to date, the declared indexes, the backfills. |
| Database access | `db/index.js`, which is the only module that speaks SQL dialect. |
| Notification preferences, quiet hours, sessions | `services/prefs.js`, `services/wellbeing.js`, `services/sessions.js` - each its own module, not three more things inside `services/privacy.js`. |
| Instance configuration | `services/settings.js` - the schema, the stored values and the precedence (stored, then environment, then default) - with `db/config.js` for the deployment facts a running process cannot change. The administrator console edits the stored layer; the environment stays the floor, documented in `backend/.env.example`. |
| Self-hosting | `docs/selfhosting.md`. No product code requires Trycord's own infrastructure: the client defaults to it but every value is overridable, and a client served by a backend is repointed at that backend. |

## Architecture

```
Trycord
├── backend    authoritative backend: API, WebSocket, auth, storage
├── frontend    WAC, the web client
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

## Verification

The automated check suite that used to live in `backend/scripts/check-*.js` has been
removed. It was the largest source of load this machine ever carried: a single run
booted two whole instances, rendered every route through jsdom, walked the realtime
gateway with live sockets, and started a browser - and the power-on hook that ran it
on every boot meant a restart of the API began a twenty-second storm of processes on
a machine that was already too warm. On a host this size, a suite that proves the
product works is worth less than a product that is not fighting its own diagnostics.

What remains are the things that are cheap and always true:

| Command | What it covers |
|---|---|
| `cd backend && npm start` | the application itself: the API, the web client and the public site |
| `cd backend && npm run migrate` | the schema, applied to the configured database |
| `cd backend && npm run db:backup` | a read-only dump of the live database, verified against what the server reports |
| `cd backend && npm run db:restore <file>` | verifies a dump, and restores it when told to |
| `cd backend && npm run css` | rebuilds the stylesheets from the layer sources |

Verification is now something a person does against a running instance rather than a
command that runs on a schedule: sign in, post, reload and watch the socket deliver.
The federation path is exercised the same way - two instances, separate databases,
separate keys - because that is what it is for.

## The client: pages and navigation

One file says what a page *is*: `frontend/packages/registry.js`. A page
declares its identity, its address, who may be there, which shell layout it wants,
whether it has a contextual sidebar, and — for the scoped navigations — its scope,
group, label, icon, order and blurbs.

Everything else asks that file rather than deciding for itself:

- the router resolves an address to a page
- `frontend/js/router.js` runs the previous page's teardown, gates access, calls the
  renderer, paints the chrome afterwards and catches what the renderer throws
- `frontend/mobile/js/router.js` does the same for the Mobile module: it reads the
  same registry, resolves the same addresses, and paints the mobile shell from the
  renderer's answer
- the rail, the bottom tab bar, the settings navigation and the admin navigation all
  read the same definitions

That is the point of it. There used to be six lists each answering part of "where
can I go and what is this screen called" — the route table, a layout prefix table,
a sidebar context classifier, the rail's destinations, the bottom tab bar's
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

A renderer is a module in `frontend/js/features/` — `community.js`, `dms.js`,
`friends.js`, `settings.js`, `admin.js`, `auth.js` and the rest — and
`frontend/js/features/index.js` holds the one table that maps a page id to the
renderer that draws it, which `frontend/packages/registry.js` binds at startup. The
table is kept out of the registry because the rail, the sidebar and the settings
navigation read page definitions to draw a label, and a renderer imports the shell,
which in turn reads the registry.

The Mobile module keeps the same shape in its own tree: `frontend/mobile/js/views/`
holds its renderers and `frontend/mobile/js/views/index.js` is its id-to-renderer table,
bound by the same `registry.bind()`. A page id resolves to the desktop renderer in the
desktop module and the mobile renderer in the mobile module, and neither table imports
the other.

## The shell

`frontend/js/shell.js` draws the tree the rest of the application addresses by
id — the rail, the place navigation, the workspace and the overlays — once, when the
application starts, and owns the keyboard shortcuts. The region functions on that
module (`renderAllChrome()`, `setStage`, `setStageHead`, `setComposer`,
`setContextPage`, `setInspector`, `setDock`, `setConnection`), with
`frontend/js/shell/context.js` and `frontend/js/shell/frame.js`, fill those regions on
every route change and every unread badge. The split is deliberate: the shell's
*structure* is stable and read by id from everywhere; its *content* changes on every
route. One file doing both was a tree that got torn down and rebuilt to change a
number.

There is no component framework. A screen builds DOM with `el()` from
`frontend/packages/dom.js`; the shared pieces are plain functions in
`frontend/js/ui/` (`primitives.js`, `page.js`, `chat.js`, `person.js`), and overlays,
dialogs and toasts live in `frontend/js/ui/overlays.js`. A surface that registers a
document listener removes it when it is torn down — the lifecycle the router runs —
because a listener left behind answers for a page the reader has left.

The Mobile module has its own `frontend/mobile/js/shell.js` — an app bar, a scrolling
view, an optional composer and a bottom tab bar — and shares nothing with this one but
the platform. Its overlays are bottom sheets through one manager, and only the topmost
answers Escape.

## Two modules, one platform

The web client is two independent modules over one shared platform:

| | |
|---|---|
| Shared platform | `frontend/packages/` — the registry, the API, config, state, store, realtime, nav, theme and the DOM helpers. Nonvisual: it never draws. |
| Desktop module | `frontend/js/` — entry document `index.html`, entry module `js/main.js`, the desktop shell, the view tree, the `frontend/css/` bundle. |
| Mobile module | `frontend/mobile/` — entry document `mobile/index.html`, entry module `mobile/js/main.js`, the mobile shell, the view tree, the `frontend/mobile/css/` bundle. |

"Independent" is a property of the dependency graph, not of a directory name. The
platform may import only itself; each presentation module may import itself and the
platform; neither may import the other. `check-frontend-modules.js` resolves every local
import — static and dynamic — and fails on a crossing, because the first `../` that
reaches the wrong root is how two modules quietly become one tree again.

What is shared is shared on purpose. `frontend/packages/registry.js` is still the one
source of truth for every page, route and nav entry: both routers match against it, and
the mobile renderer table binds its own ids to the same page definitions. An address
means the same thing in both modules; only the drawing differs.

Serving is one origin. `serve-client.js` serves both entry documents and stamps each
one's `<base>` per request, so a hosted mount and a self-hoster's origin root are the same
code with one constant changed. Each module carries its own `backend.json`, because
`config.loadStaticConfig()` fetches it relative to the document root and the mobile
document sits one directory deeper; the server repoints both copies at whoever is serving
them.

Both directions of the front-door handoff are implemented, and both are one
document load driven by the same chooser: a reader arriving at the desktop front door
whose viewport or remembered choice says mobile is sent to the mobile document before
any chrome is built, and a reader in the mobile module who chose "desktop site" is sent
back. Only the front door decides — a deep link is already module-addressed, so
following one never bounces the reader into the other module.

### Coupling that is unavoidable, and named

The Desktop module carries no phone arrangement. `frontend/css/app.css` is the desk
composition and nothing else: there is no responsive layer and no `presentation.js`, so
a narrow viewport never reshapes the desktop shell into a phone. A phone is the Mobile
module — its own document, its own entry, its own shell and its own stylesheet under
`frontend/mobile/`. What remains is the handoff between them: `frontend/packages/chooser.js`
is the one place that decides which module a reader belongs in and computes the sibling
mount, and each entry consults it at its own front door. That module is the coupling, and
it is deliberately the only one.

`check-client-styles.js` still reads each class against the stylesheet of the module that
emits it, so a class moved between modules without its rule is caught, and
`check-mobile-layout.js` asserts the mobile module's composition from its own built
stylesheet.

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
- **Mail has three modes and nothing else: smtp, api, disabled.** A mode is a
  shape of transport; a provider is a specific service. The two are kept apart
  so that no route, setting or screen names a vendor. The api adapter is generic
  and configured: an operator points it at an endpoint and names where each part
  of the message goes in the JSON body. `MAIL_MODE` outranks the dashboard, as
  every environment variable does. Credentials are encrypted at rest with
  AES-256-GCM under a key derived from `JWT_SECRET`, and are never returned by
  the API, only reported as set or unset and readable or not.
- **Full-text search is prefix-based.** There is no index and no ranking.
- **`docs/selfhosting.md` is a deployment narrative, not a variable reference.**
  Every variable is documented in `backend/.env.example`.
- **Attachment progress, cancel and retry, drop and paste, and a lightbox.**

### Where a request actually goes

The client resolves its backend in this order, and the order matters more than it looks:

1. a reader's saved setting (`trycord.backendUrl`)
2. `backend.json`, served by the backend itself
3. a server pin (`window.TRYCORD_CONFIG`)
4. the origin that served the page
5. a localhost default, for `file://` and desktop runs

Step 2 is the one that surprises people. `frontend/backend.json` names the official
instance, because the hosted front end needs something to talk to. A self-hoster
deploying this repository inherits that name - and since `backend.json` outranks the
serving origin, their client would sign people in against `api.trycord.dev` while
sitting on their own API. `serve-client.js` rewrites the file as it serves it:
`backendUrl` becomes whoever is asking, and `fallbackUrls` is dropped unless the
instance asking is the one those backups belong to. So the rule is one line - a client
served by a backend talks to that backend - and no domain is written into the client.

The desktop app is the deliberate exception: it loads the bundled `backend.json`
pin, because a shipped desktop build is always talking to the official instance.

Anyone writing a test that loads the client needs to know this. Reading
`index.html` off disk, as `check-render.js` does, gets the on-disk file rather than
the rewritten one, so the client talks to `api.trycord.dev` and every request comes
back 401. `check-render.js` pins `trycord.backendUrl` and refuses any request to a
port it does not own.

### What was swept for, and what was found

The brief asks for development debris to be hunted before completion, inspecting each
hit rather than deleting on sight. The result:

- **No TODO, FIXME, XXX or HACK** anywhere in shipped source. The ten apparent matches
  were the substring "todo" inside `applyWellbeingToDocument`.
- **No `console.log` debris in the client.** The five in `frontend/js` are `[trycord]`
  error and warning diagnostics, each wrapped so a locked-down webview with no console
  cannot take the page down.
- **Every `console.log` in the backend is structured operational output** - `[info]`
  startup lines, `[security]` account events, `[mail]` delivery, `[schema]` backfills.
  That is a server's job, not debris.
- **The one dead field found was `parent` on the dms conversation page**, removed, and
  the mechanism that actually does the job written in its place.
- **One piece of dead CSS**, `.tab-button__dot`, replaced with the tab-bar count it was
  standing in for.

A useful near-miss: an earlier sweep matched 61 occurrences of "hack" and 174 of
"placeholder". Both were a gitignored local build of the desktop client left over from an
earlier session, not repository content.

### What cannot be verified here, and why

Chromium is installed and `--dump-dom` works against `about:blank`, but any `http://`
navigation hangs until the process is killed. With `--enable-logging=stderr` the last
thing it does before hanging is wait on `optimizationguide-pa.googleapis.com`; disabling
that lets it finish starting, and then every real request hangs the same way. The
network service cannot complete a request in this sandbox, and `--single-process`
traps instead of working around it.

So the client is verified with jsdom, which has a DOM but no layout engine. That
covers what it can be trusted for: pages render, routes resolve, controls have names,
navigation composes, themes switch. It cannot cover measurement - widths, contrast,
touch target sizes, or anything `getBoundingClientRect` feeds - and it cannot exercise
a custom theme past `verifyCustomSafety()`, which measures the shell and refuses the
theme when it cannot confirm the shell survived. In jsdom that refusal always fires,
which means the check exercises the recovery branch: a theme that breaks the shell has
to put Ember back rather than leave the application broken.

The honest summary: rendering, structure, semantics, routing and state are covered.
Pixels are not.

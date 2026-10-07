# Architecture

What this document is: how the system is put together, and the decisions that
the code alone does not explain. It is reference, not a plan and not a log.

Last verified: `npm run check` applies the schema to a throwaway SQLite database
and reports 49 tables and 74 indexes; `npm run check:routes` confirms all 20
client segments are served; `npm run check:flows` boots a server and passes 54
assertions against real flows; `npm run check:render` boots a server and renders all
40 routable pages in jsdom, passing 51 assertions over 1151 interactive controls;
`npm run check:realtime` puts two accounts on two sockets and confirms a message
crosses between them; `npm run check:contrast` measures every theme against WCAG AA
and finds 79 ratios that pass; and `npm run check:client-load`
evaluates all 66 client modules.

## Where things live

The eleven questions worth being able to answer without searching.

| | |
|---|---|
| The application tree | `frontend/js/shell/tree.js` - builds it into the one element in `index.html`. The document itself has nothing in it but metadata and a mount point. |
| What is on screen | `frontend/js/shell/compose.js` - one function, called once before any region draws, returning mode, width, route, state and whether each region exists. The regions read that and nothing else decides on its own. |
| Routing | `frontend/js/router.js` - parses `location`, calls `mount`. Longest-prefix matching, no hash. |
| Page definitions | `frontend/js/pages/registry.js` - the one source of truth for every page, route and nav entry. |
| Navigation | Derived from that registry: `shell.js` for the rail and tab bar, `settings-shell.js` for settings and admin, `community-nav.js` for the community sidebar. Presentation differs; identity does not. |
| A page | `{id, route, scope, render}`. `handlers.js` attaches the renderer at load via the registry's `bind()`, so a page answers for itself and the registry never imports the twenty modules that draw. |
| Signed-out surfaces | `frontend/js/public/` - `auth.js`, `legal.js`, `backend.js`. The sign-in screens, the legal documents and the instance picker, which had nothing in common but a file. |
| Privacy settings | `frontend/js/privacy/` - one module per tab, and `sync.js` for the realtime refresh. Three tabs that shared a save helper and nothing else. |
| The admin console | `frontend/js/admin/` - the frame plus one module per section, and `admin/pages/` for the public-page editor. Eight lists that shared nothing but a paint sequence number. |
| Renderers | `frontend/js/pages/handlers.js` - id to renderer, and nothing else. Metadata stays in the registry so the registry is not a cycle. |
| Lifecycle | `frontend/js/pages/lifecycle.js` - mount, teardown, access gate, per-page error isolation. |
| Authentication state | `frontend/js/state.js`. The token is in `api.js`; everything else reads `State.me`. |
| Client-side permissions | `state.js#can`, mirrored from `services/permissions.js`. **Display only** - the server decides. |
| Which origins may talk to this instance | `src/origins.js` - the CORS policy, including the desktop app's custom scheme and the `*.` wildcard rules. |
| Server-side authorization | `middleware/serverAccess.js` - `resolveServer`, `requireMember`, `requirePerm`, `requireOwner`. Routes declare their own level. |
| Themes | `frontend/js/theme.js` over the `--t-*` tokens in `css/app.css`. Built-in themes are `[data-theme]` blocks; custom ones are verified and kept working. |
| API calls | `frontend/js/api.js`. One `request()`, no per-feature clients. |
| Message state | `messages/dm-thread.js` and `community/conversation.js`, each owning its own feed and subscriptions, torn down on the way out. |
| Community context | `state.js` - `currentServerId`, plus `workspace-shared.js` for the realtime wiring that keeps it fresh. |
| Data model | `db/tables/` - one module per concern: identity, communities, messaging, social, moderation, instance. |
| Schema migrations | `db/schema.js` - the ALTER and MODIFY lists that bring an existing database up to date, the declared indexes, the backfills. |
| Database access | `db/index.js`, which is the only module that speaks SQL dialect. |
| Notification preferences, quiet hours, sessions | `services/prefs.js`, `services/wellbeing.js`, `services/sessions.js` - each its own module, not three more things inside `services/privacy.js`. |
| Instance configuration | `db/config.js` and the `instanceConfig()` in `server.js`. Every deployment fact is an environment variable, documented in `backend/.env.example`. |
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

## Checks

| Command | What it covers |
|---|---|
| `cd backend && npm run check` | schema against a throwaway SQLite database, index uniqueness, client routes served by the server, every client module parsed with its imports resolved, every client singleton bound |
| `npm run check:routes` | every client route is served by the server |
| `npm run check-server-routes` | no route is registered twice in one server module |
| `npm run check:flows` | **runs the application** - boots a server and drives real flows |
| `npm run check-server-bindings` | no server module uses a name it did not require or define |
| `npm run check:client-bindings` | the same, for the client |
| `npm run check:client-load` | **evaluates** every client module against a stub DOM |
| `npm run check:client` | parses every web-client module as an ES module and resolves its relative imports |
| `npm run check:client-singletons` | a name used in front of a dot — `Api.something`, `State.me` — that the file never imported |
| `npm run check:contrast` | every theme's contrast ratios against WCAG AA, and no colour written into a component rule |
| `npm run check:headings` | one `h1` per surface; a page that adds its own beside the context header's fails |
| `npm run check:render` | **renders every route in jsdom** against a real backend, and checks accessible names, the phone composition and themes |
| `npm run check:realtime` | **two clients, two sockets** - one person's message reaches somebody else's open tab and is still there after a reload |
| `npm run check:shots` | photographs every surface at eight widths in a real browser; skips where t
| `node scripts/check-sibling-bindings.js` | a module in a split directory references a name a sibling exports, without importing it |
| `node scripts/check-require-aliases.js` | a service is called by a name it was not bound to, is imported where it is not exported, or is called bare and never imported |
| `node scripts/check-crash-recovery.js` | the crash surface recovers by itself from a half-updated module graph, and does not reload for an ordinary fault |
| `node scripts/check-signin.js` | a correct password returns a token. A regression test for the sign-in bug below, which no other check could see |
| `npm run db:backup` | dumps the live database read-only and verifies the dump against what the server reported |he browser cannot load `http` |

`check:client` exists because `node --check` on a `.js` client file reports success
for a file containing `import` statements even when the body has a duplicate
declaration. A duplicate `const serverId` reached `main` through it, in `44e1ba8`,
and the app would not start.

`check-server-routes` exists because `/support` and `/security` were each registered
twice in `server.js` — once as editable pages, where the page editor's database content
is substituted into the file, and again further down as plain static files. Express takes
the first handler that responds, so the second was unreachable. Nothing was visibly
broken, which is why it survived: the dead line sat in the same list as the live one and
read exactly like it.

It checks same-file duplication only. Two routers mounted at the same prefix is ordinary
— Express composes them — and so is a route declared in one file and re-exported.

`check-require-aliases.js` exists because of one bug that the rest of the suite walked past
twice. `routes/auth/issued.js` defined a function called `issued` and did not export it,
so `login.js` destructured `undefined` out of a module that resolved perfectly, and every
successful sign-in answered 500 with nothing in the log but `issued is not a function`.
`sessions.js` called `issued` with no import at all. Neither the binding checks nor 54
flow assertions saw either, because both ask about names that appear bare or as
`service.member`, and this is a named import of something that does not exist.

The check answers three questions: is a require bound to a name the file then calls by a
different one; is a name called that nothing in the file binds, whether it is `obj.member`
or a bare call; and does a destructured import actually exist in the target. It got two of
those wrong before it was right, both recorded in the file - it excluded "built-ins" with
a pattern that matched any lowercase word, so it skipped exactly the modules it was
written for, and it stripped comments with its own regexes, which is the third time this
repository has been bitten by that.

`check-server-bindings` and `check:client-bindings` exist because every other check
verifies that an import *resolves*. None of them notices a name that is simply absent —
a missing `require`, a missing `toast` — which is a `ReferenceError` on the line that
uses it and nothing at all until that line runs. Three were live: a stale-refresh
warning that threw inside its own `.catch()`, accepting a friend request from Settings
that threw after the request had already succeeded, and changing a password that
succeeded and then threw while repainting. All three passed the four older checks.

Getting the noise to zero took four attempts — 98 findings, then 40, then 15, then 1 —
and the reason is `strip-comments.mjs`. Comments have to come out by character
scanning, and the scanner had a hole: a regex literal was read as code, so the quotes
inside `const re = /\bhttps?:\/\/[^\s<>"']+/gi` opened a string that swallowed 130
lines of `services/embeds.js`, including a function definition three lines below the
one that opened it. It now recognises regex literals, which means deciding whether a
`/` divides or begins one; the usual rule applies, since a regex cannot begin where an
operand has already ended.

Both checks report a borrowed name only when exactly one module exports it, so the six
legitimate re-exports — `leaveDm`, `icon`, `onCleanup` and friends — do not produce
findings. A check that cries wolf does not get run.

`check:client-singletons` exists because all four of the above passed while every
settings page was rendering the shell's error card. A refactor had removed
`import Api from` from every file in a directory rather than from the files that
did not use it, and `profile.js` went on calling `Api` ten times. The syntax was
valid, the imports that remained all resolved, and the module parsed. It is narrow
on purpose: a general "identifier used but not declared" pass produces hundreds of
false positives from dynamic `import()` destructuring, and a check that cries wolf
does not get run.

`check:client-load` imports every client module into Node against a stub DOM, which is
the only step that evaluates client code. A browser would be the honest place for it and
cannot be used here — Chromium cannot fetch `http://` and ES modules are CORS-blocked
over `file://` — so the modules are imported instead. It caught a fault that five other
checks passed: `export { esc, el, clear } from './ui/dom.js'` re-exports without creating
a local binding, so every importer resolved, the module parsed, every name was
"exported", and the application died on its first line with "Can't find variable: esc".
It is not the same as running the client and does not claim to be: it catches a module
that cannot be evaluated, which is the failure that had nowhere else to be caught.

**`npm run check:flows` is the exception, and it is the only one that runs anything.**
The rest read source: they parse files, resolve imports and compare lists. Three
separate breakages in one refactor passed all of them, which is what a syntax gate is.

`check:flows` boots a real server on a throwaway SQLite file and drives the flows a
person performs — register, sign in, create a community, post a message, edit it,
react, pin, delete, and try to read somebody else's community — then asserts what came
back. It is the only thing here that can catch a route that 404s, a permission that
lets the wrong person in, or a write that never reaches the database. It takes about
twenty seconds, most of which is waiting for the server to come up, and it is a separate
job in CI rather than part of `npm run check`.

**It refuses to run against anything but its own file, and that guard is not
decoration.** The repository's `.env` carries `DB_CLIENT` twice — `sqlite`, then
`mysql` — so the last one wins and a bare checkout resolves to a remote database.
Setting `DB_CLIENT` is what makes a run local; setting only `DB_FILE` is not, which is
how two accounts, a community and its channels once appeared in a live database. The
check now asks `src/db/config.js` what the server will resolve to, using the exact
environment the server will be given, and stops if the answer is anything but its own
throwaway file. Removing `DB_CLIENT` from it makes it refuse, which is how that guard
was tested.

What it does **not** cover is the browser. It asserts that `/settings/privacy` comes
back as the application document, because that is what makes a bookmark survive a
refresh, but nothing in this repository loads the client in a browser and looks at it.

What catches those is the screenshot suite: it walks the signed-out pages before it
signs in, reports where the browser ended up and what the console said, treats the
shell's error card as a failure on any surface — it photographs as a tidy card with
a correct layout and no overflow, so nothing else would notice — and fails the run
listing every surface that produced one.

It is not on `main`, deliberately. It lives on a `shots/*` branch, because it is
scaffolding for UI work rather than something every push should pay for.

`check.yml` runs the first three of these on every push to `main`. It has a fourth
job, browser, that could never have passed: it runs with `working-directory:
tests/browser`, and `/tests/` is gitignored as local-only tooling, so the directory
does not exist in a fresh clone and bash fails before the first suite starts. It went
unnoticed because `check.yml` was itself untracked — nothing had ever run it. That job
has been removed, with the reason left where it was.

Browser verification is therefore the screenshot suite and nothing else, on the
`shots/*` branch, where the scripts it needs are actually present.

It also cannot be run locally, which is worth recording because it has been
re-investigated more than once. Chromium is installed and renders `data:` and
`file://` URLs correctly, and the server answers on `http://127.0.0.1:9971` from the
shell, but Chromium's own network service cannot open an `http://` connection here at
all — the document comes back empty with nothing on stderr. `--no-sandbox`,
`--single-process`, `--headless=new` and `--disable-features=NetworkServiceInProcess2`
were each tried and each returns empty. Serving the client over `file://` instead does
not help: the entry point is `<script type="module">`, and ES modules are blocked by
CORS from a `null` origin, so nothing executes. The constraint is environmental.


A live S3 round trip has never completed. The signer was pinned against the AWS
`aws-sig-v4-test-suite` vectors at the time, which proved the algorithm correct
and left the failure attributable to the endpoint or its credentials rather than
to the implementation. That check is no longer in the repository, so nothing pins
the signer now.

## The client: pages and navigation

One file says what a page *is*: `frontend/js/pages/registry.js`. A page
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

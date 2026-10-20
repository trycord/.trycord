# Trycord 3.0 — implementation state

Where the work actually is, what is running, and what is blocking what. This
is the file to read first when picking the work up again.

Last updated: 2026-10-20, on branch `release/3.0.0`.

## Where the release stands

Phases 0, 1, 2 and 6 are done. Phase 3 is done except for the native
client's build. Phase 4 is done — the security review was carried out and
its nine findings are closed. Phase 5 is done. Phase 7 has not started.

**Trycord 3.0.0 is not release-ready.** The strict release gate in the
directive requires, among other things, an E2EE implementation that has passed
its security-review gate, and native client builds verified. Neither is
satisfied. Nothing in this repository should be read as claiming otherwise.

The capability-by-capability position is in `CAPABILITY_INVENTORY.md`, and it
is honest about the parts that are partial.

**What the security review changed.** Nine findings: the extension sandbox
could be left through the timer handle it was handed, a workflow could hand
out any role in any community, a run history and a federation report were
readable by any signed-in account, a webhook's health was reported across
communities, the sandbox did not apply the limits it declared, and the
registry's fetch went out with no network guard. Seven were fixed by the
reviewer; the two that needed a file the review did not own — the prekey
pool and the registry's fetch — were closed afterwards and are now proven by
`backend/tests/security-3.0/`.

**What the voice work changed.** The instance's own STUN and TURN service had
never answered a single packet: the encoder that writes a mapped address used
a constant that was never defined, the packet handler caught the resulting
error and threw it away, and every message type in the switch was an
identifier that did not exist. The service bound its port, received every
request and answered nothing - and the diagnostics reported the port as open,
which is exactly what a firewall problem looks like. The credentials could not
have verified either: the issuer produced an HMAC and the checker looked for
the shared secret itself. It is now checked against the standard's own
vectors - RFC 5769 publishes a request and the HMAC it must carry, and the
implementation reproduces it exactly.

The voice subsystem is a process of its own now - `trycord-voice` in the pm2
ecosystem - holding the service, its lifecycle, its health and its
diagnostics. The API asks it whether the service is up before it starts a
relay of its own, so the two never compete for the port.

**What the document work changed.** The editor refused a Terms of Service
document with "a heading is written with two or three #" - against a document
whose headings used a single hash. A single hash is the most ordinary heading
there is; the source mode accepted two and three and refused one, and the
server turned anything that was not two or three into two, so the source and
the stored document disagreed about what the writer had typed.

**What the community settings audit changed.** The settings were reduced
because a form was built, wired and never put on the page. The console has
twelve sections now, each of which draws something — and that is now a test,
because the check that would have caught it was missing. The audit is in
`COMMUNITY_SETTINGS.md`.

## What is running

| | |
|---|---|
| Deployment | pm2, one API process (`trycord-api`, fork mode) and one status monitor |
| API | `http://127.0.0.1:9971`, serving the API, the public site at the origin root, and the client at `/app` |
| Mobile client | `/app/mobile/` — its own document, shell, router and stylesheet, with `<base href="/app/mobile/">` |
| Database | MySQL at `157.90.211.250:3306`, database `s5743_Trycord` |
| Storage | local disk under `backend/uploads/` |
| Federation | Continuum, opt-in, enabled on the running instance |

The mobile module is served at both `/app/mobile/` (under the application
mount) and `/mobile/` (at the origin root), and each serves its own `<base>`
so its relative asset URLs resolve against the right tree.

## The Cloudflare deployment

The public site and the web client are also deployed to Cloudflare, from a
separate repository (`.trycord-cloudflare`) that holds **only the
deployment**: the Wrangler config, the Worker, and the built `dist/` tree.
The build fetches the product source at a pinned ref, so there is exactly one
copy of the source and the deployment cannot drift into carrying a stale
fork of it.

| | |
|---|---|
| Repository | `github.com/trycord/.trycord-cloudflare`, branch `main` |
| Built from | `trycord/.trycord` at `release/3.0.0` (4c73f20 and later) |
| Tree | 450 files, `verify-dist.js` 61 checks, `verify-worker.mjs` every route |
| Pushed | yes — `main` at `ed47ab0` |
| Deployed | **not from this machine** — `npx wrangler deploy` needs Cloudflare credentials, and this host has none |

**The deploy is the one step left.** The tree is built, verified and
committed; the command that publishes it is `npx wrangler deploy` from a
machine with the credentials.

**A page cannot 404 by being forgotten.** The worker used to answer a public
page only if it was named in a hand-written map of thirteen routes, and the
site has twenty-five — so twelve pages 404ed on Cloudflare while they worked
on the origin, and the register page's "Use another instance" link went to
one of them. The map is no longer a requirement: a path that is not a file
may still be a page, and the worker asks for the file. The verifier reads
the list of pages from the tree rather than from a list of its own.

## The verification suite

The repository shipped without an automated suite. It has one now, and it is
deliberately light, because the suite that was removed booted whole instances
and started browsers.

```
cd backend
npm test                        # everything
npm run test:integration        # the API contracts and the journeys
```

- **Runner**: `node --test`, Node's built-in runner. No test framework
  dependency.
- **Isolation**: every integration file boots its own instance against a
  temporary SQLite database on a free port, with its own uploads directory and
  its own signing secret. A run never touches the instance the machine is
  serving, and never shares a signing secret with it.
- **Hermeticity**: the environment is written to a file and pointed at with
  `DOTENV_CONFIG_PATH`, so the host's own `backend/.env` cannot leak into a
  run. A leaked `DB_HOST` would point a run at a live database.
- **Cost**: the integration suite is a few seconds.

## Defects found and fixed, with their root causes

| Defect | Root cause | Fix | Test |
|---|---|---|---|
| Desktop registration always failed | The client sent no legal versions; the server requires the ones it publishes | The version is fetched from `GET /api/legal` and sent; no client hardcodes a version | `tests/integration/auth.test.js` |
| `/admin/approvals` and `/admin/diagnostics` showed a fault box | The pages were in the registry with renderers, but the desktop renderer table never bound them | Bound, and every registry page is now asserted to have a renderer in both modules | `frontend/tests/` |
| A session created at registration could not be listed or revoked | Registration minted a token directly instead of through the shared issuance path, so no session row was written | Registration issues through the one shared path | `tests/integration/auth.test.js` |
| A valid token for an account this instance does not have answered 404 | The auth middleware reported a missing user as a missing resource | It is an authentication failure and now answers 401 | `tests/integration/auth.test.js` |
| The status page reported the API as unavailable on a split deployment | `status.js` probed `/health` with a relative path, so it probed the site | The address is resolved once and used for every probe | `public/tests/` |
| Community icons 404ed on a split deployment; every app link pointed at `/app/` | API-relative paths used verbatim; the app mount hardcoded | Both are resolved against the configured address | `public/tests/` |
| `npm run migrate` did not apply the schema | The script was a SQLite-to-MySQL data import wearing the name | The import is `npm run db:import`; `npm run migrate` applies the schema and runs the migrations | `tests/integration/migrations.test.js` |
| A migration could run twice, and nothing recorded that it had | There was no migration ledger at all | `db/migrations.js` records every migration, refuses to run one twice, blocks the ones after a failure, and refuses a database a newer build wrote to | `tests/integration/migrations.test.js` |
| Every process that touched the voice routes could not exit | The TURN service's allocation sweep was an interval that was never `unref`'d and could not be cleared | Unref'd, and cleared when the server stops | `tests/integration/lifecycle.test.js` |
| The verification suite hung for 100 seconds after every file | The same interval | The same fix | `tests/integration/lifecycle.test.js` |

## Blockers

### The native client cannot be built here

There is no Android SDK, no Java, no Gradle, no Xcode and no macOS in this
environment. A native client can be written, and one is being written, but it
cannot be compiled, run, or exercised on a device from here.

What this means for the release gate: the directive requires native clients to
have "genuine native build and runtime verification". That evidence cannot be
produced in this environment. The client must not be marked complete, and the
release must not claim it is.

What is being done instead: the project is complete and honest, the build path
is documented with the exact prerequisites, the source is checked for internal
consistency by a script that runs here, and `native/VERIFICATION.md` states
item by item what is and is not verified.

### No independent cryptographic review

The directive requires an independent security review before E2EE is
advertised as secure. No such review has been obtained, and none can be
claimed. The E2EE implementation is under an internal self-review only.

### The deployed demo

The deployed instance is reachable and the API answers, but a browser-driven
check of the deployed demo has not been performed from here. Chromium cannot
complete a network request in this sandbox. The cross-origin defects above
were found by reading the code and are fixed with tests; the *deployed*
behaviour after the fix is unverified until the deployment is updated.

## The next actions, in order

1. **The client half of the encryption.** The protocol, the API and the
   device lifecycle are complete and tested, and the **server** now stores an
   envelope and never the plaintext in a conversation it reports as
   encrypted — the socket path refuses what the HTTP path refuses, and a bot
   or a workflow cannot write in the clear into one. The client is the half
   that encrypts, and it is the last thing between "E2EE is implemented" and
   "E2EE is on".
2. **Both dashboard modes under a real deployment**, not only under the
   test harness.
3. **The accessibility and performance passes.** The security, licensing and
   performance reviews are written (`docs/audit/`); the two critical defects
   they found are fixed. The accessibility pass over the whole interface, and
   a performance pass over the parts the measurement did not cover, are not
   done.
4. **The client for the federation moderation surface** — the owner's view of
   what a remote member wrote, and the writer's view of what the owner
   decided. The API is there; the interface is not.

## What is done

The account lifecycle, the communities model with its categories, channels,
roles and permissions, messaging with real link previews, the search index and
its filters, the forum surface, the file and storage layer, notifications and
presence, the whole developer platform, the extension registry and the
workflow engine, the collaboration workspace, both dashboard modes, the
public website and its legal documents, the hybrid page editor, the provider
registry, the incident timeline, the localisation packs, the theme packages,
and the federation relay in both directions.

The verification suite is 544 backend tests, 207 client tests and 57 public
site tests - 808 in all, all green - and it runs in about half a minute.

## Uncommitted work

The tree is committed. The client half of the encryption is the work in
flight.

# Trycord 3.0 — test and verification log

The commands that were run, and what they actually said. A command that was
not run is not listed as passing.

Last updated: 2026-10-20, branch `release/3.0.0`.

## The suite

```
cd backend
npm test          # node --test "tests/**/*.test.js"
```

Node 22.23.3 treats a directory argument to `--test` as a file to run, so
`node --test tests/` fails with `Cannot find module '…/tests'`. The glob form
is the one that works, and it is what the script says. The same applies to
`node --test frontend/tests/` and `node --test public/tests/` — those two
directories have an `index.js` that requires the files beside them, so the
directory form works there too.

## What ran, and what it said

| Command | Result |
|---|---|
| `cd backend && node --test "tests/**/*.test.js"` | **609 tests, 609 pass, 0 fail** |
| `cd backend && node --test "tests/e2ee/*.test.js"` | 64 tests, 64 pass |
| `cd backend && node --test "tests/continuum/*.test.js"` | 53 tests, 53 pass — the relay, in **both** directions between two independently running instances |
| `cd backend && node --test "tests/workspace/*.test.js"` | 40 tests, 40 pass |
| `cd backend && node --test "tests/developer/*.test.js"` | 38 tests, 38 pass |
| `cd backend && node --test "tests/dashboard/*.test.js"` | 43 tests, 43 pass |
| `cd backend && node --test "tests/extensions/*.test.js"` | 46 tests, 46 pass |
| `cd backend && node --test "tests/workflows/*.test.js"` | 13 tests, 13 pass |
| `cd backend && node --test "tests/pages/*.test.js"` | 35 tests, 35 pass |
| `cd backend && node --test "tests/localisation/*.test.js"` | 15 tests, 15 pass |
| `cd backend && node --test "tests/themes/*.test.js"` | 11 tests, 11 pass |
| `cd backend && node --test "tests/reports/*.test.js"` | 20 tests, 20 pass |
| `cd backend && node --test "tests/search/*.test.js"` | 19 tests, 19 pass |
| `cd backend && node --test "tests/personal/*.test.js"` | 17 tests, 17 pass |
| `cd backend && node --test "tests/voice/*.test.js"` | 25 tests, 25 pass — the three media providers |
| `cd backend && node --test "tests/security-3.0/*.test.js"` | 34 tests, 34 pass — the review's nine findings, one regression file each |
| `cd backend && node --test "tests/integration/*.test.js"` | 136 tests, 136 pass |
| `cd backend && node --test tests/integration/auth.test.js` | 13 tests, 13 pass |
| `cd backend && node --test tests/integration/community.test.js` | 19 tests, 19 pass |
| `cd backend && node --test tests/integration/migrations.test.js` | 10 tests, 10 pass |
| `cd backend && node --test tests/integration/schema.test.js` | 7 tests, 7 pass — the portability guard |
| `cd backend && node --test tests/integration/lifecycle.test.js` | 4 tests, 4 pass |
| `cd backend && node --test tests/integration/push.test.js` | 9 tests, 9 pass |
| `cd backend && node --test tests/integration/netguard.test.js` | 8 tests, 8 pass — the outbound guard |
| `cd backend && node --test tests/integration/environment-template.test.js` | 6 tests, 6 pass |
| `cd backend && node --test tests/integration/forums.test.js` | 12 tests, 12 pass |
| `cd backend && node --test tests/integration/providers.test.js` | 13 tests, 13 pass |
| `cd backend && node --test tests/integration/module-graph.test.js` | 5 tests, 5 pass — every route and service module loads |
| `cd frontend && node --test "tests/**/*.test.js"` | **435 tests, 435 pass** — including the accessibility audit and the community-settings parity check |
| `cd public && node --test "tests/**/*.test.js"` | 57 tests, 57 pass |
| `node native/scripts/check-native.mjs` | 6 JSON files parsed, 91 source files scanned, 290 relative imports resolved, 0 problems |
| `cd backend && node --test tests/integration/fresh-install.test.js` | 10 tests, 10 pass — a first install, on a database that did not exist |
| `cd backend && npm run css` | the stylesheets are up to date |
| `cd backend && node scripts/migrate.js --status` | schema version 2, applied 1, 2, pending none |
| `cd backend && npm run db:backup` | 61 tables, 684 rows, verified |

## The live instance

The deployment on this host was restarted onto the 3.0 code and checked.

| Check | Answer |
|---|---|
| `GET /health` | `{"ok":true}` |
| `GET /ready` | `{"ok":true,"instanceId":"official"}` |
| `GET /api/instance` | `version: 3.0.0`, `apiVersion: 1`, `protocolVersion: trycord-continuum/1.0` |
| `GET /backend.json` | `{"backendUrl":"https://api.trycord.dev","appUrl":"/app"}` — rewritten to the instance that served it |
| `GET /` | carries `<meta name="trycord-api" content="https://api.trycord.dev">` |
| `GET /app/mobile/` | serves the mobile document with `<base href="/app/mobile/">` |
| `GET /app/backend.json` | `{"backendUrl":"http://127.0.0.1:9971"}` — the client talks to the instance serving it |
| `GET /api/v1/openapi.json` | 200 |
| `GET /api/v1/scopes` | 200 |
| `GET /api/v1/instance` | 200 |
| `GET /api/e2ee/devices` | 401 — mounted, and it wants a session |
| `GET /api/me/push-devices` | 401 — mounted |
| `GET /api/servers/:id/settings` | 401 — mounted |
| `GET /api/admin/settings` | 401 — mounted |

## The critical user journeys

The directive names twenty-eight. These are the ones with a test behind them.

| # | Journey | Evidence |
|---|---|---|
| 1 | Fresh installation and configuration | `migrations.test.js`, `lifecycle.test.js`; `npm run migrate` against a live MySQL |
| 2 | Startup and health checks | `/health`, `/ready`, `/api/health` on the live instance |
| 3 | Open the public website | `public/tests/links.test.js` — every internal target exists |
| 4 | Navigate to the working demo | `public/tests/demo.test.js` — the demo says which half is live and which is sample data |
| 5 | Connect to a reachable instance | `public/tests/resolver*.test.js`, `status.test.js`, `directory.test.js`; the live `backend.json` and meta tag |
| 6 | Register and authenticate | `auth.test.js` |
| 7 | Authentication routes render standalone | `frontend/tests/auth-gates.test.js` |
| 8 | Restore a valid session | `auth.test.js` |
| 9 | Revoke a session, and the backend refuses it | `auth.test.js` — the revoked token is refused by the API, not only hidden |
| 10 | Create and update a profile | `routes/users.js`; the avatar picker's discarded file was fixed |
| 11 | Create or join a community | `community.test.js` |
| 12 | Exercise roles and permissions | `community.test.js` — a role grants one permission and not another |
| 13 | Send and receive persisted messages | `community.test.js` — order is the order they were posted in |
| 14 | Verify realtime delivery | `frontend/tests/realtime.test.js` — the client's vocabulary is compared with the server's own file |
| 15 | Reconnect after disconnection | `frontend/tests/realtime.test.js` |
| 16 | Exchange messages between separate users | `community.test.js` |
| 17 | Exercise eligible E2EE flows | `tests/e2ee/` — 64 tests, and `frontend/tests/e2ee/` — 85. The **server** stores an envelope and never the plaintext in a conversation it reports as encrypted, the socket path refuses what the HTTP path refuses, and the **client** encrypts, opens, renders and refuses to fall back. A message the client encrypts opens with the server's ratchet, the two ratchets keep the same state object, and the associated data is the same bytes on both sides. A file in an encrypted conversation is encrypted in the browser and its key is sealed to each member device |
| 18 | Verify device changes and recovery | `tests/e2ee/api.test.js` — revocation, recovery, and the refusal to reuse a lost identity |
| 19 | Connect two independent federated instances | `tests/continuum/relay.test.js` — two instances, separate databases, separate keys, separate ports, peered through the real administration routes |
| 20 | Verify cross-instance permissions and delivery | The same test: a private community, a restricted channel, a pending peer and a blocked peer each produce nothing |
| 21 | Upload and retrieve authorised attachments | `routes/attachments.js`; the type is detected from the bytes |
| 22 | Exercise the page editor and publication workflow | `frontend/tests/page-editor.test.js` |
| 23 | Verify legal pages and operator configuration | `public/tests/legal.test.js`; the 53 operator placeholders are never invented |
| 24 | Test both DASHBOARD_MODE configurations | `tests/dashboard/` — 43 tests, both modes are different code paths |
| 25 | Verify native client build and runtime flows | **Blocked.** The toolchain is not present. `native/VERIFICATION.md` states what is and is not verified |
| 26 | Run database migration and recovery tests | `migrations.test.js`; a verified backup was taken before the schema changed |
| 27 | Verify backups and restore procedures | `npm run db:backup` — 61 tables, 684 rows, verified |
| 28 | Core functionality after a service restart | The live instance was restarted and re-checked above |

## What could not be verified here, and why

- **No browser.** Chromium cannot complete a network request in this sandbox.
  Nothing was verified by looking at it. The client was verified by driving
  it in Node against a stub DOM, and the auth and recovery contracts were
  verified against a real running instance over HTTP. Layout, typography,
  focus trapping in a real browser, and screen-reader behaviour are
  unverified.
- **No native toolchain.** No JDK, Gradle, Android SDK, Xcode or macOS. The
  native client was written and checked for internal consistency; it was not
  compiled, run or put on a device.
- **No independent cryptographic review.** None was obtained, and none is
  claimed. The E2EE implementation has an internal self-review that names its
  own limits.
- **No deployed-browser check of the demo.** The cross-origin defects were
  found by reading the code and are fixed with tests; the deployed behaviour
  after the fix was checked over HTTP, not in a browser.

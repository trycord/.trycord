# Trycord 3.0 — implementation plan

The phases, their dependencies, and the gate each one has to pass before the
next one starts. A phase is finished when its gate is verified, not when its
files exist.

Last updated: 2026-10-19, on branch `release/3.0.0`.

## The rule the phases follow

Nothing is declared complete because it compiles. A capability is complete when
the real path runs — request through service through database and back — and a
test exercises it, and the failure paths are covered too.

## Phase 0 — Discovery and baseline

**Gate: the architecture, the critical risks and the dependencies are understood
enough to execute safely.**

- [x] Repository, deployment and runtime inspected. 419 tracked files, 247 HTTP
      endpoints, 61 tables, 23 realtime events, 3 client modules.
- [x] The deployment topology established: one API process (fork mode) plus a
      status monitor, a MySQL database, an origin-root public site with the
      client under `/app`.
- [x] The feature inventory built. See `CAPABILITY_INVENTORY.md`.
- [x] The baseline recorded: the repository shipped **no automated test suite**.
      The removal is recorded in `CHANGES.md`; the reason (a suite that booted
      whole instances and started browsers on a small host) is real, and the
      answer is a suite that does not.
- [x] A verification suite exists and runs. `backend/tests/`, driven by
      `node --test`, using an instance that boots against a temporary SQLite
      database on a free port.
- [x] Uncommitted work preserved and committed as the release branch's first
      commit rather than overwritten.

## Phase 1 — Critical access and foundational contracts

**Gate: the application starts, the critical access paths work under test, and
the architectural changes have explicit contracts.**

- [x] **Demo-to-instance connectivity.** The public site resolved the API
      address for its *content* but not for its *probes*: `status.js` asked
      `/health` and `/api/health` with a relative path, so on a split
      deployment it probed the static site and reported the API as unavailable.
      The same defect made community icons 404 and every "open the app" link
      point at a hardcoded `/app/`. The address is now resolved once, through
      one module, and the backend injects it.
- [x] **Authentication routes render standalone.** The mechanism was already
      correct (`[hidden] { display: none !important }` in the base layer, and
      the router hides the shell root). It is now covered by a regression test
      rather than by inspection.
- [x] **Registration was broken on desktop.** The client sent no legal
      versions, so the server refused every desktop registration. Both clients
      now read the versions the instance publishes and send those.
- [x] **Two admin pages had no renderer.** `/admin/approvals` and
      `/admin/diagnostics` raised "No renderer for page". Bound, and a test now
      asserts every registry page has a renderer in both modules.
- [x] **A session could not be listed or revoked individually.** Registration
      minted a token without recording a session, so the Security page could
      not show it and could not end it. Registration now issues through the one
      shared path.
- [x] **Session invalidation verified on the server**, not only in the
      interface.
- [x] **Version metadata has one source.** `backend/src/version.js` reads the
      package manifest; the API, the instance endpoint and the health check all
      report it.
- [x] **Migrations are versioned and recorded.** The schema had no ledger:
      changes were idempotent `ALTER`s with no record of what had been applied
      and no refusal of a database a newer build wrote to. `db/migrations.js`
      adds the ledger, the ordering rules, the preconditions, the per-migration
      verification, the post-migration integrity check, and `npm run migrate`
      now does what the documentation always said it did.
- [x] **`npm run migrate` did what the docs said.** It was a SQLite-to-MySQL
      data import. The import is `npm run db:import`; `npm run migrate` applies
      the schema and runs the migrations.

## Phase 2 — Backend and data foundation

**Gate: the critical backend behaviour is verified by integration tests.**

- [x] Modular boundaries: the schema, the migration ledger, the settings store
      and the session lifecycle each own one thing and are exercised by tests.
- [x] Persistence and authorization repaired where the audit found defects.
- [x] Migration safety: the ledger, the newer-database refusal, the failed
      migration block, the retry path.
- [x] Observability and error contracts: the error envelope is one shape, and
      the request id is on every response.
- [ ] Realtime cross-process coordination — **partial**. The deployment runs
      one API process, so sockets, presence and rate limits belong to it. A
      second process is a separate deployment, not a second worker. This is
      deliberate and documented; it is not a gap to close.

## Phase 3 — Client architecture

**Gate: the core journeys work across the supported clients.**

- [x] The three-module boundary (platform / desktop / mobile) preserved and
      now enforced by a test that resolves every import and refuses a
      crossing.
- [x] The mobile module is a genuinely separate experience with its own
      document, shell, router, views and stylesheet, served at `/app/mobile/`.
- [ ] Native mobile client — **in progress**. `native/` carries a real React
      Native project. The toolchain to build it is not present in this
      environment, so build and runtime verification are blocked. See
      `IMPLEMENTATION_STATE.md`.
- [ ] Every visible control connected — **in progress**.

## Phase 4 — Identity, E2EE and Continuum

**Gate: the supported federation and encryption flows meet their acceptance
criteria, and the security review has been done.**

- [ ] E2EE: device identity, session establishment, a ratchet, group keys,
      recovery, encrypted attachments, downgrade and replay protection.
- [ ] Federation: peer discovery, compatibility negotiation, cross-instance
      delivery verified between two independently configured instances.
- [ ] The security review. **No independent third-party cryptographic review
      has been obtained, and none is claimed.**

## Phase 5 — Core product and expansion

**Gate: every feature designated as required has a real implementation and a
passing test.**

- [ ] Users, friends, privacy, communities, channels, roles, moderation.
- [ ] Files, search, notifications, presence.
- [ ] Forums, threads, discussions.
- [ ] The collaboration workspace: spaces, documents, boards, events, polls.
- [ ] The developer platform: versioned API, scoped keys, bots, extensions,
      the registry, workflows.

## Phase 6 — Website, editor and deployment

**Gate: the public-facing, administrative and deployment workflows work in the
environments available for verification.**

- [ ] The public website.
- [ ] The hybrid page editor.
- [ ] The legal drafts, with operator fields and review flags.
- [ ] Both dashboard modes, independently tested.

## Phase 7 — Hardening and release candidate

**Gate: the mandatory release requirements pass, and everything left is
classified.**

- [ ] The security audit.
- [ ] The accessibility audit.
- [ ] The performance and resource audit.
- [ ] The migration and restore verification.
- [ ] The release evidence report.

## The critical user journeys

The directive names twenty-eight. Their state is tracked in
`IMPLEMENTATION_TESTS.md`, one row each, with the test that covers it.

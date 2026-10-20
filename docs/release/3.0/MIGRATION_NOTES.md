# Trycord 3.0 — migration notes

Every change to the schema, the API and the deployment that an operator has
to know about.

Last updated: 2026-10-20, branch `release/3.0.0`.

## The schema is now versioned

The schema used to be applied by a set of idempotent statements with no
record of what had been applied and no refusal of a database a newer build
had written to. That is fine for a schema and not fine for everything a
schema change can involve: a data transformation that must not run twice, and
knowing what a database has actually had done to it.

`backend/src/db/migrations.js` adds the ledger:

- `schema_migrations` — one row per migration, with its name, its status
  (`applied` or `failed`), when it was applied and how long it took.
- `schema_fingerprint` — the set of tables the build believes exist, so an
  instance can be asked whether its database matches this build.

The rules the runner enforces:

1. Migrations run in ascending version order, one at a time.
2. A migration that has been applied is never applied again.
3. A failed migration blocks the ones after it, until it is retried.
4. A database whose ledger is ahead of the build is **refused**, not
   "migrated downwards".
5. Every applied migration is verified by its own check before its row is
   written, and the whole schema is checked again at the end.
6. A migration runs inside a transaction where the engine supports one for
   what it does. DDL is not transactional on MySQL, so a migration that
   creates tables says so and is written to be safely re-runnable instead.

**Nothing existing was rewritten.** The baseline schema pass is unchanged and
still idempotent; the ledger records what happened on top of it.

## The command names

| Before | Now | Why |
|---|---|---|
| `npm run migrate` — a SQLite-to-MySQL data import | `npm run migrate` — applies the schema and runs the migrations | The README and the self-hosting guide both said `npm run migrate` applied the schema. It did not. |
| — | `npm run db:import -- --from <file>` — the old behaviour | A data import has a different name from a schema migration, and a self-hoster who ran the documented command to move a database got a silent no-op |

`npm run migrate -- --status` reports what is applied and what is pending
without changing anything. `npm run migrate -- --retry` retries a migration
that is recorded as failed, after the cause has been fixed.

## The tables that are new

All additive. Nothing was renamed, dropped or retyped.

| Table | What it holds |
|---|---|
| `e2ee_devices`, `e2ee_prekeys`, `e2ee_sessions`, `e2ee_group_sessions`, `e2ee_group_keys`, `e2ee_attachments`, `e2ee_attachment_keys`, `e2ee_backups` | The encryption device registry, the prekey bundles, the ratchet sessions, the group keys and the encrypted attachments |
| `spaces`, `space_items`, `documents`, `document_revisions`, `document_comments`, `document_links`, `document_search_words` | The collaboration workspace: spaces, community documents and their history |
| `boards`, `board_columns`, `cards`, `card_labels`, `card_links`, `card_activity`, `milestones`, `card_milestones` | Boards and project management |
| `events`, `event_rsvps` | Events and their attendance |
| `polls`, `poll_options`, `poll_votes`, `poll_ballots`, `poll_results` | Polls, their ballots and their recorded results |
| `developer_api_keys`, `developer_key_usage`, `developer_subscriptions` | The developer platform's credentials, their usage and their event subscriptions |
| `extension_policy`, `extensions`, `extension_grants`, `extension_versions`, `extension_registry_cache`, `extension_storage` | The extension registry, the installed extensions, what each was granted, and their storage |
| `workflows`, `workflow_runs`, `workflow_run_steps` | Workflow definitions, their runs and each run's steps |
| `push_devices` | The devices an instance may reach a reader on |
| `schema_migrations`, `schema_fingerprint` | The migration ledger and the schema fingerprint |
| `continuum_feed_state`, and the Continuum relay tables | The federation change feed and the relayed content |

## The indexes that are new

Every one of them is a query path, not a correctness requirement, so a failure
to create one is a slow page rather than a broken one. They are created
idempotently at boot.

## The API changes

**Additive.** Every existing route keeps its path, its method and its
answer. The only exception is the one that was a defect:

| Change | Why |
|---|---|
| `GET /api/servers/:id/settings` | The community's settings could be written but not read. A member who could not read them could not follow them, and an operator who could not read them typed over whatever was really there on the next save |
| `GET /api/admin/pages/:route/revisions` now includes the body | A revision list that cannot be compared against another revision is a list of dates |
| `POST /api/me/push-devices`, `GET /api/me/push-devices`, `DELETE /api/me/push-devices/:token` | The native client had no way to register a device. The feature is off by default and the endpoint refuses an instance with push switched off |
| `POST /api/bot/*` now refuses a disabled application | The application had a `status` column that nothing read, so an administrator's "disable" did nothing and the application kept posting |
| `POST /api/dms/:id/read` now reaches the reader's own other devices | The read receipt went to the other members only, so a conversation read on the laptop stayed lit on the phone |

**New surfaces**, all under prefixes nothing used:

- `/api/e2ee` — the encryption API.
- `/api/v1` — the versioned developer surface, with its OpenAPI document.
- `/api/servers/:serverId/{spaces,documents,boards,events,polls}` — the
  collaboration workspace.

## The deployment changes

- `DASHBOARD_MODE` — `bundled` (the default) or `separate`. An unusable
  value stops the boot with a message naming the variable, the value and the
  two accepted values. In `separate` mode the main process stops serving the
  console's document and points that address at the dashboard service.
- `DASHBOARD_API_URL`, `DASHBOARD_ORIGIN`, `DASHBOARD_URL`, `DASHBOARD_HOST`,
  `DASHBOARD_PORT` — the separate service's configuration. See
  `docs/dashboard.md`.
- `DOTENV_CONFIG_PATH` — the environment file can be moved. The verification
  suite uses it to be sure it is measuring the instance it started.

## The data that was changed in production

One thing, and it was deliberate:

- The `terms` page carried a 54-byte placeholder body published on 2026-10-03,
  which replaced the whole body of the file on the live site. The site served
  the word "Section" instead of the terms. It was **unpublished**, which
  makes the file's content serve again. Nothing was deleted: the body is
  still in the row, the revision history is intact, and publishing it again is
  one action in the console.

A verified backup was taken before the schema changed:
`/home/ultim/trycord-backups/s5743_Trycord-2026-10-19T20-23-54.sql` — 61
tables, 684 rows.

## The rollback

The code rolls back by deploying the previous build. The schema does not need
to roll back with it: every change is additive, so an older build ignores the
new tables.

The one direction that is refused rather than allowed is a **newer** database
with an **older** build. The ledger detects it and the boot stops with a
message naming the version. That is the case where running forward would
move the data sideways, and it is the one case where a silent outcome would
be worst.

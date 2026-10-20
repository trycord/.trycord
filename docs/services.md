# The service map

Where every subsystem lives, what boundary it has, and what an operator has
to run.

This is a map, not a marketing diagram. The distinctions it draws are the ones
that decide what an operator deploys:

- an **in-process module** — part of the API process. It has no port, no
  listener and no separate lifecycle, and asking an operator to configure a
  port for one would be asking them to configure something that does not exist.
- an **independently runnable service** — its own process, with its own
  configuration, its own health check and its own startup and shutdown.
- a **self-hosted third-party component** — a program the operator runs, which
  Trycord integrates with but does not implement.
- a **hosted external provider** — a service the operator pays someone else
  for. It is optional, and the product works without it.

## The topology

```
                        ┌──────────────────────────────────────────┐
   browser / native ───▶│  Backend A — the API process             │
                        │  · REST API, WebSocket gateway           │
                        │  · the web client and the public site    │
                        │  · the job system                        │
                        │  · every in-process module below         │
                        └───────────────┬──────────────────────────┘
                                        │
                        ┌───────────────▼──────────────────────────┐
                        │  the database                            │
                        │  (MySQL, or SQLite for a small instance) │
                        └──────────────────────────────────────────┘

                        ┌──────────────────────────────────────────┐
   browser ────────────▶│  Backend B — the standby                 │
                        │  the same build, against the same        │
                        │  database, for failover                  │
                        └──────────────────────────────────────────┘
```

**Backend A and Backend B are the two core backends.** They are the same
build of the same application, against the same database, and the deployment
runs **one** of them at a time — the standby is a separate deployment, not a
second worker. A second API process would have its own sockets, its own
presence map and its own rate-limit counters, and a message written by one
would not reach a reader connected to the other. The process says so at boot.

**The status monitor is a second process.** It is separate so it can keep
answering while the API is restarting or down; putting it inside the API
process would lose exactly that property. It is a separate program, not a
second backend: it holds no authoritative state, writes nothing, and makes no
decisions.

## What is in the API process

Everything below runs inside Backend A. None of it has a port, and none of it
is configured with one.

| Subsystem | Module | What it owns | Its configuration | Its health |
|---|---|---|---|---|
| The API and the WebSocket gateway | `src/server.js`, `src/ws.js` | Requests, the realtime gateway, presence, rate limits | `SERVER_HOST_TYPE`, `PORT`, `TRUST_PROXY` | `/health`, `/ready`, `/api/health` |
| The schema and the migrations | `src/db/schema.js`, `src/db/migrations.js` | The tables, the indexes, the ledger, the integrity check | the database connection | the migration report in the admin console |
| Accounts, sessions, two-factor | `src/routes/auth/*`, `src/services/sessions.js`, `src/services/twofactor.js` | Registration, sign-in, sessions, recovery, second factors | `SECURITY_SESSION_TTL_DAYS`, `REQUIRE_2FA` | the account checks in the admin console |
| Communities, channels, roles | `src/services/servers.js`, `channels.js`, `roles.js`, `memberships.js` | The community model and its permissions | — | the community checks in the admin console |
| Messaging and the forums | `src/routes/messages.js`, `src/services/threads.js`, `src/services/forums.js` | Messages, ordering, threads, topics | — | — |
| Direct messages | `src/services/dms/*` | Conversations, their history and their read state | — | — |
| Files and storage | `src/services/storage/*`, `src/services/uploads/*` | The drivers, the quotas, the type detection | `STORAGE_DRIVER`, `S3_*`, `STORAGE_QUOTA_MB` | the storage entry in the provider registry |
| Search | `src/services/search-index.js` | The word index and the filters | `SEARCH_PROVIDER` | the search entry in the provider registry |
| Notifications | `src/services/notifications.js` | The records, the preferences, the quiet hours | `NOTIFICATIONS_PROVIDER` | the notifications entry in the provider registry |
| Presence | `src/ws/presence.js` | Who is where, and when that was last true | — | — |
| The job system | `src/services/jobs.js` | The durable queue, the bounded workers, the retries | `JOBS_WORKERS`, `JOBS_CONCURRENT_JOBS` | the job list in the admin console |
| Housekeeping | `src/services/retention.js` | What expires, and when it goes | `RETENTION_*` | — |
| Voice and the mesh | `src/services/voice.js`, `voice-mesh.js` | The signalling, the roster, the peer negotiation | `VOICE_VIDEO_ENABLED`, `VOICE_VIDEO_PROVIDER` | the voice entry in the provider registry |
| Mail | `src/services/mail/*` | The modes, the credentials, the delivery | `MAIL_MODE`, `MAIL_SMTP_*`, `MAIL_API_*` | the mail entry in the provider registry |
| End-to-end encryption | `src/services/e2ee/*` | The devices, the prekeys, the ratchet, the recovery | — | the diagnostics report |
| Federation | `src/services/continuum.js`, `src/services/continuum/*` | The identity, the outbox, the inbox, the relay | `CONTINUUM_ENABLED` | the Continuum page in the admin console |
| The developer platform | `src/services/developer/*`, `src/services/apiKeys.js` | The versioned surface, the credentials, the scopes | — | the key health endpoint |
| Extensions and workflows | `src/services/extensions/*`, `src/services/workflows/*` | The registry, the grants, the sandbox, the engine | the extension policy | the extensions page in the admin console |
| The collaboration workspace | `src/services/workspace/*` | Spaces, documents, boards, events, polls | — | — |
| Pages and the legal documents | `src/services/pages.js`, `src/services/pageContent.js` | The drafts, the revisions, the publication | — | the pages section in the admin console |
| The configuration centre | `src/services/settings.js` | The catalogue, the store, the precedence | the environment | the settings status endpoint |
| The provider registry | `src/services/providers/registry.js` | What every subsystem can be configured to use | — | `GET /api/admin/providers` |
| Backups | `src/services/backup.js` | The dump, its verification, its restore | — | the backup page in the admin console |
| Diagnostics | `src/services/diagnostics.js` | One report per subsystem | — | `GET /api/admin/diagnostics` |

## What is a separate process

| Service | How it is run | What it needs | What it must not do |
|---|---|---|---|
| **Backend A** | `npm start`, under pm2 | The database | — |
| **Backend B** | The same build, on another host | The same database | Run at the same time as A: the sockets, the presence and the rate limits belong to one process |
| **The status monitor** | `npm run status-monitor`, under pm2 | The instance's address | Hold state, or make decisions |
| **The separate dashboard** | `DASHBOARD_MODE=separate`, then `node src/dashboard/separate.js` | `DASHBOARD_API_URL`, `DASHBOARD_ORIGIN` | **Hold a database connection, run a job worker, or own a socket.** It is a presentation surface for the administrative console: it serves the same client tree and talks to the API over HTTP, the way a browser does. The test asserts it holds no database and no worker |
| **The TURN server** | `npm run turn` | `TRYCORD_TURN_SECRET` | Be required: a client that cannot reach a peer directly still reaches one through it, and the mesh works without it for peers that can |

## What is a self-hosted third-party component

Trycord integrates with these. It does not implement them, and it does not
require them.

| Component | What it is for | What happens without it |
|---|---|---|
| **An S3-compatible bucket** | Attachments and images on storage other than this machine's disk | The local driver is used instead. The instance works; the files are on this host |
| **A reverse proxy** | TLS, and the public origin | The server binds directly. It is reachable, but without TLS |
| **An object store behind a CDN** | Serving media from somewhere nearer the reader | Media is served by the instance |
| **A mail relay** | Delivering password resets and verification to real addresses | Mail is switched off. The instance says so, and the account routes that need it refuse with a message that says why |

## What is a hosted external provider

**None are required, and none are the product.** Every capability that could
be hosted has a first-party path: search is an index in the instance's own
database, notifications are stored in the instance and delivered over its own
gateway, storage is local disk, mail is a relay the operator runs, media is
carried between the participants.

The one place a hosted service may be used is the **S3-compatible** driver:
Amazon S3, Cloudflare R2, MinIO, Backblaze B2 and SeaweedFS all speak the
same protocol, so an operator may point the driver at whichever they run or
pay for. The driver is the same either way, and the local driver is the
default.

## The three deployment shapes

| Shape | What runs where | What it suits |
|---|---|---|
| **Compact** — the default | The API process, the monitor and the database on one host. Nothing else | A small instance on modest hardware, including a Raspberry Pi class machine. The defaults are bounded for it |
| **Modular** | The API process and the status monitor on one host; the separate dashboard on another; the database and the bucket where the operator prefers | An operator who wants the administration surface on its own origin, or who wants the media files somewhere other than the API's disk |
| **Distributed** | Backend A here, Backend B there, the database and the bucket where they belong, the dashboard wherever the operator wants it | A larger community, with a real failover story — and the state that story depends on has to be shared, which means the database and the storage have to be shared too. **Two backends and a local disk on one of them is not failover**: an attachment written on A is not on B |

## What an operator has to know before choosing the second backend

The database is shared, so the state that matters is shared. The state that
is **not** shared is in the process:

- open WebSocket connections
- the presence map
- the in-memory rate-limit counters
- the job workers

So a failover means: the standby takes the traffic, and the connections,
the presence and the counters are lost with the process that died. That is
expected and it is not a corruption. A reader reconnects, and the catch-up
cursor in the API fills the hole.

The durable work — federation delivery, retention, the search backfill, the
workspace reminders, the workflow schedules — is in the database's job table.
Two API processes polling the same table would each claim a job, and the
unique index on a run's key stops the second one doing the work twice. The
scheduler is not leader-elected, so a deployment that runs both API processes
at once is relying on that index rather than on an election.

**The deployment runs one API process.** That is a deliberate choice, and the
process says so at boot.

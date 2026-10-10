# Self-hosting Trycord

An instance is one process, one database, and a directory of uploads. Nothing
here requires the official Trycord service, a particular cloud provider, or
any central authority.

## What an operator decides

Everything configurable lives in `backend/.env` (copy `backend/.env.example`
and edit). Two settings are required: `JWT_SECRET` and the database. The rest
have defaults that work out of the box.

| Area | Settings | Notes |
|---|---|---|
| Instance | `TRYCORD_INSTANCE_ID`, `TRYCORD_NAME`, `TRYCORD_PUBLIC_URL` | Identity, used in links and the API's `/api/instance`. |
| Database | `DB_CLIENT`, `DB_FILE` or `DB_HOST`/`DB_NAME`/`DB_USER` | SQLite for small and mid instances, MySQL/MariaDB for larger. Migrations run on every boot and are idempotent. |
| Mail | `MAIL_MODE`, `SMTP_*` | `log` sends nothing, which is the default and is safe. `smtp` delivers, and is what makes email verification enforceable. |
| Storage | `STORAGE_DRIVER`, `UPLOAD_DIR` | `local` writes under `uploads/`. |
| Serving | `TRYCORD_CLIENT_DIR`, `TRYCORD_APP_MOUNT` | Where the web client is, and whether it is mounted under a prefix. |
| Features | the flags below | One switch per capability. |
| Voice | `VOICE_VIDEO_*` | Off until a media server is configured. |

## Feature flags

One switch per meaningful platform capability. Every value is `on`/`off`
(`true`/`false` and `1`/`0` also parse), blank falls back to the default, and
**anything else is a startup error** — a typo must not silently enable or
disable something.

| Flag | Default | What it does |
|---|---|---|
| `REGISTRATION_ENABLED` | on | New accounts. Off makes the instance invite-only. |
| `EMAIL_VERIFICATION_REQUIRED` | off | Whether an account must confirm an address to post. Only enforceable with `MAIL_MODE=smtp`. |
| `FILE_UPLOADS_ENABLED` | on | Uploads, including avatars and community icons. |
| `COMMUNITY_DISCOVERY_ENABLED` | on | The public discovery feed. |
| `BOTS_ENABLED` | on | Bot accounts and tokens. |
| `WEBHOOKS_ENABLED` | on | Incoming webhooks. |
| `PUSH_NOTIFICATIONS_ENABLED` | off | Browser push. Needs a push service and a public key. |

The flags are read once, at startup, by `server/src/features.js`. Nothing
else in the server reads the environment for a feature decision, so the API
routes, the realtime gateway and the client's capability discovery cannot
disagree about what is available. Restarting with a different value takes
effect immediately — there is no cache to clear.

`GET /api/voice/capabilities` is what a client reads to discover what this
instance can do. It carries no credentials and no internal hostnames: the TURN
*URL* is public by design, and its credential is minted per session by the
backend and never appears in that response.

## Voice and video

Off by default, because the default is an instance with no media server.

```
VOICE_VIDEO_ENABLED=off
```

With the flag **off**: every voice route refuses with `FEATURE_DISABLED`, the
capability response reports voice as unavailable with the reason `disabled`,
the ICE server list is empty, and text chat is entirely unaffected.

With the flag **on** but the infrastructure missing, the server **refuses to
start**. The error names exactly what is absent — for example:

```
VOICE_VIDEO_ENABLED is on, but voice cannot work:
no STUN or TURN server is configured; VOICE_VIDEO_SFU_APP_ID is not set
```

That is deliberate. A configuration that cannot work is a startup error, not a
runtime surprise discovered at the first join.

### Provider

There is exactly one provider: **Cloudflare Realtime SFU**. Set it explicitly
or leave it unset — the value defaults to it.

```
VOICE_VIDEO_PROVIDER=cloudflare
```

Its own documentation is explicit that it does not provide signalling or room
management: *"The backend holds the SFU App Secret and manages application state
and permissions"*. So Trycord's backend remains the authority on who is a user,
which community they belong to, and whether they may speak. The provider only
creates sessions and moves SDP; it never decides who may join.

```
VOICE_VIDEO_SFU_APP_ID=...
VOICE_VIDEO_SFU_APP_SECRET=...
```

Both are read from the environment and never returned by any route. The App
Secret stays on the server; a browser never sees it.

A peer-to-peer mode with no server-side routing does not exist. An earlier
version of this document described one, and it was never implemented.

### Network

```
VOICE_VIDEO_STUN_URLS=stun:stun.example.com:3478
VOICE_VIDEO_TURN_URL=turn:turn.example.com:3478
VOICE_VIDEO_TURN_USERNAME=...
VOICE_VIDEO_TURN_CREDENTIAL=...
```

At least one STUN server or a TURN URL is required when voice is on. STUN is
enough for most home networks; TURN is what gets a call through a symmetric NAT
or a firewall that blocks UDP.

The TURN URL and username are handed to clients, because a client needs them to
open a connection. The credential is minted per session by the backend — ask
`POST /api/voice/credentials` — so a client that walks away with one does not
carry standing TURN access, and it never appears in the capability response.

### Limits and sub-capabilities

`VOICE_VIDEO_MAX_PARTICIPANTS` (default 25, range 1–200) is enforced
**server-side, before a session is created**: a channel that is full answers
`ROOM_FULL` rather than letting another person connect and then dropping them.

`VOICE_VIDEO_SCREEN_SHARING` and `VOICE_VIDEO_STAGE_CHANNELS` are separately
switchable. Neither can be on while the master switch is off — a sub-flag does
not conjure infrastructure the master says does not exist.

### Replacing the provider

Everything lives in `server/src/services/voice.js`, including the provider
calls. Adding a second provider means adding its calls beside the Cloudflare
ones and a branch where the provider is selected — no interface is reserved for
it, because nothing consumes one polymorphically today.

## Backups

SQLite is a single file: stop the process, copy it, restart. MySQL uses
`backend/scripts/db-backup.js`, which is read-only, prints the target it
connected to before it reads anything, and verifies the dump afterwards.

```
node backend/scripts/db-backup.js --out /path/to/backups
```

Keep the `.gz`; it is the copy to move off the machine. Restore is
`mysql < dump.sql`, or for a fresh instance, pointing `DB_FILE` at the copy.

## Upgrading

Migrations run on every boot and are idempotent, so an upgrade is: stop, pull,
start. An instance that already has its tables is left exactly as it is; one
created new gains the current schema. The one thing that cannot be undone
without a backup is an accidental `DROP TABLE`, which is why the dump command
exists and prints what it is about to do.

Back up first, always.

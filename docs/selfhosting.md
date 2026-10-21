# Self-hosting Trycord

Two supported paths. Pick one.

| | [Docker](#method-1-docker-recommended) | [Manual](#method-2-manual-the-hard-way) |
|---|---|---|
| Setup steps | 3 | ~8 |
| Node required on the host | no | yes (>= 22) |
| Upgrades | `docker compose pull && up -d` | pull, `npm ci`, restart |
| Database backups | copy a volume | copy a file |
| Isolation | full | none |

Docker is the easy path and is what the image is built for. Choose Manual if
you need systemd units, a specific Node version, or a custom reverse proxy
layout that a container makes awkward.

---

## What you get either way

One process serves everything on a single port:

- the web client (`/`)
- the REST API (`/api/*`)
- the WebSocket gateway (`/ws`)
- the public site plus `/terms` and `/privacy`

Set `SERVER_HOST_TYPE=express` for direct exposure, or `nginx` when a reverse
proxy on the same host fronts the server (Express then binds `127.0.0.1`
instead of `0.0.0.0`).

### Before you start: JWT_SECRET is mandatory

The server has no default for `JWT_SECRET` and will not start without one.
Every instance needs a different value, and changing it later signs everyone
out and invalidates outstanding password-reset links.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Method 1: Docker (recommended)

### 1. Get the config

```bash
git clone https://github.com/trycord/.trycord.git
cd .trycord
cp .env.docker.example .env
```

Edit `.env` and set `JWT_SECRET`. That is the only required value.

### 2. Start it

```bash
docker compose up -d
```

### 3. Open it

Visit `http://your-host:9971`, create the first account, then promote it to
platform admin by adding its username to `ADMIN_USERNAMES` in `.env` and
running `docker compose restart`.

```bash
docker compose logs -f          # follow the boot log
docker compose ps               # health status
curl -fsS localhost:9971/api/health
```

`/api/health` returns `200` only when the database is reachable too, so it is
a real readiness signal rather than "the process is up".

### Where your data lives

Two named volumes, both preserved across `docker compose down` and upgrades:

| Volume | Contents | Back it up with |
|---|---|---|
| `trycord-data` | the SQLite database | `docker run --rm -v trycord-data:/data -v "$PWD":/backup alpine tar czf /backup/trycord-data.tar.gz -C /data .` |
| `trycord-uploads` | avatars and attachments | same, with `trycord-uploads` mounted at `/app/uploads` |

To restore, extract the tarball back into the volume.

### Upgrades

```bash
git pull
docker compose build --pull
docker compose up -d
```

Your volumes are untouched.

#### What the upgrade does to your database

The schema is applied at every start, and every statement in it is
idempotent — "create it if it is not there", "add the column if it is
missing" — so an upgrade cannot leave a half-created table.

On top of that, the versioned migrations run. Each one is recorded in a
`schema_migrations` table with the name, the time and how long it took, and
a migration is never applied twice. If one fails, the ones after it do not
run, and the failure is recorded with its reason.

```bash
docker compose exec backend npm run migrate -- --status
```

That reports what this build knows, what the database has had applied, and
what is pending — without changing anything. To apply:

```bash
docker compose exec backend npm run migrate
```

**Take a backup first.** The command says so, and it means it:

```bash
docker compose exec backend npm run db:backup
```

If a migration has failed and you have fixed the cause, retry it with
`-- --retry`. And if the database was migrated by a **newer** build than the
one you are running, the boot stops with a message naming the version — a
rollback needs the matching build, and moving the data sideways is worse than
not starting.

A schema change in 3.0 is additive: new tables and new columns. Nothing was
renamed, dropped or retyped, so an older build ignores the new tables and
your data does not need to move.

#### The dashboard as a separate service

By default the administrative console is served by the main process at
`/admin`, and nothing else changes. To run it as its own service on its own
origin:

```bash
DASHBOARD_MODE=separate
DASHBOARD_API_URL=https://api.your-host
DASHBOARD_URL=https://dashboard.your-host
DASHBOARD_ORIGIN=https://dashboard.your-host
CLIENT_ORIGIN=https://dashboard.your-host,https://api.your-host
```

Then run the service:

```bash
cd backend
node src/dashboard/separate.js
```

It serves the same client tree and talks to your API over HTTP, the way a
browser does. **It holds no database connection, runs no job worker and owns
no socket** — it is a presentation surface, not a second backend, and the
test asserts it. `DASHBOARD_MODE` with any other value stops the boot with a
message naming the variable and the two values it accepts.

See `docs/dashboard.md` for the full contract and `docs/services.md` for
where everything else lives.

### Using MySQL instead of SQLite

SQLite is a single file and is genuinely fine for small and mid-size
instances. For larger deployments, uncomment the MySQL block in `.env`, add
the service, and point `DB_FILE` away:

```yaml
  trycord:
    # ...
    depends_on:
      - db
  db:
    image: mysql:8
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: trycord
      MYSQL_USER: trycord
      MYSQL_PASSWORD: change-me
      MYSQL_ROOT_PASSWORD: change-me-too
    volumes:
      - trycord-mysql:/var/lib/mysql
volumes:
  trycord-mysql:
```

Set `DB_CLIENT=mysql`, `DB_HOST=db`, and the credentials in `.env`. With
MySQL you no longer need the `trycord-data` volume.

### Behind a reverse proxy

Put nginx or Caddy in front, forward both HTTP and WebSocket traffic, and set
`SERVER_HOST_TYPE=nginx` plus `TRUST_PROXY=1`. WebSocket upgrade headers are
required or the realtime gateway will not connect:

```nginx
location / {
    proxy_pass http://127.0.0.1:9971;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 7d;   # keep the socket alive
}
```

The first WebSocket frame carries a single-use ticket, so a 60s idle
`proxy_read_timeout` will look like a silent disconnect every minute.

### CLIENT_ORIGIN: who is allowed to call this instance

`CLIENT_ORIGIN` is a comma-separated allowlist of origins permitted to read
API responses. Leave it empty and the server runs a restricted development
profile (same-origin plus `localhost`). Set it and the allowlist is enforced
exactly — which is what you want on a public instance.

Three forms are accepted:

| Entry | Matches | Does not match |
| --- | --- | --- |
| `https://trycord.example` | that exact origin | any other host, scheme or port |
| `http://*.trycord.example` | `http://a.trycord.example` | `http://trycord.example` (the apex), `http://a.b.trycord.example`, `https://…` |
| `trycord://app` | the desktop app | any other host or scheme |

Rules worth knowing:

- Scheme and port must match exactly. A wildcard never bridges them.
- A wildcard covers **one** subdomain label, and never the bare apex — list the
  apex separately if you serve it.
- A bare `*` is rejected. It would be equivalent to
  `Access-Control-Allow-Origin: *`.
- Origins are compared without a trailing slash; `https://x/` and `https://x`
  are the same entry.

A realistic value for an instance that serves its own client and wants the
desktop app too:

```env
CLIENT_ORIGIN=https://trycord.example,http://*.trycord.example,trycord://app
```

### Feature flags

One switch per meaningful platform capability. Every value is `on`/`off`
(`true`/`false` and `1`/`0` also parse), blank falls back to the default, and
**anything else is a startup error** — a typo must not silently enable or
disable something.

| Flag | Default | What it does |
| --- | --- | --- |
| `REGISTRATION_ENABLED` | on | New accounts. Off makes the instance invite-only. |
| `EMAIL_VERIFICATION_REQUIRED` | off | Whether an account must confirm an address to post. Only enforceable with `MAIL_MODE=smtp`. |
| `FILE_UPLOADS_ENABLED` | on | Uploads, including avatars and community icons. |
| `COMMUNITY_DISCOVERY_ENABLED` | on | The public discovery feed. |
| `BOTS_ENABLED` | on | Bot accounts and tokens. |
| `WEBHOOKS_ENABLED` | on | Incoming webhooks. |
| `PUSH_NOTIFICATIONS_ENABLED` | off | Browser push. Needs a push service and a public key. |

The flags are read once, at startup, by `backend/src/features.js`. Nothing
else in the server reads the environment for a feature decision, so the API
routes, the realtime gateway and the client's capability discovery cannot
disagree about what is available. Restarting with a different value takes
effect immediately — there is no cache to clear.

`GET /api/voice/capabilities` is what a client reads to discover what this
instance can do. It carries no credentials and no internal hostnames: the TURN
*URL* is public by design, and its credential is minted per session by the
backend and never appears in that response.

### Voice and video

Off by default, because the default is an instance with no media server.

```
VOICE_VIDEO_ENABLED=off
```

With the flag **off**: every voice route refuses with `FEATURE_DISABLED`, the
capability response reports voice as unavailable with the reason `disabled`,
the ICE server list is empty, and text chat is entirely unaffected.

With the flag **on**, the instance has everything it needs: it ships a
STUN and TURN service, it mints the credentials, and it hands the clients the
addresses to use. There is no STUN URL to write down, no TURN URL, no
username, no password and no ICE array. Turning the flag on is the whole of
the configuration.

### The mesh, and what the deployment has to provide

The default provider is the **in-house mesh**: the media goes from peer to
peer, and the server carries the signalling and relays the bytes when a
direct route cannot be made.

```
VOICE_VIDEO_PROVIDER=mesh
```

A mesh needs two things from the deployment, and they are about the network
rather than about voice:

1. **An address the clients can reach.** The relay is published there, and
   the clients are given it. It must point straight at the instance - DNS
   only, and not through a proxy that terminates TLS, because a proxy carries
   HTTP and not the UDP a TURN service needs.

   ```
   TRYCORD_VOICE_PUBLIC_URL=https://voice.example.com
   ```

   The address is not the site's address unless the site is served directly.
   An instance behind Cloudflare, nginx or anything else that terminates TLS
   needs a name of its own for the voice stack.

2. **The relay port open to the internet.** The service listens on 3478 by
   default, and the relay uses the next hundred ports for the calls it
   relays.

   ```
   TRYCORD_TURN_HOST=::            # every interface, IPv4 and IPv6
   TRYCORD_TURN_PORT=3478
   ```

   The relay binds every interface, so the address it is published at and the
   address it listens on are separate things: it listens on everything, and it
   is published at the address above.

An instance with a public IPv6 address and a NAT-ed IPv4 publishes both, and a
client is given the address of its own family - a client on an IPv4-only
network cannot route to an IPv6 address, and the other way round. A family
with no published address is given none, and the console says so.

Where an instance has no public address of either family, the voice console
says the relay is published at an address no client can reach. That is a
deployment fact and not a setting: the alternative is a port forward on the
router, and the address a home connection has changes with the lease.

### The other providers

The Cloudflare Realtime provider and the third-party SFU are there for an
instance that wants a server to carry the media rather than the peers to
carry it between themselves. Both need credentials of their own:

```
VOICE_VIDEO_SFU_APP_ID=...
VOICE_VIDEO_SFU_APP_SECRET=...
```

Both are read from the environment and never returned by any route. The App
Secret stays on the server; a browser never sees it. They are configured in
the voice console, not here - the console is where a provider is chosen.

### A third-party relay

An instance that would rather not run its own relay can name one. The
credential it hands out is still minted per session by the backend, so a
client that walks away with one does not carry standing TURN access, and it
never appears in the capability response.

```
VOICE_VIDEO_STUN_URLS=stun:stun.example.com:3478
VOICE_VIDEO_TURN_URL=turn:turn.example.com:3478
VOICE_VIDEO_TURN_USERNAME=...
VOICE_VIDEO_TURN_CREDENTIAL=...
```

### The voice service

The STUN and TURN service runs as a process of its own, `trycord-voice` in the
pm2 ecosystem, because it fails differently from the application: the API can
be restarting while a call is still being carried.

```
pm2 start ecosystem.config.js
pm2 logs trycord-voice
pm2 describe trycord-voice
```

It reads the same `backend/.env` as the API, so the two cannot disagree about
the address or the secret, and it binds the relay port so the API does not
bind it too.

It answers a binding request on the host it runs on, and the log line says
so when it starts. That check is local: it says the service works *here*, not
that a client on the internet can reach it. The console's stack section
answers the second question, and the address it publishes is the one that has
to be reachable.

A restart of the service drops the calls it was carrying. The clients notice
- the room's membership is the server's, and a client that cannot poll it
rejoins - and nobody is left in a room that claims to have people in it who
are not there.

### Limits and sub-capabilities

`VOICE_VIDEO_MAX_PARTICIPANTS` (default 25, range 1–200) is enforced
**server-side, before a session is created**: a channel that is full answers
`ROOM_FULL` rather than letting another person connect and then dropping them.

`VOICE_VIDEO_SCREEN_SHARING` and `VOICE_VIDEO_STAGE_CHANNELS` are separately
switchable. Neither can be on while the master switch is off — a sub-flag does
not conjure infrastructure the master says does not exist.

### Optional: the status monitor

A second, independent container that checks the instance on a schedule and
serves a report on its own port. It is off by default; start it with the
override file so the monitor keeps reporting when the API container does not:

```bash
docker compose -f docker-compose.yml -f docker-compose.monitor.yml up -d
```

It reaches the API over the compose network (`http://trycord:9971`) and
publishes its report on host port `9972` (change `STATUS_MONITOR_PORT` in
`.env`). By default it checks `/`, `/health` and `/api/health`.

To have the public `/status` page read this monitor instead of probing from the
browser, set the address a browser uses and restart the API container:

```env
STATUS_MONITOR_PUBLIC_URL=http://your-host:9972
```

Leave it unset and the page keeps probing from the browser. Every value is
configurable; `docs/status-monitor.md` is the reference.

#### The desktop app and `trycord://app`

The packaged desktop client loads the renderer from `trycord://app`, a custom
application scheme, rather than from `file://`. This matters: a `file://`
document has an opaque origin, and the API responses it requests come back
without an `Access-Control-Allow-Origin` header, so the browser discards them
and the app cannot talk to the server at all. Giving the renderer a real,
deliberate origin is what makes it subject to (and passable by) an allowlist.

`trycord://app` is the app's own identity and has nothing to do with your
address. The same desktop install can point at any instance — the official one,
your own, or `http://localhost:9971` — and each instance just needs
`trycord://app` in its own `CLIENT_ORIGIN`.

So if the desktop app cannot reach your instance, add `trycord://app` and
restart. Nothing else about the app needs to change.

---

## Method 2: Manual (the hard way)

Use this when you want systemd, a pinned Node version, or a proxy layout that
does not suit a container.

### 1. Requirements

- Node.js **>= 22** (`node --version`)
- A C toolchain is only needed if `better-sqlite3` and `bcrypt` have no
  prebuilt binary for your platform: `apt install build-essential python3`
- Optionally MySQL 8. SQLite needs nothing.

### 2. Get the code

```bash
sudo git clone https://github.com/trycord/.trycord.git /opt/trycord
sudo chown -R "$USER":"$USER" /opt/trycord
cd /opt/trycord
```

### 3. Install dependencies

```bash
cd /opt/trycord/backend
npm ci --omit=dev
```

### 4. Configure

```bash
cp .env.example .env
$EDITOR .env
```

Minimum viable `.env`:

```env
JWT_SECRET=<paste the generated secret>
PORT=9971
DB_CLIENT=sqlite
DB_FILE=/opt/trycord/backend/data/trycord.db
UPLOAD_DIR=/opt/trycord/uploads
TRYCORD_INSTANCE_ID=my-instance
TRYCORD_NAME=My Trycord
```

`DB_FILE` is resolved relative to `backend/` when it is not absolute.
Put it somewhere you will remember to back up.

`UPLOAD_DIR` holds avatars, community icons and message attachments. It
defaults to `uploads/` inside `backend/`, which is fine for a quick
trial but puts user data inside the application tree. Point it somewhere
outside the checkout so an upgrade or redeploy cannot touch it.

### 5. Create the data directory and first run

```bash
sudo mkdir -p /opt/trycord/uploads /opt/trycord/backend/data
sudo chown -R trycord:trycord /opt/trycord
cd /opt/trycord/backend
node src/server.js
```

Leave `MAIL_MODE` unset (or `log`) for the first boot. With no mail transport
the server correctly does **not** ask anyone to verify an email address, and
messaging is not gated — a common source of confusion when the docs elsewhere
mention verification.

Create the first account in the browser, then stop the server.

### 6. Run it as a service

`/etc/systemd/system/trycord.service`:

```ini
[Unit]
Description=Trycord
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=trycord
Group=trycord
WorkingDirectory=/opt/trycord/backend
EnvironmentFile=/opt/trycord/backend/.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
# The uploads directory lives outside the working directory, so it has to be
# writable explicitly.
ReadWritePaths=/opt/trycord/uploads /opt/trycord/backend/data
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin trycord
sudo chown -R trycord:trycord /opt/trycord
sudo systemctl daemon-reload
sudo systemctl enable --now trycord
sudo systemctl status trycord
journalctl -u trycord -f
```

`ProtectSystem=strict` makes the whole filesystem read-only except the paths
in `ReadWritePaths`; add any others your setup needs.

To also run the status monitor, add a second unit that is this same file with
`Description=Trycord status monitor` and
`ExecStart=/usr/bin/node src/status-monitor/index.js`, then
`systemctl enable --now trycord-status-monitor`. It reads the same `.env`; set
`STATUS_MONITOR_PUBLIC_URL` there to have the public `/status` page read it.
See `docs/status-monitor.md`.

### 7. Open the firewall

```bash
sudo ufw allow 9971/tcp
```

### 8. Promote an admin

Add the username to `ADMIN_USERNAMES=alice,bob` in `.env`, then:

```bash
sudo systemctl restart trycord
```

The promotion is idempotent and re-runs at every boot, so it is safe to leave
in the file permanently.

---

## Storing files off the local disk

By default, avatars, community icons and message attachments are written under
`UPLOAD_DIR` on the machine running the server. Nothing else is required.

To keep files somewhere else, point the server at any S3-compatible endpoint.
This is not specific to one provider — Amazon S3, Cloudflare R2, MinIO and
Backblaze all work, and nothing Cloudflare-specific is required anywhere:

```ini
STORAGE_DRIVER=s3
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=trycord
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

Notes that matter:

- **Keep the bucket private.** Trycord serves every file through an
  authenticated route that checks membership first. A public bucket bypasses
  that check and exposes private attachments.
- **Path-style addressing is the default**, because R2 and MinIO require it.
  Set `S3_FORCE_PATH_STYLE=false` only for a DNS-safe bucket on Amazon S3.
- **A misconfiguration stops the server at boot**, not on the first upload.
- The server logs which driver it resolved at startup.

Verify the configuration against the target before switching a live instance
over. The signing implementation is covered by unit tests for determinism and
for sensitivity to region, object and expiry, but it has not been run against
a live endpoint in CI:

```bash
cd backend
node scripts/storage-migrate.js --dry-run
```

---

## Publishing your own policy

The Terms, Privacy, Official instance terms, Trust & Safety, Support and
Security pages ship as **templates**, because the parts that depend on you —
your legal name, your jurisdiction, your subprocessors, your retention periods,
your age threshold — cannot be filled in by the project. The parts that describe
what the software actually does are already accurate and identical on every
instance.

The unfilled parts are marked in the page and highlighted on screen, so a visitor
can see at a glance which parts of your policy you never completed.

Fill them in through **Admin Dashboard → Pages**, which is available to platform
administrators:

- The body is edited as **structured blocks** — heading, paragraph, standfirst,
  list, callout, link, divider. There is no HTML box, and the server escapes
  every value on the way out, so an administrator cannot inject a script into a
  legal page.
- **Save draft** does not change what visitors see.
- **Preview** renders exactly what publishing would produce.
- **Publish** makes it live. For a legal page this takes a typed confirmation
  and a warning, because it is immediately visible to everyone.
- Every save is kept in **revision history**. Restoring an old revision creates
  a new one; nothing is deleted.
- Publishing, unpublishing, saving and restoring are all written to the audit log.

Until a page is published for the first time it is served from the file in
`public/`, exactly as before. An instance that never opens the editor is
unaffected.

If you would rather edit the files directly, you can: the region between
`<!-- page:begin -->` and `<!-- page:end -->` is what the editor replaces.

---

## Answering a data subject request

Users can ask for their account to be deleted from
**Settings → Account → Delete my account**. The request is recorded as a GDPR
request and appears under **Admin Dashboard → GDPR requests**, where it is
always labelled `REQUESTED BY GDPR`. Administrators cannot create one or
relabel one: the type is written by the server when the user asks.

A request moves `DELETION_REQUESTED` → `UNDER_REVIEW` →
`DELETION_PROCESSING` → `DELETED`, and the user can withdraw it until it is
processed.

When the erase runs:

- **Erased** — username, email, display name, bio, avatar and banner, every
  uploaded file, sessions, friendships, friend requests and notifications. The
  username becomes a `deleted-…` placeholder so it cannot be reused.
- **Kept** — messages, and any moderation or audit record naming the account.
  The row is anonymised rather than deleted, because deleting it would cascade
  away evidence of what was done to other people. Messages resolve to a deleted
  account.
- **Transferred** — a community the account owned is handed to its
  longest-standing remaining member, so its users are not left without an owner.
  A community with nobody else in it is left on the anonymised account and named
  in the operator's report for you to deal with.

The erase also deletes the account's objects through the storage service, so it
works the same on local disk and in an S3-compatible bucket.

---

## The provider registry

Every subsystem that can be configured to use more than one implementation is
described in one catalogue, and the administrative console renders that
catalogue and nothing else. So a provider the console offers is a provider
the service will accept, and a setting the console shows is a setting that
exists.

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" \
  https://api.your-host/api/admin/providers
```

It answers, for every subsystem — storage, mail, search, notifications,
voice, STUN/TURN, push, the extension registry — the providers that exist,
which one is in force, and what state it is in:

| State | What it means |
|---|---|
| `disabled` | The subsystem is switched off, deliberately |
| `configured` | The settings are filled in, but this provider is not the one in force |
| `active` | It is in force and its configuration is complete |
| `degraded` | It is running, and something is wrong |
| `failed` | Its configuration is incomplete — the problems are listed |

A single provider can be checked for real:

```bash
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" \
  https://api.your-host/api/admin/providers/storage/s3/check
```

A check touches the network, because that is the only way to know whether a
thing works. It runs when you press the button and never on a request path.

**A secret is never returned.** The catalogue says a secret is set or that it
is not; it never says what it is.

## Verification

Whichever method you used, confirm the whole stack:

```bash
curl -fsS https://your-host/api/health     # {"ok":true,"db":"ok",...}
curl -fsS https://your-host/api/instance
curl -fsSI https://your-host/terms         # 200
curl -fsSI https://your-host/privacy       # 200
```

Then in a browser: sign in, open a community, send a message, and confirm it
appears in a second signed-in window. A message that only appears after a
reload means the WebSocket is not connecting — check the proxy
`Upgrade`/`Connection` headers and `proxy_read_timeout`.

To check the whole thing from the outside, the repository ships a suite that
starts an instance of its own against a temporary database and exercises the
journeys:

```bash
cd backend
npm test
```

It runs in about half a minute and never touches the instance you are
serving: the database is a temporary file, the port is free, and the signing
secret is the run's own.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Server exits immediately, no output | `JWT_SECRET` missing or empty |
| `unsupported DB_CLIENT=...` | `DB_CLIENT` must be `sqlite` or `mysql` |
| `database not connected` at boot | DB unreachable; check host/credentials, or that the `/data` volume is writable |
| Uploads fail with `EACCES` | `UPLOAD_DIR` is not writable by the service user (uid 1000, `node`, in the image) |
| Avatars or attachments vanished after a deploy | `UPLOAD_DIR` was not set, so uploads defaulted to `uploads/` inside the application tree and were replaced on redeploy. Point it outside the checkout and move the existing files across |
| No verification prompt, and that is fine | Expected with `MAIL_MODE` unset or `log`; set `smtp` to enable verification |
| Realtime never connects | Proxy is missing the WebSocket upgrade headers, or `proxy_read_timeout` is too low |
| `/terms` returns 404 | The `public/` directory is missing from the deployment |
| `Migration failed, target rolled back` | A row in the source violates a foreign key. Nothing was written; fix the source row or the reference and re-run |
| Messages disappear after a minute behind nginx | `proxy_read_timeout` too low; use `7d` |
| Browser client loads but every API call fails in the console | The page's origin is not in `CLIENT_ORIGIN`; add it and restart |
| Desktop app cannot connect | `trycord://app` is missing from `CLIENT_ORIGIN`; add it and restart |
| A subdomain is rejected but the apex works | `*.` covers one label only, never the apex — list both |
| `Unknown column 'seq' in 'where clause'` at startup | The database predates the canonical-ordering migration; it is applied automatically on the next start. Do not add the column by hand. |
| `this database has been migrated to version N, which is newer than this build knows about` | A newer build wrote to the database and this is an older one. Deploy the matching build, or restore a backup taken before that migration. Do not "migrate it back" — there is no backwards migration |
| `migration N failed and has not been resolved` | A migration failed and the ones after it are blocked. The failure and its reason are in `schema_migrations`. Fix the cause, then `npm run migrate -- --retry` |
| The console offers a provider the service refuses | It should not be possible — the console renders the provider catalogue and the service reads the same one. If it happens, the catalogue and the service have drifted, which is a bug worth reporting |
| The dashboard console is on the wrong origin | `DASHBOARD_MODE=separate` needs `DASHBOARD_URL` to be the origin the console is actually served from, and that origin in `CLIENT_ORIGIN` |
| The dashboard service answers 404 for everything | It is a presentation surface: it serves the client tree and the API's own routes are on the API. Point `DASHBOARD_API_URL` at the API |

## Voice and media

### One supported provider

Trycord's voice path is its own. `VOICE_VIDEO_PROVIDER=mesh` is a peer-to-peer
WebRTC mesh: the server carries the signalling, the ICE candidates and the
room state, and the media flows between the clients. Nothing about a call
leaves the host, and no account with anybody else is needed.

It suits small rooms. Media is relayed between every participant, so a room of
n people carries n×(n-1) streams; in practice that is a handful of people per
channel. A stage with many listeners and a few speakers does not work this
way, and this build says so rather than pretending otherwise.

This build used to offer a hosted SFU as a second choice. It no longer does: a
self-hosted instance should not have to send its voice to somebody else's
server. A deployment that is already configured for it keeps booting, with a
warning at startup, and the setting in the admin configuration only offers the
mesh.

Voice needs a self-hosted STUN endpoint, and (for restrictive-network clients)
a self-hosted TURN endpoint. There is NO default third-party Google STUN
fallback; `VOICE_VIDEO_STUN_URLS` defaults to `[]` and voice will refuse to
enable until it is set.

### Self-hosted STUN/TURN (Coturn)

```bash
apt install coturn

# /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
lt-cred-mech
user=trycord:STRONG_PASSWORD
realm=trycord.yourdomain
fingerprint
no-multicast-peers
no-cli
max-allocate-lifetime=3600
channel-lifetime=60
cert=/etc/letsencrypt/live/yourdomain/fullchain.pem
pkey=/etc/letsencrypt/live/yourdomain/privkey.pem

# Run:
turnserver -c /etc/turnserver.conf
```

```env
VOICE_VIDEO_STUN_URLS=stun:your-stun-host:3478
VOICE_VIDEO_TURN_URL=turn:your-stun-host:3478
VOICE_VIDEO_TURN_USERNAME=trycord
VOICE_VIDEO_TURN_CREDENTIAL=STRONG_PASSWORD
```

### Connection quality and network requirements

- **UDP outbound** from clients (random high ports) required for direct media.
- **UDP inbound to ports 3478 (STUN/TURN) and 5349 (TLS)**.
- **Public IP** recommended for the STUN/TURN host; symmetric-NAT clients will
  use relay (TURN) mode.
- **Bandwidth**: ~64 kbps up/down per audio stream; video demands 1-3 Mbps per
  stream.
- **CPU**: media encryption is handled by WebRTC in the browser for mesh; for
  the SFU path, Cloudflare owns the SFU CPU cost.
- **Relay bandwidth**: TURN-relayed streams consume 2× bandwidth at the host.

Verify before enabling voice in production:
```sh
grep -rn "google.com\|stun.l" backend/ frontend/ public/ docs/
```
Must return no hits except legitimate upstream documentation. Then confirm a
two-browser peer actually establishes media by recording a startup log: the
server emits `[voice.mesh] ... joined channel ...` for each participant.

### No mandatory external dependencies

- `VOICE_VIDEO_STUN_URLS` default: `[]` — must be set explicitly.
- `VOICE_VIDEO_TURN_URL` default: '' — no relay fallback unless configured.
- `VOICE_VIDEO_PROVIDER` default: `mesh` — the in-house path. No account with
  anybody else is needed for a call to work.
- Signaling via Trycord's WebSocket gateway (first-party, server-owned).
- All media routes (signaling, join, leave, state, credentials) defined in
  `backend/src/routes/voice.js` — none delegate to a third-party control plane.

License
-------
MIT.

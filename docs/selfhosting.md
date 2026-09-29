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
cd /opt/trycord/trycord-server
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
DB_FILE=/opt/trycord/trycord-server/data/trycord.db
UPLOAD_DIR=/opt/trycord/uploads
TRYCORD_INSTANCE_ID=my-instance
TRYCORD_NAME=My Trycord
```

`DB_FILE` is resolved relative to `trycord-server/` when it is not absolute.
Put it somewhere you will remember to back up.

`UPLOAD_DIR` holds avatars, community icons and message attachments. It
defaults to `uploads/` inside `trycord-server/`, which is fine for a quick
trial but puts user data inside the application tree. Point it somewhere
outside the checkout so an upgrade or redeploy cannot touch it.

### 5. Create the data directory and first run

```bash
sudo mkdir -p /opt/trycord/uploads /opt/trycord/trycord-server/data
sudo chown -R trycord:trycord /opt/trycord
cd /opt/trycord/trycord-server
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
WorkingDirectory=/opt/trycord/trycord-server
EnvironmentFile=/opt/trycord/trycord-server/.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
# The uploads directory lives outside the working directory, so it has to be
# writable explicitly.
ReadWritePaths=/opt/trycord/uploads /opt/trycord/trycord-server/data
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
cd trycord-server
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

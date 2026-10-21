# Trycord

A self-hostable community chat platform. Run your own instance, or use an
instance someone else runs. Your communities, users, messages, permissions
and files stay on the instance you choose.

Vocabulary: a **community** is a group of people with channels, roles and
permissions. An **instance** is one running Trycord server. A **client** is the
web app (WAC) or the desktop shell (DAC).

- `backend/` — REST API, WebSocket gateway, accounts, permissions,
  moderation, uploads, database access
- `frontend/` — the web client (desktop and mobile modules)
- `trycord-desktop/` — the desktop application, a window around that client
- `public/` — the public website and legal pages
- `docs/` — self-hosting, theming, and the architecture reference

## Quick start

```
cd backend
npm install
cp .env.example .env
```

At minimum set `JWT_SECRET` and a database profile. Generate a secret with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then:

```
npm run seed
npm start
```

The server serves the API, the web client and the public site on one port
(`http://localhost:9971` by default). The seed account is `demo` /
`demo1234` and is for local development only.

It finds the web client next to itself in the layout this repository ships with.
If your layout is different — a single directory, a checkout of only
`backend/`, or an image that copies the client somewhere else — point it
at the directory holding `index.html`:

```
TRYCORD_CLIENT_DIR=/srv/trycord npm start
```

A relative value resolves against `backend/`, not against the directory
you happened to start `node` in. If it is set to something that does not contain
`index.html`, or is set at all and no client is found, the API still runs and the
server lists every path it looked at.

## Running it

```
cd backend
npm start                                  # the API, the web client and the public site
npm run migrate                            # apply the schema to the configured database
npm run db:backup                          # a read-only dump of the live database
```

The automated check suite that used to live in `backend/scripts/check-*.js` has
been removed. It booted whole instances, rendered every route and started
browsers, and on a small host that cost more than it was worth - a restart of
the API could begin a storm of processes on a machine that was already too warm.
Verification is now done against a running instance, and `docs/verification-matrix.md`
lists what each surface is and how to exercise it.

## Clients

Trycord ships one web client under `frontend/`, with desktop browser support
and a purpose-built mobile module. A browser pointed at the instance gets
both surfaces from that one client.

The desktop application in `trycord-desktop/` is a window around the same
client: it holds no database and no authority of its own, it can be pointed
at any instance, and a release of it is attached to the releases on GitHub.
See `docs/desktop.md` for how it works and `docs/launcher.md` for the
startup layer it uses.

## Configuration

`backend/.env.example` documents every variable. The ones with no
default, where the server refuses to start without them, are `JWT_SECRET`,
`SERVER_HOST_TYPE` and the database profile. See `docs/selfhosting.md` for
deployment, including the nginx topology and the Docker volume layout,
`docs/status-monitor.md` for the optional status monitor,
`docs/backups.md` for taking a backup and putting it back,
`docs/instances.md` for running alongside other instances, and
`docs/architecture.md` for how the system is put together.

The voice subsystem runs as a process of its own and owns the instance's
STUN and TURN relay. It answers on the loopback of the machine:

```
http://127.0.0.1:9973/          # WORKING or NOT WORKING, and why
http://127.0.0.1:9973/config    # the relay's own configuration
http://127.0.0.1:9973/credentials   # a credential, minted on the spot
```

`docs/voice.md` has the whole of it, including the stunkey the credentials
are derived from and how a host outside this instance mints its own.

## Deployment

`SERVER_HOST_TYPE` selects the topology explicitly — `express` (the server is
the public endpoint) or `nginx` (a reverse proxy fronts it, and Express binds
loopback). Anything else is a startup error.

## Security

Report vulnerabilities privately as described in `SECURITY.md`. Do not open a
public issue for a security problem.

## License

MIT. See `LICENSE`.

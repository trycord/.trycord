# Trycord

A self-hostable community chat platform. Run your own instance, or use an
instance someone else runs. Your communities, users, messages, permissions
and files stay on the instance you choose.

Vocabulary: a **community** is a group of people with channels, roles and
permissions. An **instance** is one running Trycord server. A **client** is the
web app (WAC) or the desktop shell (DAC).

- `backend/` — REST API, WebSocket gateway, accounts, permissions,
  moderation, uploads, database access
- `frontend/` — the web client (also shipped inside the desktop app)
- `trycord-desktop/` — Electron shell around the same client
- `public/` — the public website and legal pages
- `docs/` — self-hosting, theming, the desktop app and its launcher, and the
  architecture reference

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

## Checks

```
cd backend
npm run check                              # schema smoke test on a throwaway SQLite
npm run check:routes                       # every client route is served
npm run check:client                       # parse every client module and resolve its imports
```

`npm run check` creates a temporary database, applies the schema, and removes
it. `check:client` parses each web-client file as an ES module and resolves its
relative imports. Use it instead of `node --check` on a `.js` client file: that
reports success for a file containing `import` statements even when the body has
a duplicate declaration, so it is not a check.

## Desktop app

```
cd trycord-desktop
npm install
npm run build:linux      # AppImage
npm run build:win        # NSIS installer and portable exe
npm run build:mac        # dmg
```

Each target builds on its own platform; cross-building from Linux is not
reliable for Windows or macOS. `npm run build` produces whatever the current
platform supports. See `docs/desktop.md` for how it is put together and
`docs/launcher.md` for the startup and update behaviour.

The packaged app picks its backend at launch, in this order:

1. `--api-url=<url>` — how a self-hoster points it at their own instance
2. the bundled `client/backend.json`

So `Trycord --api-url=https://chat.example.org` runs against that instance and
nothing else. The shipped build reaches the official instance by default, which
is a default rather than a requirement.

## Configuration

`backend/.env.example` documents every variable. The ones with no
default, where the server refuses to start without them, are `JWT_SECRET`,
`SERVER_HOST_TYPE` and the database profile. See `docs/selfhosting.md` for
deployment, including the nginx topology and the Docker volume layout, and
`docs/architecture.md` for how the system is put together.

## Deployment

`SERVER_HOST_TYPE` selects the topology explicitly — `express` (the server is
the public endpoint) or `nginx` (a reverse proxy fronts it, and Express binds
loopback). Anything else is a startup error.

## Security

Report vulnerabilities privately as described in `SECURITY.md`. Do not open a
public issue for a security problem.

## License

MIT. See `LICENSE`.

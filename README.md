# Trycord

A self-hostable community chat platform. Run your own instance, or use an
instance someone else runs. Your communities, users, messages, permissions
and files stay on the server you choose.

- `trycord-server/` — REST API, WebSocket gateway, accounts, permissions,
  moderation, uploads, database access
- `trycord-client/` — the web client (also shipped inside the desktop app)
- `trycord-desktop/` — Electron shell around the same client
- `public/` — the public website and legal pages
- `docs/` — self-hosting, and the V2 audit status

## Quick start

```
cd trycord-server
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

## Tests

```
cd trycord-server
npm test
```

Boots a throwaway server and database, runs all 14 end-to-end suites, and
cleans up afterwards. It never touches a real instance. `npm run check` is the
faster schema-only smoke test.

## Configuration

`trycord-server/.env.example` documents every variable. The ones with no
default, where the server refuses to start without them, are `JWT_SECRET`,
`SERVER_HOST_TYPE` and the database profile. See `docs/selfhosting.md` for
deployment, including the nginx topology and the Docker volume layout.

## Deployment

`SERVER_HOST_TYPE` selects the topology explicitly — `express` (the server is
the public endpoint) or `nginx` (a reverse proxy fronts it, and Express binds
loopback). Anything else is a startup error.

## Security

Report vulnerabilities privately as described in `SECURITY.md`. Do not open a
public issue for a security problem.

## License

MIT. See `LICENSE`.

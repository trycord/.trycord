# Trycord

A self-hostable community chat platform.

## What is Trycord?

Trycord is a community chat platform built around a simple idea: you should be
able to run the server yourself if you want to.

The project includes a web client, a desktop client, and a Node.js server.
The clients are access points only — they own nothing. Users, servers,
messages, permissions, and storage all live on the Trycord server you
configure, whether that's the official instance or one you host.

## Features

- Servers with invite codes, member management, and visibility controls
- Channel categories and channel-based real-time chat over WebSockets
- File attachments in channels (images, PDF, and text files) with permission-checked downloads
- Roles and granular permissions, server discovery for public instances
- Web client, desktop client (Electron), and self-hostable Node.js server
- SQLite for development, MySQL for production
- Per-instance browser state, so one client can hop between servers you run

## Quick start

You only need a client to *use* Trycord. You only need the server to
*host* an instance.

**Run the server locally (it serves the web client itself):**

```bat
cd trycord-server
npm install
copy .env.example .env
```

Edit `.env` at minimum:

```env
JWT_SECRET=<output of: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
DB_CLIENT=sqlite
DB_FILE=./dev.db
```

Then:

```bat
npm run seed
npm start
```

Open **http://localhost:9971** and log in with `demo` / `demo1234`.
(The seed login is development-only — see `trycord-server/scripts/seed.js`.)

The server binds `HOST` (default `0.0.0.0`) on `PORT` (default `9971`).
Set `HOST=127.0.0.1` for loopback only.

**Run the web client separately (optional):**

```bat
cd trycord-client
npm run serve   # 0.0.0.0:13331 by default (HOST/PORT env)
```

This serves static files only — no database, no API, no state. Point it at an
instance without rebuilding:

```bat
set TRYCORD_API_URL=https://trycord.wispbyte.app
set TRYCORD_INSTANCE_ID=official
npm run serve
```

**Run the desktop app:**

```bat
cd trycord-desktop
npm install
npm start
Trycord.exe --api-url=http://51.79.44.111:9971
```

Build a Windows installer without publishing:

```bat
npm run build:win
```

Output: `trycord-desktop/release/Trycord Setup x.x.x.exe` plus update metadata
(`latest.yml`). Publishing a release is explicit: `npm run release`
(needs `GH_TOKEN`), or push a `v*` tag and let CI do it.

## Point the client at another server

One source of truth, no rebuild needed. Precedence: `?api=` launch argument
(desktop `--api-url=`) → saved Server setting → `config.js` / runtime config
(`window.TRYCORD_CONFIG.API_URL`) → default (`http://localhost:9971`, or
same-origin when served by the server).

```js
// trycord-client/config.js — e.g.:
window.TRYCORD_CONFIG = { API_URL: 'http://51.79.44.111:9971' };
```

Or in the app: **Change** next to the server name on the login page (or
Settings → Application → Test connection). WebSocket (`ws://`/`wss://`)
derives from the same URL automatically. Only `http(s)` URLs are accepted.

## Self-hosting

Your instance, your database. There is **no bundled `server.db`** and no
silent SQLite fallback: without database configuration the server refuses to
start with a clear error.

```env
# dev: a SQLite file YOU choose
DB_CLIENT=sqlite
DB_FILE=./dev.db

# production: your own MySQL (never official credentials)
DB_CLIENT=mysql
DB_HOST=localhost
DB_PORT=3306
DB_NAME=trycord
DB_USER=trycord
DB_PASSWORD=
DB_SSL=false
```

More knobs in `trycord-server/.env.example`: per-instance `JWT_SECRET`
(required, never shared), `CLIENT_ORIGIN` (replaces open CORS),
`TRYCORD_INSTANCE_ID` / `TRYCORD_NAME` / `TRYCORD_PUBLIC_URL`,
optional `GLOBAL_TRYCORD_URL` (empty = fully independent). Migrating an old
SQLite file: `node scripts/migrate.js --from ./old.db`.

Global sync is optional and outbound-only: if the global service is down or
unconfigured, local auth/chat/channels/WebSocket keep working. Appearance
(theme/density) is shared on your device; tokens, favorites, and recents are
scoped per instance (`trycord:<instance>:…`), with one-time migration.

WispByte MySQL is only the official deployment's database — self-hosting
never requires WispByte, and official credentials are never distributed.

## Architecture

```text
Web / Desktop client (access point, no database)
        |  REST + WebSocket
        v
Trycord server (backend authority)
        |
        v
Your database (SQLite file or MySQL)
```

**`trycord-client`** — web access point. Static files only: app shell plus a
tiny static file server (`serve.js`, `:13331`) with runtime config. No
database, no API routes, no server state.

**`trycord-desktop`** — desktop access point. The same client in an Electron
window, with an auto-updater (Electron Builder + electron-updater, GitHub
Releases). Still just an access point: no database, no server logic.

**`trycord-server`** — backend authority. Handles authentication, servers,
memberships, roles, permissions, channels, messages, WebSockets, discovery,
invites, uploads, and database access (SQLite + MySQL adapters, one portable
schema).

```
trycord-server/src/
├── server.js        # boot: validate env -> connect db -> schema -> listen
├── db/              # validated config, sqlite+mysql adapters, portable schema
├── ws.js            # realtime gateway (shares the HTTP server)
├── errors.js util.js
├── middleware/auth.js serverAccess.js
├── routes/          # auth, users, servers, channels, categories, roles,
│                    # invites, messages, attachments, discover,
│                    # dms, friends, notifications, activity
└── services/        # servers, memberships, roles, permissions, channels,
                     # invites, dms, friends, notifications, discovery, uploads

trycord-client/
├── index.html       # app shell (public + authenticated regions)
├── serve.js         # access-point static server (:13331, runtime config)
├── config.js        # runtime backend config (no rebuild to change)
├── styles/          # tokens, theme, components, utilities, layout
└── js/
    ├── api.js state.js ui.js shell.js global-sync.js
    ├── router.js app.js
    ├── pages-public.js pages-home.js pages-browse.js
    └── pages-account.js pages-dms.js pages-workspace.js
```

## Official instance

- Public instance: `https://trycord.wispbyte.app`

Self-hosted servers use their own URL and database. The official instance is
simply the default destination, never the only one.

## Releases

Desktop releases live on [GitHub Releases](../../releases) with semantic
versions (`1.0.0`, `1.0.1`, `1.1.0`, …; `-beta.N` for the beta channel).
Installed desktop clients check for updates automatically and install on
restart — see Settings → About & Updates in the app.

A release is cut by pushing a version tag; CI builds, validates, and
publishes everything. Local builds never publish:

```bat
git tag v1.0.1
git push origin v1.0.1
```

Each published release must carry the installer, the update metadata
(`latest.yml`, generated by electron-builder — never written by hand),
and the blockmap, all agreeing on one version. The release workflow
fails the job if any of those are missing, before and after publishing.

## Documentation

- `trycord-server/.env.example` — every server setting, documented inline
- `DESIGN_SYSTEM.md` — client design tokens and component inventory
- `CONTRIBUTING.md` — how to work on the project
- `SECURITY.md` — how to report vulnerabilities

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and small, focused pull
requests are welcome. Please don't open PRs with unrelated drive-by changes
bundled in.

## License

MIT — see [LICENSE](LICENSE).

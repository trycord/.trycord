# .trycord — access points + optional self-hosted instances

Three different things live here. Don't mix them up:

```text
trycord-client    = WEB ACCESS POINT (static files only — no database, no API)
trycord-desktop   = DESKTOP ACCESS POINT (same client in an Electron window)
trycord-server    = OPTIONAL SELF-HOSTING BACKEND (API + WebSocket + your database)
```

A user needs only an access point to use Trycord. They need `trycord-server`
only to **self-host their own instance**. The client never owns users, servers,
messages, or any database — it talks to a configured instance over HTTP/WS.

```text
browser → https://trycord.wisp.uno (access point, :13331 internally)
              → https://trycord.wispbyte.app (official instance)

   ...or self-hosted:  chat UI → your trycord-server → YOUR database
```

## Quickstart (local development)

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

Open **http://localhost:9971** — the server also serves the web client,
so nothing else is required. Login with `demo` / `demo1234`.

The server binds `HOST` (default `0.0.0.0`) on `PORT` (default `9971`).
Set `HOST=127.0.0.1` for loopback only.

## Web access point (optional, separate from the backend)

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

Same-origin (server serves the client itself) and split-origin
(client on one domain, API on another) topologies both work; for split-origin,
set `TRYCORD_API_URL` (or `config.js`, or the in-app Server setting) and set
the server's `CLIENT_ORIGIN` to the client's origin.

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

## Desktop app (Discord-style window)

Needs a reachable instance (local or remote — it is only an access point).

```bat
cd trycord-desktop
npm install
npm start
Trycord.exe --api-url=http://51.79.44.111:9971
```

Build a single-file Windows exe:

```bat
npm run dist
```

Output: `trycord-desktop/release/Trycord-*-portable.exe`.
Verify its SHA256 before sharing; upload it to VirusTotal for a scan report.

## Layout

| Folder             | What it is                                              | Branch   |
|--------------------|---------------------------------------------------------|----------|
| `trycord-server/`  | Modular-monolith backend: API, WS gateway, your database | `server` |
| `trycord-client/`  | Web access point: app shell + static file server        | `client` |
| `trycord-desktop/` | Desktop access point: Electron window, shared client    | `client` |

`main` has everything. `server` has only the server. `client` has client + desktop.

```
trycord-server/src/
├── server.js        # boot: validate env -> connect db -> schema -> listen
├── db/              # validated config, sqlite+mysql adapters, portable schema
├── ws.js            # realtime gateway (shares the HTTP server)
├── errors.js util.js
├── middleware/auth.js serverAccess.js
├── routes/          # auth, users, servers, channels, categories, roles,
│                    # invites, messages, discover, activity
└── services/        # servers, memberships, roles, permissions, channels,
                     # invites, discovery

trycord-client/
├── index.html       # app shell (public + authenticated regions)
├── serve.js         # access-point static server (:13331, runtime config)
├── config.js        # runtime backend config (no rebuild to change)
├── styles/          # main (tokens/base), layout, components
└── js/
    ├── api.js state.js global-sync.js ui.js components.js
    ├── pages-public.js pages-home.js pages-browse.js
    ├── pages-workspace.js pages-account.js
    └── router.js app.js
```

# .trycord — Discord-like chat (server + web client + desktop app)

## How to start the server

```bat
cd trycord-server
npm install
npm start
```

Then open **http://localhost:9971** — the web client is served by the server itself,
so there is nothing else to run.

The server binds to `HOST` (default `0.0.0.0`) on `PORT` (default `9971`).
Set `HOST=127.0.0.1` in `trycord-server/.env` to listen on loopback only.

First run? Seed a demo account + server:

```bat
npm run seed
```

Login with `demo` / `demo1234`, or register your own user.
Join a server with its join code (the seed prints one, e.g. `lobby`).

Server config lives in `trycord-server/.env` (optional — defaults work).
See `trycord-server/.env.example`.

## Point the client at another server

The backend URL is centralized — one source of truth, no rebuild needed.
Precedence: `?api=` launch argument → saved Server setting →
`trycord-client/config.js` (`window.TRYCORD_CONFIG.API_URL`) → default
(`http://localhost:9971`, or same-origin when served by the server).

```js
// trycord-client/config.js — point at a remote server, e.g.:
window.TRYCORD_CONFIG = { API_URL: 'http://51.79.44.111:9971' };
```

Or in the app: click **Change** next to the server name on the login page
(or Settings → Application → Test connection), enter the URL, test it
against `/api/health`, and save. WebSocket (`ws://`/`wss://`) derives
from the same URL automatically.

## Desktop app (Discord-style window)

Needs the server running (above).

```bat
cd trycord-desktop
npm install
npm start
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
| `trycord-server/`  | Node + Express + SQLite API, WebSocket gateway, serves web client | `server` |
| `trycord-client/`  | App shell: landing, auth, home, servers, discover, join, workspace, activity, favorites, profile, settings | `client` |
| `trycord-desktop/` | Electron wrapper — real desktop window like Discord     | `client` |

`main` has everything. `server` has only the server. `client` has client + desktop.

```
trycord-server/src/
├── server.js        # wiring, static client, start
├── db.js            # sqlite open + schema + migrations
├── ws.js            # realtime gateway
├── util.js          # tokens, membership helpers
├── middleware/auth.js
└── routes/          # auth, users, servers, channels, messages, discover, activity

trycord-client/
├── index.html       # app shell (public + authenticated regions)
├── styles/          # main (tokens/base), layout, components
└── js/
    ├── api.js state.js ui.js components.js
    ├── pages-public.js pages-home.js pages-browse.js
    ├── pages-workspace.js pages-account.js
    └── router.js app.js
```

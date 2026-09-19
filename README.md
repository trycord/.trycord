# .trycord — Discord-like chat (server + web client + desktop app)

## How to start the server

```bat
cd trycord-server
npm install
npm start
```

Then open **http://localhost:3000** — the web client is served by the server itself,
so there is nothing else to run.

First run? Seed a demo account + server:

```bat
npm run seed
```

Login with `demo` / `demo1234`, or register your own user.
Join a server with its join code (the seed prints one, e.g. `lobby`).

Server config lives in `trycord-server/.env` (optional — defaults work).
See `trycord-server/.env.example`.

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

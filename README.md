# Trycord

**A self-hostable community chat platform.**

Run your own instance, use the official one, or connect the clients to a server you control. Your communities, users, messages, permissions, and files stay on the server you choose.

## What is Trycord?

Trycord is a community chat platform built to be **self-hostable from day one**.

It has three parts:

- **Web client** for browsers
- **Desktop client** for Windows and other Electron-supported platforms
- **Server** that handles accounts, communities, messages, permissions, files, and realtime communication

The clients are just clients. They don't own your data or run the backend.

You can use the official Trycord server or run your own.

---

## Features

- 💬 Realtime community chat
- 🏠 Communities with public or private visibility
- 📁 Channels and channel categories
- 👥 Member management
- 🛡️ Roles and granular permissions
- 🔗 Invite codes
- 🔎 Public server discovery
- 📎 File attachments for images, PDFs, and text files
- 💬 Direct messages and friends
- 🔔 Notifications
- ⚡ WebSocket realtime communication
- 🖥️ Web client
- 💻 Electron desktop client
- 🗄️ SQLite for development
- 🐬 MySQL for production
- 🌐 Fully self-hostable

---

# Quick Start

You only need the **client** to use Trycord.

You only need the **server** if you want to run your own instance.

## Run a server locally

```bat
cd trycord-server
npm install
copy .env.example .env
```

At minimum, configure:

```env
JWT_SECRET=<generate a random secret>
DB_CLIENT=sqlite
DB_FILE=./dev.db
```

Generate a JWT secret with:

```bat
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then start the server:

```bat
npm run seed
npm start
```

Open:

**http://localhost:9971**

The development seed account is:

```text
Username: demo
Password: demo1234
```

The seed account is for development only.

The server listens on:

```text
HOST=0.0.0.0
PORT=9971
```

For local-only access, use:

```env
HOST=127.0.0.1
```

---

# Web Client

The server can serve the web client automatically, so you don't need to set up a separate web server.

By default:

```text
http://localhost:9971
        ↓
Trycord server
        ↓
trycord-client/
```

You can also host `trycord-client/` separately on any static web host.

The client determines which Trycord server to use at runtime, so you don't need to rebuild it every time you change servers.

---

# Desktop Client

The desktop app is built with Electron.

```bat
cd trycord-desktop
npm install
npm start
```

You can point it at a specific server:

```bat
Trycord.exe --api-url=http://localhost:9971
```

Build a Windows installer:

```bat
npm run build:win
```

The installer will be placed in:

```text
trycord-desktop/release/
```

---

# Connecting to Another Server

The client can connect to different Trycord instances without rebuilding.

The server URL is resolved in this order:

1. Desktop `--api-url=` argument
2. `?api=` URL parameter
3. Saved server setting
4. Server runtime configuration
5. Default local server

The client configuration lives in:

```text
trycord-client/js/config.js
```

This means one client can be used with multiple Trycord servers.

---

# Self-Hosting

Self-hosting means **your instance, your database, your rules**.

Trycord does not require WispByte or any other specific hosting provider.

## Development

SQLite is supported for simple deployments and development:

```env
DB_CLIENT=sqlite
DB_FILE=./dev.db
```

## Production

For production, use MySQL:

```env
DB_CLIENT=mysql
DB_HOST=localhost
DB_PORT=3306
DB_NAME=trycord
DB_USER=trycord
DB_PASSWORD=
DB_SSL=false
```

There is no hidden `server.db` and no silent fallback to SQLite.

If the database isn't configured correctly, the server stops with a clear error.

More configuration options are documented in:

```text
trycord-server/.env.example
```

---

# Hosting Modes

Trycord supports two ways to expose the server.

## Express

The Trycord server handles HTTP, the API, WebSockets, and the web client directly.

```text
Internet
   ↓
Trycord / Express
   ↓
Database
```

This is the simplest option and works well for development and straightforward self-hosting.

## Nginx

For production deployments, nginx can sit in front of Trycord.

```text
Internet
   ↓
Cloudflare / HTTPS
   ↓
nginx
   ↓
Trycord / Express
   ↓
Database
```

Nginx handles the public HTTPS connection and proxies API and WebSocket traffic to Trycord.

Trycord itself still handles:

- authentication
- permissions
- communities
- messages
- moderation
- WebSockets
- database access

Nginx is only the public gateway.

---

# Architecture

```text
┌──────────────────────────┐
│     Web / Desktop        │
│         Client            │
└────────────┬─────────────┘
             │
        REST + WebSocket
             │
             ▼
┌──────────────────────────┐
│      Trycord Server      │
│                          │
│ Auth · Communities       │
│ Channels · Messages      │
│ Roles · Permissions      │
│ DMs · Friends            │
│ Discovery · Uploads      │
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│    Your Database         │
│   SQLite or MySQL        │
└──────────────────────────┘
```

### `trycord-client`

The browser client.

It contains the UI and client-side logic, but no database or server authority.

### `trycord-desktop`

The Electron version of the client.

It uses the same Trycord platform and does not contain its own backend or database.

### `trycord-server`

The backend.

It handles:

- authentication
- users
- communities
- memberships
- roles
- permissions
- channels
- messages
- DMs
- friends
- notifications
- invites
- discovery
- file uploads
- WebSockets
- database access

---

# Official Instance

The official Trycord instance is:

**https://trycord.dev**

Self-hosted instances are completely independent.

You do not need the official server to run Trycord.

You do not need WispByte to self-host Trycord.

---

# Releases

Desktop releases are published through GitHub Releases.

Public artifact names carry no version number — the product is simply Trycord:

- `Trycord.exe` — stable installer
- `Trycord-PTB.exe` — public test build

Update metadata keeps the internal version so the desktop client can resolve
updates, but no version number is shown to users.

The desktop client checks for updates automatically.

### Publishing a release

Create and push a version tag:

```bat
git tag v1.5.0
git push origin v1.5.0
```

CI then builds and publishes the release.

Local builds never publish automatically.

Each release includes:

- Windows installer
- `latest.yml`
- blockmap

The release workflow validates that all required update files exist and use the same version.

---

# Project Structure

The main directories are:

```text
trycord-server/
    src/
    scripts/

trycord-client/
    index.html
    css/
    js/

trycord-desktop/
    ...
```

Server code is organized roughly as:

```text
trycord-server/src/
├── server.js
├── db/
├── ws.js
├── middleware/
├── routes/
└── services/
```

Client code is organized as:

```text
trycord-client/
├── index.html
├── css/
└── js/
```

---

# Documentation

Useful project documentation:

| File | Purpose |
|---|---|
| `trycord-server/.env.example` | Server configuration |
| `DESIGN_SYSTEM.md` | UI design system |
| `CONTRIBUTING.md` | Development guide |
| `SECURITY.md` | Security vulnerability reporting |

---

# Contributing

Contributions are welcome.

Before making changes, please read:

```text
CONTRIBUTING.md
```

Bug fixes and focused pull requests are preferred.

Please avoid bundling unrelated changes into the same pull request.

---

# License

Trycord is licensed under the **MIT License**.

See [`LICENSE`](LICENSE) for the full license text.

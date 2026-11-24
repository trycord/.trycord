# Architecture

Trycord is a self-hosted communication server with two first-party clients and
an optional desktop shell. One instance owns its accounts, communities,
channels, files and moderation history.

## Components

| Component | Responsibility |
|---|---|
| `backend/` | REST API, WebSocket gateway, authentication, permissions, moderation, uploads and database access. Serves the web client and the public site. |
| `frontend/` | Web application client: desktop shell under `frontend/js/` and phone module under `frontend/mobile/`, over shared code in `frontend/packages/`. |
| `trycord-desktop/` | Desktop shell around the web client. No database and no independent authority over an instance. |
| `public/` | Public website and legal pages. |
| `native/` | Native client source. |
| `sdk/trycord-botjs/` | Bot SDK for the developer API. |

## Request flow

Clients talk to one Express process on port 9971. REST calls carry a JWT; the
WebSocket gateway upgrades with a short-lived ticket. Routes call services,
and services read and write through `backend/src/db/`. Client-side permission
checks shape the interface only; the server enforces every boundary.

With `SERVER_HOST_TYPE=nginx`, Express binds to loopback and Nginx is the
public endpoint. `SERVER_HOST_TYPE=express` serves traffic directly. Any other
value stops startup.

## State and data

- The database profile is set in the environment. `npm run migrate` applies the
  schema and records each migration.
- Uploaded files live under `backend/uploads/`. The instance bootstrap and any
  generated signing key live under `backend/instance/`.
- Voice signalling is handled by the API. The STUN/TURN relay runs as a separate
  process with its own HTTP interface on port 9973.
- `TRYCORD_CLIENT_DIR` locates an alternative client directory when the default
  repository layout is not used.

## Conventions

- `frontend/packages/registry.js` is the single source of truth for pages,
  routes and navigation entries.
- `frontend/assets/trycord-assets/` is the single source of truth for visual
  assets and design tokens.
- The identity is ember `#FF4D24`, charcoal neutrals and Manrope, with light and
  dark themes.
- The environment reference is `backend/.env.example`.

## Verification

See `docs/verification-matrix.md` for the commands and the surfaces they cover.

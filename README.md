# Trycord

**A self-hostable community chat platform.**

Run your own instance, or use an instance operated by someone else. Your communities, users, messages, permissions, and files remain on the instance you choose.

> **Development disclaimer**
>
> No AI was used to develop this platform's implementation. My coding style may resemble AI-generated code because I prioritize consistency, readability, documentation, and maintainability in preparation for future team development.

## Table of Contents

- [Overview](#overview)
- [Project Structure](#project-structure)
- [Quick Start](#quick-start)
- [Running Trycord](#running-trycord)
- [Clients](#clients)
- [Configuration](#configuration)
- [Voice Subsystem](#voice-subsystem)
- [Deployment](#deployment)
- [Security](#security)
- [License](#license)

## Overview

Trycord is designed around self-hosted instances and community ownership.

### Core terminology

| Term | Definition |
|---|---|
| **Community** | A group of people with channels, roles, and permissions. |
| **Instance** | One running Trycord server. |
| **Client** | An application used to access an instance, including the Web Application Client (WAC) and Desktop Application Client (DAC). |

## Project Structure

The repository is organized into distinct components, each with its own responsibilities.

```text
Trycord/
├── backend/             # REST API, WebSocket gateway, authentication,
│                        # permissions, moderation, uploads, and database access
├── frontend/            # Web client, including desktop and mobile modules
├── trycord-desktop/     # Desktop application shell
├── public/              # Public website and legal pages
└── docs/                # Self-hosting, theming, and architecture documentation
```

## Quick Start

### 1. Install dependencies

```bash
cd backend
npm install
```

### 2. Configure the environment

Create your environment configuration:

```bash
cp .env.example .env
```

At minimum, configure:

- `JWT_SECRET`
- The database profile

Generate a secure JWT secret using:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Initialize and start the server

```bash
npm run seed
npm start
```

By default, Trycord starts on:

```text
http://localhost:9971
```

The server provides the API, web client, and public website through a single port.

**Development credentials**

```text
Username: demo
Password: demo1234
```

These credentials are intended exclusively for local development.

### Client directory configuration

Trycord automatically locates the web client using the repository's default directory structure.

If your deployment uses a different layout, such as a single directory, a backend-only checkout, or a custom container image, explicitly specify the directory containing `index.html`:

```bash
TRYCORD_CLIENT_DIR=/srv/trycord npm start
```

Relative paths are resolved against `backend/`, not against the current working directory from which Node.js was launched.

If the configured directory does not contain `index.html`, or an explicitly configured client directory cannot be found, the API will still start. The server will also report every path it attempted to inspect.

## Running Trycord

The following commands are available from the `backend/` directory:

```bash
npm start
npm run migrate
npm run db:backup
```

| Command | Description |
|---|---|
| `npm start` | Starts the API, web client, and public website. |
| `npm run migrate` | Applies the database schema to the configured database. |
| `npm run db:backup` | Creates a read-only dump of the live database. |

### Verification

The previous automated checks under `backend/scripts/check-*.js` have been removed.

Those scripts booted entire instances, rendered every route, and launched browser processes. On smaller hosts, their resource consumption was disproportionate to their value and could trigger process storms during API restarts.

Verification is now performed against a running instance.

See [`docs/verification-matrix.md`](docs/verification-matrix.md) for the documented verification procedures, application surfaces, and instructions for exercising each area.

## Clients

Trycord provides a unified web client and a separate desktop application shell.

### Web Application Client (WAC)

The web client lives under `frontend/` and supports:

- Desktop browsers.
- Mobile browsers through a purpose-built mobile module.

Both experiences are served by the same client when accessing a Trycord instance.

### Desktop Application Client (DAC)

The desktop application lives under `trycord-desktop/`.

It acts as a window around the existing web client rather than operating as an independent platform.

Its responsibilities are deliberately limited:

- It does not own a database.
- It does not have independent authority over an instance.
- It can connect to any compatible Trycord instance.
- Its releases are published alongside the project's GitHub releases.

Additional documentation:

- [`docs/desktop.md`](docs/desktop.md)
- [`docs/launcher.md`](docs/launcher.md)

## Configuration

The complete environment variable reference is maintained in:

[`backend/.env.example`](backend/.env.example)

### Required configuration

The following settings have no defaults and are mandatory for startup:

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Secret used for JWT-related authentication operations. |
| `SERVER_HOST_TYPE` | Selects the server's network deployment topology. |
| Database profile | Defines the database configuration used by the instance. |

### Documentation

Additional configuration and deployment documentation:

| Document | Description |
|---|---|
| [`docs/selfhosting.md`](docs/selfhosting.md) | Deployment, Nginx topology, and Docker volume configuration. |
| [`docs/status-monitor.md`](docs/status-monitor.md) | Optional instance status monitor. |
| [`docs/backups.md`](docs/backups.md) | Database backup and restoration procedures. |
| [`docs/instances.md`](docs/instances.md) | Running multiple instances alongside one another. |
| [`docs/architecture.md`](docs/architecture.md) | Overview of the platform's internal architecture. |

## Voice Subsystem

The voice subsystem operates as a separate process and manages the instance's STUN and TURN relay functionality.

It exposes a local HTTP interface on port `9973`.

### Available endpoints

| Endpoint | Description |
|---|---|
| `http://127.0.0.1:9973/` | Reports whether the voice subsystem is working and provides diagnostic information. |
| `http://127.0.0.1:9973/config` | Returns the relay's configuration. |
| `http://127.0.0.1:9973/credentials` | Generates a credential on demand. |

The voice subsystem also uses a `stunkey` from which its credentials are derived.

For the complete configuration, implementation details, and information about how external hosts generate their own credentials, see [`docs/voice.md`](docs/voice.md).

## Deployment

The `SERVER_HOST_TYPE` environment variable explicitly selects the server's deployment topology.

Two configurations are supported:

### Express

```env
SERVER_HOST_TYPE=express
```

The Express server acts as the public-facing endpoint.

### Nginx

```env
SERVER_HOST_TYPE=nginx
```

Nginx operates as a reverse proxy in front of Express, while Express binds to loopback.

Any value other than `express` or `nginx` results in a startup error.

## Security

Security vulnerabilities must be reported privately.

Please follow the disclosure instructions in [`SECURITY.md`](SECURITY.md).

**Do not open public issues containing security vulnerabilities.**

## License

Trycord is distributed under the **MIT License**.

See [`LICENSE`](LICENSE) for the complete license text.

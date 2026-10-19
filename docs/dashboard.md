# Dashboard deployment modes

The admin console can be deployed in two ways. The choice is made by one
environment variable, and it decides which process serves the console's
pages.

```
DASHBOARD_MODE=bundled     # the main application serves the console
DASHBOARD_MODE=separate    # a separate service serves the console
```

The value is compared exactly, and an empty value means `bundled`. Anything
else stops the boot with a message that names the variable, the value and the
two accepted values. There is no silent fallback: a deployment that says
`DASHBOARD_MODE=solo` must fail rather than quietly run a mode nobody
asked for.

## The two modes

### bundled

One process carries everything. The client tree is served by the main
application, the console's pages are at `/admin` inside it, and the admin API
is at `/api/admin` in the same process, behind the same session and the same
admin guard. This is the deployment that has always existed; the mode only
makes it explicit in the logs and in the settings.

The main process serves:

| Address | What it is |
|---|---|
| `/admin`, `/admin/...` | the console's pages (the client shell) |
| `/api/admin/...` | the admin API |

### separate

Two processes. The main instance keeps the API - including the whole admin
API - and stops serving the console's document. A second process, the
dashboard service, serves the console's pages, points the client at the main
API, and answers nothing about the instance on its own.

| Address | Served by |
|---|---|
| `/admin`, `/admin/...` on the main instance | a redirect to the dashboard service, or an explanation if the service's address is not configured |
| `/admin`, `/admin/...` on the dashboard service | the console's pages (the client shell) |
| `/api/admin/...` | the main instance, unchanged |

The console's document is not duplicated: the dashboard service serves the
same client tree (`frontend/`) the main process serves. The difference is
which origin serves it and which process the session is presented to.

The client finds the API the way it always does (see
`frontend/packages/config.js`): the reader's own choice first, then
`backend.json`, then the origin that served the page, then the hosted
default. The dashboard service serves a `backend.json` naming the main API,
so a console served by it talks to the main instance.

## Environment variables

### On the main instance

| Variable | Meaning | Default |
|---|---|---|
| `DASHBOARD_MODE` | `bundled` or `separate`. Decides which process serves the console. | `bundled` |
| `DASHBOARD_URL` | The dashboard service's public origin, used to redirect the console's addresses. Only read in `separate` mode. | unset |
| `TRYCORD_PUBLIC_URL` | This instance's public origin. Used to report where the console is in `bundled` mode. | unset |

### On the dashboard service

| Variable | Meaning | Default |
|---|---|---|
| `DASHBOARD_MODE` | Must be `separate`. The service refuses to start otherwise, so two consoles cannot appear by accident. | required |
| `DASHBOARD_API_URL` | The main API's origin, e.g. `https://api.example.com`. Required. An origin, not a path. | required |
| `DASHBOARD_ORIGIN` | The origins allowed to load the dashboard, comma separated. Required, and there is no wildcard: a dashboard that serves administration pages must not be loadable from anywhere. | required |
| `DASHBOARD_PORT` | The port to listen on. `0` asks the operating system for a free one. | `9973` |
| `DASHBOARD_HOST` | The interface to accept connections on. | `127.0.0.1` |
| `DASHBOARD_URL` | The dashboard's own public origin. Used in the diagnostics and to check the API's allowlist. | unset |
| `DASHBOARD_CLIENT_DIR` | The client tree to serve. | the repository's `frontend/` |
| `DASHBOARD_REQUEST_TIMEOUT_MS` | How long to wait for the API before reporting it as not answering. | `5000` |

The service reads `backend/.env` (or the file `DOTENV_CONFIG_PATH` names), and
the environment wins over the file.

## The origin policy

Two allowlists have to agree, and a deployment that sets only one of them
fails in the browser with a CORS error that reads as a broken network.

| Side | Variable | Says what |
|---|---|---|
| The dashboard service | `DASHBOARD_ORIGIN` | which origins may load the dashboard. A request carrying an `Origin` outside the list is refused with `403 ORIGIN_NOT_ALLOWED` before it reaches anything. |
| The main instance | `CLIENT_ORIGIN` | which origins may call the API. The console's own origin has to be on this list, or the browser refuses every answer the API gives the console. |

The dashboard service checks the second half at start-up and warns when the
API does not allow the dashboard's origin:

```
[warn] the API does not allow the dashboard origin (https://dashboard.example.com).
Add it to CLIENT_ORIGIN on the main instance, or the browser will refuse every
answer the console gets.
```

Three more rules hold whatever the allowlists say:

- A request with no `Origin` header is answered. A browser does not send one
  for a navigation or a command line call, and refusing those would make the
  console unusable. It is answered without any `Access-Control-Allow-Origin`
  header, so another page still cannot read it.
- The console is never framed: `X-Frame-Options: DENY` and
  `frame-ancestors 'none'`.
- The console's document grants nothing on its own. Every piece of data it
  shows comes from the API, which decides who may see it.

## Health checks

| Path | What it answers |
|---|---|
| `/health` on the dashboard service | The dashboard's own health **and** the API's, reported separately. `200` when the API answered, `503` when it did not. |
| `/live` on the dashboard service | The dashboard's own liveness, and nothing else. Always `200` while the process runs. |
| `/health` on the main instance | The main instance's liveness. |
| `/api/health` on the main instance | The main instance's health, including its database. This is what the dashboard service probes. |

The shape of the dashboard's `/health`:

```json
{
  "ok": false,
  "service": {
    "ok": true,
    "mode": "separate",
    "contract": 1,
    "version": "3.0.0",
    "uptimeSeconds": 41,
    "apiUrl": "https://api.example.com",
    "dashboardUrl": "https://dashboard.example.com"
  },
  "api": {
    "ok": false,
    "url": "https://api.example.com",
    "status": 0,
    "latencyMs": 12,
    "instanceId": null,
    "db": null,
    "error": "the API could not be reached"
  }
}
```

`service.ok` is the dashboard, `api.ok` is the API, and the status code
follows the worse of the two. A green dashboard never hides a dead API: the
two are never merged into one answer.

## Running the separate service

```
cd backend
DASHBOARD_MODE=separate \
DASHBOARD_API_URL=https://api.example.com \
DASHBOARD_ORIGIN=https://dashboard.example.com \
DASHBOARD_URL=https://dashboard.example.com \
DASHBOARD_HOST=127.0.0.1 \
DASHBOARD_PORT=9973 \
node src/dashboard/separate.js
```

It prints what it is doing and where it is listening:

```
[info] dashboard mode: separate (the admin console is served by the separate dashboard service at https://dashboard.example.com/admin)
[info] dashboard talks to the API at https://api.example.com
[info] dashboard origin policy: https://dashboard.example.com
[info] dashboard serves the client from /srv/trycord/frontend
[info] the dashboard holds no database, runs no background jobs and owns no websocket gateway: every answer it gives comes from the API over HTTP
[info] separate dashboard listening on http://127.0.0.1:9973
```

`SIGTERM` and `SIGINT` stop it: it stops accepting, drops the idle
connections and exits.

The main instance is configured separately - it needs `DASHBOARD_MODE=separate`
and `DASHBOARD_URL` pointing at the service - and it must allow the
dashboard's origin:

```
DASHBOARD_MODE=separate
DASHBOARD_URL=https://dashboard.example.com
CLIENT_ORIGIN=https://trycord.example.com,https://dashboard.example.com
```

## Behind a reverse proxy

The service answers reads only, and it is meant to sit behind a proxy on the
same host. `127.0.0.1` is the default bind address for that reason; set
`DASHBOARD_HOST=0.0.0.0` only in a container that publishes the port
deliberately.

```nginx
server {
    listen 443 ssl;
    server_name dashboard.example.com;

    # The console's own origin is what the main instance has to allow.
    location / {
        proxy_pass http://127.0.0.1:9973;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}

server {
    listen 443 ssl;
    server_name api.example.com;

    location / {
        proxy_pass http://127.0.0.1:9971;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # The realtime gateway shares the API's port.
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

The dashboard service is told about the proxy only if the proxy is on
loopback: `TRUST_PROXY=1` makes it believe `X-Forwarded-Proto`. The main
instance needs the same setting for the same reason.

The service serves the client tree at the root of its own origin, so the
console's addresses are `https://dashboard.example.com/admin` and the assets
are beside them. A proxy that mounts it under a path prefix has to rewrite
the client's `<base>` as well, which the service does not do for it.

## What the dashboard service does not do

- **No database.** It opens no connection, runs no migration, and holds no
  query. It is started with no database configuration at all in a
  verification run, and it answers.
- **No background jobs.** It claims no work, schedules nothing, and no job
  row refers to it.
- **No websocket gateway.** It does not own a socket, a presence map or a
  rate limiter. The client connects to the **main instance's** gateway, as a
  client, with a one-use ticket from the API - exactly as it does when the
  console is bundled.
- **No authority.** It decides nothing about an account, a session, a
  moderation action or a setting. It asks the API and reports the answer.
- **No credentials.** A password is exchanged with the API and with nothing
  else. The dashboard service only ever forwards a session token, the way a
  browser does, and keeps no copy of it.

It is a presentation service for the administrative surfaces. It is not a
second backend, and it must never become one.

## The contract

`backend/src/dashboard/contract.js` is the contract between the dashboard
and the API: which endpoints the console uses, which headers it sends, how it
authenticates, and what it does when the API is down or refuses the session.
The dashboard service makes its own calls from the definitions in that file,
and the client (`frontend/packages/api.js`) makes the console's calls with the
same scheme and the same paths.

In one paragraph: the API owns the accounts, the sessions and the data, and
answers every question the console asks. A session is a bearer token, issued
by the API and presented by the browser (or by the dashboard service, on the
caller's behalf) as `Authorization: Bearer <token>`. The API refuses a
session it does not recognise with `401`, refuses a session that is not a
platform administrator with `403`, and the console shows that refusal rather
than working around it. When the API cannot be reached at all, the dashboard
service answers `502 API_UNREACHABLE` and its health check reports the API as
down; it never pretends the API answered.

## Wiring it into the server

The main instance mounts the dashboard once, after the application is
created. In `backend/src/server.js`:

```js
const app = express();
// ...
require('./dashboard/mount').mountDashboard(app, {
  appMount: listen.mount,
  dashboardOrigin: String(process.env.DASHBOARD_URL || '').trim(),
});
```

In `bundled` mode this only reports the mode. In `separate` mode it also
stops the main process serving the console's document, and points those
addresses at the dashboard service.

An unusable `DASHBOARD_MODE` has to stop the boot, and the earliest the
server can say so is before the database is connected. The check is one line,
at the top of `boot()`:

```js
require('./dashboard/mode').currentMode();
```

It throws with the same message the mount would have thrown, so a
misconfigured deployment fails before it opens a database connection.

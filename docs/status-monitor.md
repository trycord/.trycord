# Status monitor

An optional, separate process that checks an instance on a schedule and serves
the result on its own port. It is **not** part of the API server, and that is the
whole point: a monitor that runs inside the service it watches cannot tell you
the service died, because it dies with it.

```
cd backend
npm run status-monitor
```

It reads the same `backend/.env` as the API. By default it listens on
`0.0.0.0:9972` and checks three things on the instance itself:

| Target | Check | Proves |
|---|---|---|
| `website` | `GET /` returns 200 | The web server answered |
| `api` | `GET /health` returns `{ "ok": true }` | The API process is running |
| `database` | `GET /api/health` returns `{ "db": "ok" }` | One database read returned |

Those are the only health routes this instance publishes. The monitor does not
invent checks for services with no endpoint (the realtime gateway, mail, uploads,
voice), and it publishes no uptime percentage, because a durable record does not
exist. What it reports is the set of checks it actually ran.

## Endpoints

| Path | What it is |
|---|---|
| `/` | An HTML dashboard of the current state, with a meta-refresh |
| `/status.json` | The same report as JSON, for the public status page and for scripts |
| `/health` | The monitor's own liveness: `{ "ok": true, "uptimeSeconds": N }` |
| `/ready` | The monitor is serving and reports how many targets it checks |
| `/metrics` | Prometheus text: up, latency, check age and window availability per target |

`/status.json` is readable cross-origin by default, because a status report is
public, read-only information and the status page lives on a different origin
from the monitor. Narrow it with `STATUS_MONITOR_CORS_ORIGINS`.

## Configuration

Every value has a default. Precedence is **defaults → JSON file → environment**:
the environment wins, so a container can be re-pointed without editing a file,
and the file holds the target list, which is awkward as an env var.

Point at a file with `STATUS_MONITOR_CONFIG=/path/to/status-monitor.json`; see
`backend/status-monitor.example.json` for a complete one.

| Setting | Env var | Default |
|---|---|---|
| Listen address | `STATUS_MONITOR_HOST` | `0.0.0.0` |
| Listen port | `STATUS_MONITOR_PORT` | `9972` |
| Sweep interval | `STATUS_MONITOR_INTERVAL_MS` | `30000` |
| Per-check timeout | `STATUS_MONITOR_TIMEOUT_MS` | `5000` |
| Failures before *down* | `STATUS_MONITOR_FAILURE_THRESHOLD` | `2` |
| Successes before *up* | `STATUS_MONITOR_RECOVERY_THRESHOLD` | `1` |
| Slow threshold | `STATUS_MONITOR_SLOW_MS` | `1500` |
| Retained samples per target | `STATUS_MONITOR_HISTORY` | `180` |
| Dashboard title | `STATUS_MONITOR_TITLE` | `Trycord status` |
| Instance name | `STATUS_MONITOR_INSTANCE` | `TRYCORD_INSTANCE_ID` or `local` |
| Base for relative URLs | `STATUS_MONITOR_BASE_URL` | `http://127.0.0.1:${PORT}` |
| Dashboard refresh | `STATUS_MONITOR_REFRESH_SECONDS` | `15` (`0` disables) |
| Cross-origin read policy | `STATUS_MONITOR_CORS_ORIGINS` | `*` (or a comma list) |
| Target list (inline JSON) | `STATUS_MONITOR_TARGETS` | the three above |
| Target list (file) | `STATUS_MONITOR_CONFIG` | — |
| Public monitor URL | `STATUS_MONITOR_PUBLIC_URL` | unset (see below) |

## Targets

A target is an object in the JSON file (or in `STATUS_MONITOR_TARGETS`). Fields:

| Field | Applies to | Meaning |
|---|---|---|
| `id` | both | Unique name; lowercased. Defaults to a generated one |
| `name`, `description` | both | Shown on the dashboard and the public status page |
| `type` | both | `http` (default) or `tcp` |
| `enabled` | both | `false` keeps it configured but unchecked |
| `url` | http | Relative resolves against `baseUrl`; absolute is used as-is |
| `method`, `headers` | http | Request method (default `GET`) and extra headers |
| `insecure` | http | `true` skips TLS verification for a self-signed endpoint |
| `expect.status` | http | Acceptable status code, or an array of them (default `200`) |
| `expect.contains` | http | The body must contain this substring |
| `expect.json` | http | An object of dotted-path → value, compared exactly |
| `host`, `port` | tcp | The socket to open |
| `timeoutMs`, `slowMs` | both | Per-target overrides of the global values |

A `tcp` check opens a socket and closes it. It proves a port accepts a
connection, not that anything useful is behind it; use it for a service that
speaks no HTTP.

## States

State is derived from real samples and configurable thresholds, so a slow
service and a flapping one are described differently rather than both called
"down".

- **Operational** — the last check passed within the slow threshold.
- **Degraded** — a check failed but fewer than `failureThreshold` times in a
  row, or the last check passed but took longer than `slowMs`. This is what a
  single dropped request or a restart looks like.
- **Down** — `failureThreshold` consecutive failures.
- **Unknown** — no check has completed yet.

The overall state is the worst component's, and a component that has never
reported makes the overall state *degraded*, not *up*: a gap in visibility is
not a green state.

Every component carries `since` (when its state last changed), the last check's
latency, and a `window` — the samples retained, how many passed, and the
fraction. That fraction is honest but narrow: it covers the retained window
only, and the monitor says so.

## Wiring the public status page

`public/status.html` probes the instance from the browser by default. When an
operator sets `STATUS_MONITOR_PUBLIC_URL` on the **API** server, the server
stamps it into the status page as `<meta name="status-monitor">`, and
`public/js/status.js` reads the monitor's `/status.json` instead, rendering the
monitor's components, states and latencies. If the monitor cannot be reached,
the page falls back to the browser probes and says so.

A relative value (for example `/status-api`, when the monitor is reverse-proxied
under the same origin) is kept relative and needs no CORS:

```nginx
location /status-api/ {
    proxy_pass http://127.0.0.1:9972/;
}
```

Leave `STATUS_MONITOR_PUBLIC_URL` unset and the page behaves exactly as it did
before; the monitor can also run purely for `/metrics` and `/status.json`,
scraped by an external system.

## What it does not do

- It does not prove a feature works, only that one narrow check passed.
- It holds its history in memory. Restarting it starts the window over; there
  is no database and no permanent incident log.
- It does not monitor itself from outside. If the whole host is down, nothing
  here answers.

## Verifying it

```
cd backend
node scripts/check-status-monitor.js
```

The check drives the real config loader, the real state machine (against
injected checks and a frozen clock) and the real HTTP server (against a stub
upstream that is made to fail on demand), then asserts that the public status
page is wired to the monitor.

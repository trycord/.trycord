# Desktop architecture

What the desktop application is, and how it is put together. Reference, not a
plan — where something is unusual, the reason is recorded next to it.

## What it is

Electron. The desktop app is an **access point**: a window that loads the same
web client the browser gets, with no database, no server state and no backend
authority of its own. It has never had a desktop-only UI and should not grow
one.

| | |
|---|---|
| Framework | Electron 44 |
| Updater | `electron-updater` 6.x, GitHub Releases provider |
| Entry point | `main.js` |
| Files | `main.js`, `updater.js`, `preload.js` |
| Version source | `package.json` `version` — the only place it lives |
| Platforms built | Windows (NSIS + portable), Linux (AppImage) |

## The renderer origin

The client is served from `trycord://app`, not `file://`.

This is the load-bearing decision in the whole desktop app. A `file://`
document has an opaque origin, and measured against a real endpoint the
renderer sends **no `Origin` header at all** — so a server with `CLIENT_ORIGIN`
configured emits no `Access-Control-Allow-Origin`, and the browser discards
every API response. The desktop app simply could not talk to a server that had
`CLIENT_ORIGIN` set, whichever instance it pointed at.

`trycord://app` is a real, allowlistable origin and it is **independent of the
backend**: one renderer origin connects to any number of instances. Each
instance just has to list this one origin in its own `CLIENT_ORIGIN`.

Security is fully on. This is not `webSecurity: false`; only the origin changes.

Deep routes resolve to the client shell, because routes are paths rather than a
hash and there is no `trycord://app/settings` file — without this, reloading a
deep link is a blank window.

## Backend precedence

Resolved once, at launch:

1. `--api-url=<url>` — how an operator points the build at their own instance
2. the bundled `client/backend.json`
3. otherwise the client's own chain decides

So a self-hoster runs `Trycord --api-url=https://chat.example.org` and gets
their instance. The shipped build reaches the official one by default, which is
a default and not a requirement.

## The updater

`updater.js`. Packaged builds only — `npm run dev` never contacts an update
server, which is what keeps development from updating itself from production.

It never blocks launch. Every failure is logged and classified, then reported
to the renderer:

| kind | meaning |
|---|---|
| `missing-metadata` | the release carries no `latest.yml` — a pipeline problem, not a broken app |
| `offline` | DNS or connection failure, update host unreachable |
| `unknown` | anything else; detail stays in the main-process log |

It never touches server configuration, databases or the configured API URL.
Updates touch the desktop application only.

## Update source configuration

`package.json` → `build.publish` holds the provider, owner, repo and channel.
`updater.js` reads the channel from `updater-prefs.json` in `userData` and
applies it to `autoUpdater.channel` / `allowPrerelease`.

The application does not name a domain itself. `PROVIDER`, `REPO_OWNER` and
`REPO_NAME` in `updater.js` exist so the runtime can report which source it is
using and for what reason, and an independently operated build changes them or
its own `publish` block. Nothing else in the application depends on which
instance the *updater* talks to — that is separate from which *instance* the
client connects to, and the two never meet.

## Platform behaviour

Not identical, and the differences matter:

- **Windows** — full lifecycle: check, download, install, restart. NSIS.
- **macOS** — `electron-updater` supports it, but auto-update **requires a
  signed app**. No signed macOS build is published.
- **Linux** — Electron's autoUpdater has **no working Linux path**. AppImage is
  published for download, and updates are expected to come from the
  distribution method the user chose, not from the app.

`linux-updates` is therefore not configured, and claiming otherwise would be
claiming a feature that does not work.

## Signing

`CSC_LINK` and `CSC_KEY_PASSWORD` are optional repository secrets. Unset,
builds are unsigned and still install, with a platform warning.

## Release

Tag-driven, `vX.Y.Z`. Ordinary pushes never publish.

Per platform: build without publishing → `npm run validate:release` → publish
→ verify the published assets exist. The gate refuses to publish if the git tag
does not match the version in `package.json` — a `v1.6.4` tag once shipped a
1.6.3 build because every other check compared the artifacts to `package.json`
and none compared `package.json` to the tag.

`GH_TOKEN` must be present as a repository secret or the publish step fails
after the build, leaving a draft release.

## Startup

One window, created when the app is ready. No launcher window in the current
build — see `LAUNCHER.md` for the startup layer added on top of this.
# The Trycord desktop application

The desktop app is an **access point**: a window that loads the same web
client the browser gets. It holds no database, no server state and no
authority of its own, and it has no desktop-only interface.

```
trycord-desktop/
  main.js              the window, the trycord:// protocol, the single instance
  preload.js           the one thing the renderer is given: the instance's address
  launcher.html        the startup layer
  launcher.js
  launcher-preload.js
  updater.js           the update check, and the three ways it can fail
  electron-builder.yml the build
  scripts/
    stage-client.mjs   copies the web client out of the repository
    validate-release.mjs  the gate a release has to pass
    check-desktop.mjs  the static check, for a machine with no Electron
```

## Running it

```bash
cd trycord-desktop
npm install
npm run dev
```

`npm run dev` stages the client and opens the application. The client is
copied out of the repository's `frontend/` tree, so the application is always
the client of the tree it was built from.

## Pointing it at an instance

The order is the documented one:

1. `--api-url=https://chat.example.org` — how an operator points the build at
   their own instance;
2. `client/backend.json` — the address the build carries;
3. otherwise the client's own chain decides.

```bash
npm run dev -- --api-url=https://chat.example.org
```

The instance has to allow the desktop origin:

```
CLIENT_ORIGIN=trycord://app
```

## Why the client is served from `trycord://app`

A `file://` document has an opaque origin, and measured against a real
endpoint the renderer sends **no `Origin` header at all** — so a server with
`CLIENT_ORIGIN` configured emits no `Access-Control-Allow-Origin`, and the
browser discards every API response. The desktop app simply could not talk to
a server that had `CLIENT_ORIGIN` set, whichever instance it pointed at.

`trycord://app` is a real, allowlistable origin and it is **independent of
the backend**: one renderer origin connects to any number of instances. Each
instance just has to list this one origin in its own `CLIENT_ORIGIN`.

Security is fully on. This is not `webSecurity: false`; only the origin
changes.

## Building a release

```bash
npm run build:win       # Windows: an installer and a portable file
npm run build:linux     # Linux: an AppImage
npm run validate:release
npm run release
```

The gate refuses a release whose artefacts do not say what they should: the
installer is there and is not empty, the update metadata is there, and the
version in the artefacts, in `package.json` and in the git tag are the same
number. The last one matters because a `v1.6.4` tag once shipped a 1.6.3
build — every other check compared the artefacts to `package.json`, and none
compared `package.json` to the tag.

The release is published by `.github/workflows/release-desktop.yml`, which runs
on a version tag and does the same steps in order: build, validate, publish,
verify what was published.

## Updates

The updater talks to the GitHub release of this repository. It never blocks
the launch, it never touches the server configuration, the database or the
address the client talks to, and every failure is classified:

| kind | meaning |
|---|---|
| `missing-metadata` | the release carries no `latest.yml` — a pipeline problem, not a broken app |
| `offline` | DNS or connection failure, the update host unreachable |
| `unknown` | anything else; the detail stays in the main-process log |

macOS auto-update requires a signed application, and no signed macOS build is
published. Linux has no working auto-update path in Electron, so the AppImage is
distributed by download.

## The check

```bash
npm run check
```

It reads the application the way the release reads it: every import resolves,
every file the build needs is there, the scripts the release calls exist, the
renderer origin is privileged as it has to be, and the version matches the
product's. It exists because this environment has no Electron and no display:
the native client's check is the same idea.

## Licence

AGPL-3.0-or-later, the same as Trycord itself.

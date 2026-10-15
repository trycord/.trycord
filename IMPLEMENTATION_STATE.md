# Implementation state

Resumable record for the Trycord reforge. The directives ask for six records; to avoid
duplicating what already exists they are consolidated here, with pointers:

- **plan + state + decisions** — this file.
- **capability inventory** — `docs/frontend-modularization-audit.md` (frontend),
  `docs/community-channel-audit.md` (community/channel family), and
  `docs/architecture.md` (system). Do not fork a second inventory.
- **tests** — `docs/verification-matrix.md` and the checks under `backend/scripts/`.
- **migration notes** — this file, "Migrations" section.

Update this file after every meaningful unit of work, before stopping.

## Current phase

Frontend modularization directive — **Phases A (audit), B (shared platform
extraction), D (Mobile module), E (serving) and F (retire the desktop responsive layer)
are complete**. The nonvisual platform lives in `frontend/packages/`; the Desktop
presentation is the desktop module at `frontend/js/`; the Mobile module is a second,
independent entry at `frontend/mobile/` with its own document, entry module, shell, view
tree and stylesheet. Both are served by `serve-client.js` from one origin. The Desktop
module's own phone arrangement (`frontend/js/presentation.js` and
`frontend/css/mobile.css`) is gone; a phone is the Mobile module, and each front door
hands a reader to the other module through `frontend/packages/chooser.js`.

Delivered in earlier phases: the community/channel route rework and the admin-settings
expansion.

## Last verified baseline

- `npm run check` (backend) — **green**, including the new `check-backend-agnostic`
  check, plus the mobile branches of `check-mount`, `check-client-modules`,
  `check-client-load`, `check-client-bindings`, `check-client-styles` and
  `check-doc-counts`.
- `check:render` (Desktop) — **green, 117 assertions.**
- `check:mobile-render` (Mobile) — **green, 62 assertions**; boots a throwaway backend,
  loads `frontend/mobile/index.html` in jsdom, imports the mobile entry, seeds a
  community and a message, and renders every routable mobile page and every
  community-settings section.
- `check:mobile-layout` — **green**; asserts the Mobile module's composition from its own
  built stylesheet (one layer over the shared tokens, no desktop selector leaking in,
  `[hidden]` authoritative, thumb-sized targets, safe-area insets, bottom sheets).
- `check:chooser` — **green**; pins the module-selection decision (override over viewport,
  invalid values rejected) and the sibling-mount round trip, and that both entries hand off
  through `frontend/packages/chooser.js` rather than hand-building the other's path.
- `check:graph` — **green**; every import the server is asked for is one it serves.
- Client module count **58** (`frontend/js` + `frontend/packages` + `frontend/mobile`).

## What Phases D and E did

- Created `frontend/mobile/` as a real module: `index.html`, `js/main.js`,
  `js/shell.js` (app bar + view + composer + bottom tab bar), `js/router.js`,
  `js/components.js` and `js/views/` (home, dms, messages, notifications, friends,
  discover, menu, profile, plain, auth, community, settings, admin). It imports only
  `frontend/packages/`.
- Added `frontend/mobile/css/mobile.css` and a second `app.css` bundle built by the
  same `frontend/scripts/build-css.js`, plus `frontend/mobile/backend.json` (the mobile
  document fetches it relative to its own root).
- Wired `serve-client.js` for the mobile document, deep links, its assets and its
  `backend.json`, at the origin root and under the configured mount; the base is
  stamped per request.
- Bound the mobile renderer table through the same `registry.bind()`; mobile pages opt
  into the tab bar with `nav.mobile`, and community routes use `sidebar: 'community'`.
- Implemented the mobile-to-desktop front door (chosen override `desktop` reloads into
  the desktop document). Desktop-to-mobile followed in Phase F.
- Added `check-mobile-render`, `check-backend-agnostic` and the mobile branches of the
  existing per-module checks.

## What Phase F did

- Deleted the Desktop module's phone arrangement: `frontend/js/presentation.js` and
  `frontend/css/mobile.css`, and removed `mobile.css` from the desktop `LAYERS` in
  `frontend/scripts/build-css.js`. `frontend/css/app.css` is now the desk composition and
  nothing else.
- Rewrote `frontend/js/shell.js` for Desktop-only composition: no tab bar, no drawer, no
  nav toggle/back button, no slide transitions, no `data-presentation`; the leading
  control is the spine collapse. Removed `data-presentation` from the `frontend/index.html`
  bootstrap and the desktop phone-layer rules (tab bar, toggle, drawer, scrim) from
  `frontend/css/shell.css` and the now-dead `--tabbar-h` from `frontend/css/tokens.css`.
- Added `siblingMount(entry, base)` to `frontend/packages/chooser.js` as the one place
  that computes the other module's mount, and refactored both entries onto it. The
  Desktop entry hands a phone to the Mobile document at its front door
  (`frontend/js/main.js#handoffToMobile`) and the Mobile module hands a reader who chose
  "desktop site" back (`frontend/mobile/js/main.js#handoff`), both before any chrome is
  built; deep links are already module-addressed and never bounce.
- Added `check-mobile-layout.js` and `check-chooser.js` checks. Retargeted
  `check-mobile-layout.js` from the retired desktop phone layer to the Mobile module's own
  built stylesheet; `check-chooser.js` pins the module-selection decision and the sibling
  mount. Made `check:desktop-shell` the desktop-only check. Removed the phone-composition
  assertions from `check-render.js` and the `data-presentation` faking from the browser
  tools.

## What Phase B did

- Created `frontend/packages/` and moved the 13 nonvisual modules there: `api`,
  `config`, `store`, `state`, `realtime`, `format`, `media`, `dom`, `icons`, `nav`,
  `theme`, `crash`, `registry` (from `frontend/js/pages/`).
- Rewrote every importer by resolving each specifier (115 rewrites) — plus three
  **dynamic** `import('../store.js')` calls the static pass missed, which `check:graph`
  caught (see the lesson under Decisions).
- Updated every check that hard-coded a moved path, and the checks that scan the client
  roots now read `frontend/js` **and** `frontend/packages`.
- Added `backend/scripts/check-frontend-modules.js` and wired it into `npm run check`.

## Active task (next)

Frontend modularization **Phase F is complete** (see below). Remaining work is operational:
commit Phase F, then push once the user supplies credentials. The DB wipe of test /
keyboard-spam accounts is pending explicit user go-ahead (see "Pending, user-requested").

## Decisions (with evidence)

- **Frontend is now two independent modules over one platform.** `frontend/packages/`
  is the shared, nonvisual platform; `frontend/js/` is the Desktop module and
  `frontend/mobile/` is the Mobile module, each with its own entry document, entry
  module, shell, view tree and stylesheet bundle. Evidence:
  `backend/scripts/check-frontend-modules.js` (the boundary), `backend/scripts/check-mobile-render.js`
  (the second module renders). The old single responsive tree (`js/presentation.js` +
  `css/mobile.css`) was the Desktop module's phone arrangement and was retired in Phase F.
- **A render check is not optional for a second module.** `check-mobile-render`
  found that `screen(...)` accepted one child while every mobile renderer passed
  several, so each screen drew its hero and silently dropped the rest. Parsing,
  import-resolution and stylesheet checks all stayed green. Evidence:
  `frontend/mobile/js/views/util.js`, and the "eleven settings sections render eleven
  distinct screens" assertion that is now its regression test. This is why the mobile
  module has its own jsdom render check rather than relying on the desktop one.
- **The client names exactly one backend, in one place.** `check-backend-agnostic.js`
  enforces that only `packages/config.js` mentions a production host, that one module
  stores the chosen address, that one module attaches the `Authorization` header, that
  the socket derives from the resolver, and that both modules ship the same
  `backend.json`. A presentation component that hardcodes an address is how a token
  reaches the wrong instance silently.
- **No bundler is introduced.** "Independent builds" = independent entry documents,
  main modules, shells, view trees and CSS bundles over one `packages/` tree. Evidence:
  audit §1.6, A5.
- **Module selection = single origin, device-detected with a remembered, explicit
  override.** Rationale: matches the existing single-origin serving; no DNS/host work.
  The choice is made once, at a module's front door, by `frontend/packages/chooser.js`
  (`viewportWantsMobile()` + the stored override), which also computes the sibling mount;
  a deep link is already module-addressed and never bounces. Alternative (a `m.` host) is
  the only open operator decision. Evidence: audit §4, `frontend/js/main.js`,
  `frontend/mobile/js/main.js`.
- **`server/` is a dead second backend** (not running, older commits). Recorded, not
  touched. Evidence: audit A1.
- **Desktop stays at `frontend/js/`; `mobile/` is the new tree.** The literal `desktop/`
  rename buys nothing and would touch every check and served path again; the boundary is
  enforced by root, not by name. Evidence: `backend/scripts/check-frontend-modules.js`.
- **A specifier rewrite must resolve dynamic `import()` too.** Phase B missed three
  `await import('../store.js')` calls in `frontend/js/views/community.js`; the live
  client broke until `check:graph` caught the 404. The boundary check now reads static
  and dynamic imports; the module-graph check is the backstop over HTTP.
- **Voice/channel-type design (delivered):** channel type is chosen at creation and may
  be changed while no voice session is live; voice/stage stay constructible even when
  voice is off; the editor states why. Evidence:
  `backend/src/services/channels.js`, `frontend/js/views/community.js`.
- **Do not silently change operator configuration.** `VOICE_VIDEO_ENABLED=off` and the
  absent SFU/STUN credentials are surfaced, not edited.

## Blockers

- **Publishing**: `git push` to `origin` has no credentials on this host (no credential
  helper, no `.netrc`, no `gh`, no SSH key, no env token). Commits stay local until the
  user authenticates. The Cloudflare repo (`~/.trycord-cloudflare`) is 2 commits ahead
  of its remote and also cannot be pushed without credentials; its local `dist/` is
  stale.
- **Voice (D7)**: enablement needs an operator decision plus Cloudflare Realtime SFU
  credentials and at least one STUN/TURN URL.
- **Voice media path**: cannot be exercised without a live SFU; only the data/routing
  contract is verifiable here.

## Pending, user-requested

- **Wipe test / keyboard-spam accounts** once implementation work is done. Identify from
  the `users` table; never touch an admin, and confirm the list before deleting.

## Migrations

- No schema changes. The channel `type` column already exists
  (`backend/src/db/tables/communities.js`).
- Frontend Phase B moves files **within** `frontend/`; no persisted data is affected.

## Next action

Phase F is done and committed locally. Next: `git push` once the user supplies
credentials (see Blockers). Optionally regenerate `docs/verification-matrix.md` with
`npm run check:matrix` (not in CI).

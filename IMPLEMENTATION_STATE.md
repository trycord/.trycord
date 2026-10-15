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

Frontend modularization directive — **Phase A (audit) and Phase B (shared platform
extraction) complete**. The nonvisual platform now lives in `frontend/packages/`; the
Desktop presentation is the desktop module at `frontend/js/`; both are served exactly as
before. **Next is the Mobile rebuild (Phase D), then serving (Phase E) and retiring the
responsive layer (Phase F).**

Delivered in earlier phases: the community/channel route rework and the admin-settings
expansion.

## Last verified baseline

- `npm run check` (backend) — **green**, including the new `check-frontend-modules`
  boundary check and `check:doc-counts`.
- `check:render` — **green, 128 assertions.**
- `check:graph` — **green**; every import the server is asked for is one it serves.
- Client module count unchanged at **38** (`frontend/js` 25 + `frontend/packages` 13).

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

Frontend modularization **Phase D** — build the Mobile module under `frontend/mobile/`:
its own entry, shell, navigation, view tree and CSS bundle, importing only
`frontend/packages/`. Then **Phase E** (serve both entries; Cloudflare build; Electron)
and **Phase F** (delete `frontend/js/presentation.js` and `frontend/css/mobile.css`).
Desktop is not touched except where a boundary needs it. See §5 of the audit.

## Decisions (with evidence)

- **Frontend is one responsive tree today, not two modules.** `index.html` writes
  `data-presentation`, `js/presentation.js` drives the drawer, `css/mobile.css` is the
  phone arrangement. Evidence: audit §1.5.1. This is what the directive replaces.
- **No bundler is introduced.** "Independent builds" = independent entry documents,
  main modules, shells, view trees and CSS bundles over one `packages/` tree. Evidence:
  audit §1.6, A5.
- **Module selection = single origin, device-detected with a remembered, explicit
  override.** Rationale: matches the existing single-origin serving; no DNS/host work.
  Alternative (a `m.` host) is the only open operator decision. Evidence: audit §4.
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

Begin Phase D: create `frontend/mobile/` with a real (not scaffolded) entry and shell,
then its screens, importing only `frontend/packages/`. Mobile reaches the platform
through the same `packages/` contracts; it must not import `frontend/js/`. Then Phase E
serving and Phase F cleanup.

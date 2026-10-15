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

Frontend modularization directive — **Phase A (audit) complete**:
`docs/frontend-modularization-audit.md`. **Phase B (shared package extraction) not
started.**

Superseded but delivered: the community/channel route rework (Phase A/C) and the
admin-settings expansion. Both are in the verified baseline commit.

## Last verified baseline

`backend && npm run check` — **green** (whole `&&` chain, includes `check:flows` = 77,
`check:doc-counts`, and the client module graph). `check:render` was green at 128 in the
previous unit of work; it is re-run as part of Phase B's gate.

## Active task (next)

Frontend modularization **Phase B** — extract the shared, nonvisual platform:

1. Create `frontend/packages/` and move: `api.js`, `config.js`, `store.js`, `state.js`,
   `realtime.js`, `format.js`, `media.js`, `dom.js`, `icons.js`, `nav.js`, `theme.js`,
   `crash.js`, `pages/registry.js`.
2. Rewrite every importer (scripted, resolving specifiers — not a blind `sed`).
3. Update the checks that hard-code `frontend/js` (`check-client-load`, `-bindings`,
   `-singletons`, `-headings`, `-registry`, `-modules`, `check-doc-counts`) to the new
   client roots, and keep the pinned module count honest.
4. Add `backend/scripts/check-frontend-modules.js` for the dependency rules (desktop/
   mobile never import each other; packages import neither).
5. Gate: `npm run check` + `check:render` green, same assertion counts.

Desktop behaviour must not change in Phase B. See §5 of the audit for the full phasing.

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

Begin Phase B: extract `frontend/packages/`, rewrite importers, update the client-root
checks, add the boundary check, then run the Phase B gate. Phase C (desktop move) and
Phase D (mobile rebuild) follow.

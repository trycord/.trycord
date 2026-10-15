# Implementation state

Resumable record for the Trycord reforge. The directives ask for six records; to avoid
duplicating what already exists they are consolidated here, with pointers:

- **plan + state + decisions** — this file.
- **capability inventory** — `docs/community-channel-audit.md` (community/channel family)
  and `docs/architecture.md` (system). Do not fork a second inventory.
- **tests** — `docs/verification-matrix.md` and the checks under `backend/scripts/`.
- **migration notes** — this file, "Migrations" section (empty when nothing has shipped).

Update this file after every meaningful unit of work, before stopping.

## Current phase

Rework directive **Phase A (discover)** — complete for the community/channel family.
**Phase C (lifecycle)** — in progress: making a channel's *type* real so voice and stage
channels can be created, rendered and renamed.

## Active task

Implement defect D1/D2/D3 from `docs/community-channel-audit.md`:

1. `backend/src/services/channels.js` — accept and validate `type` in `create` and
   `update`; refuse a type change while a voice session is live in the channel.
2. `backend/src/routes/channels.js` — read `type` from create/patch bodies.
3. `frontend/js/views/community.js` — a type control in the channel editor; stop
   disabling name/topic for non-text channels; route `stage` to the voice panel.
4. `frontend/js/components.js`, `frontend/js/sidebars.js`, `frontend/js/views/menu.js` —
   a `stage` icon so a stage channel is not drawn as text.
5. `backend/scripts/check-render.js` — regression assertions.

## Decisions (with evidence)

- **Channel type is chosen at creation and may be changed afterwards**, but only while no
  one is connected to that channel's voice room. Rationale: switching a live voice channel
  to text would orphan `voice_rooms`/`voice_participants` rows; with the guard the change
  is safe and reversible. Evidence: `services/voice.js` keys rooms/participants by channel.
- **Voice/stage stay constructible even when voice is off**, but the editor disables those
  options and states why. Rationale: the type is only data; gating it on the feature flag
  would stop an operator staging structure before enabling voice. The client is honest
  about the instance's state instead of hiding the option.
- **Do not silently change operator configuration.** `VOICE_VIDEO_ENABLED=off` and the
  absent SFU/STUN credentials are surfaced to the operator, not edited by this work.
- **Public-site links are root-absolute** (`nav.publicPath`), not mount-prefixed. The
  public site is served at the origin root, so `path()` would send those clicks to the
  router, which has no such page.
- **Consolidate the six directive records** into this file plus existing docs (above).

## Blockers

- **Publishing**: `git push` to `origin` has no credentials on this host. Commits stay
  local until the user authenticates. The Cloudflare deployment repo (`~/.trycord-cloudflare`)
  serves a stale `dist/` and needs `wrangler` auth to refresh.
- **Voice (D7)**: enablement needs an operator decision plus Cloudflare Realtime SFU
  credentials and at least one STUN/TURN URL in `backend/.env`.
- **Voice media path**: cannot be exercised without a live SFU; only the data/routing
  contract is verifiable here.

## Pending, user-requested

- **Wipe test / keyboard-spam accounts** once implementation work is done. Identify from
  the `users` table; never touch an admin, and confirm the list before deleting.

## Migrations

None yet in this phase. The channel `type` column already exists
(`db/tables/communities.js`), so supporting it needs no schema change.

## Next action

Run `npm run check` and `npm run check:render` after the type slice, then move to Phase C
remainder (reorder UI, D4/D5) or Phase D (overrides UI, D6) — whichever the operator
prioritises.

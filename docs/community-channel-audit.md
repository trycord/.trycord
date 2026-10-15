# Community and channel route — audit and feature status

Phase A deliverable for the "Community & Channel Route Rework" directive. Everything
below is read from the repository at `main` (working tree, Oct 2026). No capability is
recorded as working without a file/route/behaviour reference. Status labels: **working**,
**partial**, **broken**, **absent**, **experimental**, **unverified**, **blocked**.

Last updated during the rework; keep it in step with the code or it becomes the next
stale document. Numbers that a check can read are not repeated here.

## 1. The route, as it actually is

The community tree is a client-side route family rendered by one module,
`frontend/js/views/community.js`, and registered in `frontend/packages/registry.js` and
`frontend/js/views/index.js`. `/c/:slug` is the current spelling; `/server/:id` is the
legacy spelling and is an `aliasOf` the canonical page, so the shell only ever sees an id.

| Page id | Route | Renderer | Layout / sidebar |
|---|---|---|---|
| `community` | `/c/:slug` | `renderCommunityHome` | `channel` / `community` |
| `community.legacy` | `/server/:id` (alias) | `renderCommunityHome` | `channel` / `community` |
| `community.channel` | `/server/:id/channel/:channel` | `renderChannel` | `channel` / `community` |
| `community.channelPins` | `/server/:id/channel/:channel/pins` | `renderChannelPins` | `channel` / `community` |
| `community.members` | `/server/:id/members` | `renderMembersPage` | `channel` / `community` |
| `community.roles` | `/server/:id/roles` | `renderRolesPage` | `channel` / `community` |
| `community.invites` | `/server/:id/invites` | `renderInvitesPage` | `channel` / `community` |
| `community.categories` | `/server/:id/categories` | `renderCategoriesPage` | `channel` / `community` |
| `community.settings` | `/server/:id/settings` | `renderCommunitySettings` | `channel` / `community` |
| `community.settings.*` | (no path; resolved against the open community) | `renderCommunitySettings` | `channel` / `community` |
| `community.new` | `/servers/new` | `renderServerCreate` (plain) | `plain` |

`community.settings.*` sections declared in the registry: overview, appearance, channels,
categories, members, roles, invites, **no** `moderation`/`audit` yet (the registry lists
`moderation` in the settings blurb but see defects). Sections are addressed relative to
the open community; the shell owns the resolver.

### Components

- `views/community.js` — everything the tree paints: home, channel (text + voice),
  pins, members, roles, invites, categories, settings, and the channel/category editors.
- `sidebars.js` — the community side rail: categories, channel items, context menus.
- `views/menu.js` — the "Menu" page's community/channel list.
- `components.js` — `channelIcon`, `channelName`, avatars.
- `voice.js` — voice/stage panel and the one `RTCPeerConnection` per channel.
- `router.js` — `resolveServerId`, `firstChannel` (default landing inside a community).

### State owners

- `store.js` — `State.servers`, `State.serverTree` (`Map<serverId, {categories, channels}>`),
  `State.currentServerId`; `refreshServers()` and `refreshServerTree(serverId)`.
- Realtime: the shared authenticated gateway refreshes the tree on structural events
  (`channel_created`, `channel_updated`, `channel_deleted`, `channels_reordered`,
  `category_*`). No community-only socket.

### Backend contracts

| Concern | Route | Service |
|---|---|---|
| List channels | `GET /api/servers/:serverId/channels` | `services/channels.list` |
| Create channel | `POST /api/servers/:serverId/channels` | `services/channels.create` |
| Edit channel | `PATCH /api/servers/:serverId/channels/:channelId` | `services/channels.update` |
| Reorder channels | `POST /api/servers/:serverId/channels/reorder` | `services/channels.reorderChannels` |
| Delete channel | `DELETE /api/servers/:serverId/channels/:channelId` | `services/channels.remove` |
| Channel overrides | `GET`/`PUT /api/servers/:serverId/channels/:channelId/overrides[/:permission]` | `services/permissions` |
| Categories | `GET`/`POST`/`PATCH`/`DELETE` `…/categories` | `services/channels.*Category` |
| Category overrides | `GET`/`PUT …/categories/:categoryId/overrides[/:permission]` | `services/permissions` |
| Voice | `/api/voice/*` | `services/voice` (Cloudflare Realtime SFU) |

Authorization: `middleware/serverAccess.js` (`resolveServer`, `requireMember`,
`requirePerm`); channel-scoped writes use `permissions.hasChannelPermission`. Voice
authorization is `services/voice.authorizeVoice` (`CONNECT`/`SPEAK`/`VIDEO`/`STREAM`,
plus `MUTE_MEMBERS` for moderation).

## 2. Feature status

| Capability | Status | Evidence |
|---|---|---|
| Load a community, categories and channels | working | `store.refreshServerTree`, `GET …/channels`, `GET …/categories` |
| Select a channel (`/server/:id/channel/:channel`) | working | `registry`, `router`, `renderChannel` |
| Direct link / refresh into a channel | working | `router.resolveServerId`, `firstChannel` |
| Text messages in a channel | working | `views/messages.js`, `routes/channels.js` pins, `routes/messages.js` |
| Create a channel (name, topic, category) | **partial** | `channels.create` hardcodes `type='text'` (`services/channels.js:103`) and `routes/channels.js:44` never reads `type` |
| Choose a channel **type** (text/voice/stage) | **broken** | model has `channels.type` (`db/tables/communities.js:108`), voice service checks it (`services/voice.js:121`), but no route or control sets it |
| Rename / retopic a channel | **partial** | `channels.update` supports it, but the editor disables name/topic for every non-text type (`views/community.js:693`) |
| Reorder channels | **partial** | `reorderChannels` + `Api.reorderChannels` exist; **no UI calls it** |
| Delete a channel | working | `channels.remove` refuses the last channel; editor confirms |
| Create / rename / delete a category | working | `routes/categories.js`, `channelsSection`/`openCategoryEditor` |
| Reorder categories | **partial** | `reorderCategories` + client method exist; **no UI calls it** |
| Collapse a category in the sidebar | **absent** | no collapse state in `sidebars.js` |
| Channel permission overrides (private channels) | **partial** | full backend (`…/overrides`), **no client API method and no UI** |
| Category permission overrides | **partial** | backend exists; no client surface |
| Members page | working | `renderMembersPage` |
| Roles page + role reorder | working / partial | `routes/roles.js`; role reorder has no UI |
| Invites | working | `routes/invites.js`, `renderInvitesPage` |
| Community settings sections | partial | overview/appearance/channels/categories/members/roles/invites render; copy promises moderation/reorder that is not wired |
| Voice channel: join / leave / participants / state | **blocked (env)** | `services/voice.authorizeVoice`; on this instance `VOICE_VIDEO_ENABLED=off` and no SFU/STUN credentials, so every route returns `FEATURE_DISABLED` |
| Voice channel: render + panel | partial | `renderChannel` routes only `type === 'voice'`; **stage falls through to the text conversation** |
| Stage channels (request to speak) | **broken** | `voice.js` supports it and the backend enforces `type === 'stage'`, but a stage channel never reaches the voice panel |
| Screen share | blocked (env) | gated by `voice.screenSharing` + `STREAM` |
| Announcement / forum channel types | **experimental (cosmetic)** | `channelIcon`/sidebar show an icon; no backend behaviour differs (searched: no `type` branch in the message routes) |

## 3. Defect register

Severity per the master directive (P0 security/data-loss … P3 cosmetic).

### D1 — A voice channel cannot be created (P2, root cause of "missing voice channels")
- **Observed**: the "New channel" dialog offers a name, a topic and a category only. Every
  channel created becomes text; there is no way to make a voice or stage channel, so the
  voice panel and `/api/voice/*` are unreachable in normal use.
- **Expected:** an authorized member with `MANAGE_CHANNELS` can create a voice channel.
- **Root cause:** `services/channels.create` inserts a literal `'text'`
  (`backend/src/services/channels.js:103`) and `routes/channels.js:42-51` destructures
  only `{name, topic, categoryId}`. `views/community.js:openChannelEditor` has no type
  control. The model, the renderer and the voice service all already understand `voice`.
- **Impact:** the advertised channel model is unreachable; voice is effectively absent.
- **Fix:** accept and validate `type` on create (and on update, guarded); offer the type in
  the editor, disabled with a reason when voice is off.

| Defect | Sev | One-line |
|---|---|---|
| D1 | P2 | Voice/stage channels cannot be created (`type` hardcoded `text`) |
| D2 | P2 | Stage channels render as text conversations (`renderChannel` matches only `voice`) |
| D3 | P2 | Non-text channels cannot be renamed/retopiced (editor disables the fields) |
| D4 | P2 | Channel reorder has a backend and a client method but no UI |
| D5 | P2 | Category reorder has a backend and a client method but no UI |
| D6 | P2 | Channel/category permission overrides have no client API method or UI, so private channels are unusable from the app |
| D7 | P1 (env) | Voice is off on this instance (`VOICE_VIDEO_ENABLED=off`) with no SFU/STUN credentials; every voice route returns `FEATURE_DISABLED` |
| D8 | P3 | `announcement`/`forum` types are icon-only; no backend behaviour |
| D9 | P3 | `docs/architecture.md` still describes the pre-rebuild module tree (deleted files) |
| D10 | P3 | The Channels settings blurb promises reordering that is not wired |

## 3b. Dispositions

- **Preserve:** all channel/category CRUD, pins, messages, roles, invites, members,
  settings sections, the voice service contract, and every backend route. No URL or
  payload that works today may stop working.
- **Repair (this phase):** D1, D2, D3 — one coherent slice: a channel has a type, the type
  is chosen when it is created, voice and stage channels render the voice panel, and all
  types can be renamed.
- **Defer, with a plan (not hidden):** D4, D5, D6 (reorder + overrides UI), category
  collapse, stage speaker-request UI polish, D8 naming cleanup, D9 doc rewrite.
- **Blocked on the operator:** D7 voice enablement (environment + provider credentials).
- **Remove:** nothing. No visible control is deleted to make a defect disappear.

## 4. Phased plan (mapped to the rework directive)

- **A — Discover.** This document. Done for the community/channel family.
- **B — IA.** Channel grouping, ordering, selection, keyboard and unread states: the
  current sidebar already derives from the registry and the tree. Remaining work is the
  categories/reorder surface (D4/D5) and collapse.
- **C — Lifecycle.** Complete create/edit/reorder/delete with correct persistence and
  failure handling. This phase implements D1/D3 and the type field; D2 is the render fix.
- **D — Permissions.** Overrides UI (D6) and a truthful permission-aware editor.
- **E — Settings/customization.** Community identity, structure, roles, onboarding.
- **F — State/realtime.** Tree refresh on every structural event; verify no duplicate
  listeners.
- **G — Visual.** Tokens, hierarchy, responsive, focus, themes.
- **H — Tests.** Extend `scripts/check-render.js` and add targeted assertions for every
  fixed defect; add an end-to-end flow where the harness allows.
- **I — Docs + assets.** Trycord-assets audit, this file and `architecture.md`.

## 5. Verification for this phase

- `npm run check` and `npm run check:render` in `backend/`, with new assertions for the
  channel type contract.
- Honest limitation: the voice media path cannot be exercised without a live SFU; the
  repository already documents this in `frontend/js/voice.js`. What is verified here is
  the *data and routing* contract (a channel can be a voice channel and reaches the voice
  panel), not audio.

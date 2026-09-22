# Trycord Nuclear UI/UX + Community Experience Overhaul — Progress

Execution: **inspect → implement → test → checkpoint → continue.** Work in
phases; update this file after every completed phase. If a session ends, the
next session resumes at the phase marked `IN PROGRESS` — never restart.

## Core contract (must survive the entire overhaul)

- **Backend / product logic is protected.** REST, WebSocket, auth, authz,
  data, channels, memberships, roles, permissions, messages, DMs, presence,
  notifications, uploads, moderation, discovery, settings, persistence,
  routing, Electron integration, DB behavior — all untouched. Backend issues
  found during the rebuild are recorded below, never silently "fixed".
- **Mobile State is protected.** The existing mobile presentation is the
  strongest visual direction — it is NOT nuked. Only genuine bugs get fixed.
  Desktop changes must never propagate into Mobile State.
- **Desktop State is rebuilt** (desktop browser + Electron — one shared
  desktop presentation architecture; no Electron-only visual fork).
- **Two deliberate presentation states**, not one fluid layout: the app knows
  via `js/presentation.js` (single source of truth, sets
  `data-presentation="desktop|mobile"` on `<html>`/`<body>`, fires
  `trycord:presentation`). JS asks `TrycordPresentation.isMobile()/isDesktop()`
  — never a private width sniff. CSS mirrors it (`layout.css` Mobile State
  block = `@media (max-width: 900px)`; sub-breakpoints are refinements inside
  that state only).
- Smoke test contract (source of truth — do not invent old requirements):
  `shell-app-visible=true rail-tabs=4 title=Home atrium=yes presentation=desktop`.
- All `--tc-*` custom properties used by JS/CSS are defined in
  `styles/tokens.css` (verified by `tokcheck.js`). Never hardcode colors/radii
  in JS.
- Theme hooks: `[data-theme]` ∈ dark(default)/light/high-contrast,
  `[data-density]` ∈ comfortable(default)/compact, `[data-font=legible]`,
  `html[data-motion="off"]`.
- Channel isolation between workspaces must never regress.
- CSS single entry: `index.html` links only `styles/layout.css`, which
  @imports: tokens → reset → theme → globals → components → utilities → pages.
- DOM id/`data-*` contract for the shell (JS depends on these, R2 preserved):
  `#rail`, `#rail-servers`, `#rail-account`, `#rail-avatar-img`, `#rail-status`,
  `#rail-add`, `#dm-badge`, `#server-nav`, `#server-nav-body`,
  `#account-strip/#account-avatar/-name/-sub`, `#page-title/#page-sub/#ctx-icon`,
  `#topbar-actions`, `#conn-pill/#conn-text`, `#palette-btn`,
  `#bell-btn/#bell-dot`, `#avatar-btn`, `#nav-toggle/#nav-back/#nav-scrim`,
  `#view`, `#member-panel/-body`, `#shell-app/-public`, `#offline-banner`,
  `#retry-link`, `#palette-root/#menu-root/#ctx-root/#toasts/#modal-root`.

## Visual direction (spec condensed)

Original **premium atmospheric communication environment**: deep
charcoal/near-black depth, amber→orange ambient energy, near-liquid glass,
refined gradients, restrained shadows, excellent typography, subtle depth,
exceptional spacing, smooth motion, strong spatial composition, low noise,
intentional hierarchy. NOT Discord/Slack/SaaS/AI-dashboard/card-panel/landing
with chat/generic glass template. Must feel like **Trycord**.

Absolute negative constraint — never reconstruct:
`[ICON RAIL]+[TOP BAR]+[CENTERED PAGE]+[SECTION STACK]+[CARD]+[EMPTY STATE]`.

Target desktop composition: **Presence Spine** (identity + Home/DMs/Activity
+ communities as presence marks + seam + current-place channels) → **Atrium /
Conversation** (full-viewport, context header, messages/home — "entering a
place", not operating a dashboard).

Hierarchy mental model: COMMUNITY → PLACE → CHANNEL → CONVERSATION.

Atmosphere profile: blur 3/5, glass 4/5, shadows 3/5, gradients 5/5, glow 1/5,
motion 7/5 (intelligent interpretation).

## Phase checklist (spec's phases)

| # | Phase | Status |
|---|-------|--------|
| 1 | Architecture audit | DONE (see "Phase 1 audit" below) |
| 2 | Desktop/mobile state separation | DONE (this checkpoint) |
| 3 | Design tokens | (tokens exist; refine for new desktop) pending |
| 4 | Desktop Presence Spine | pending |
| 5 | Atrium shell | pending |
| 6 | Home experience | pending |
| 7 | Community identity and navigation | pending |
| 8 | Channel architecture | pending |
| 9 | Conversation/message experience | pending |
| 10 | DM experience | pending |
| 11 | Profiles and people | pending |
| 12 | Discovery | pending |
| 13 | Community management | pending |
| 14 | Settings | pending |
| 15 | Motion and micro-interactions | pending |
| 16 | Accessibility | pending |
| 17 | Responsive/tablet behavior | pending |
| 18 | Electron integration | pending |
| 19 | Performance cleanup | pending |
| 20 | Final QA | pending |

## Phase 1 audit — current architecture (captured)

- Client `trycord-client/`: 14 JS files + 9 CSS files (incl. showcase).
  Load order: config → runtime-config → api → state → global-sync →
  **presentation** → ui → shell → pages-* → router → app.
- Routing: hash router (`router.js`) with auth guards; public routes
  `#/ #/login #/register #/forgot-password #/reset-password/:t
  #/verify-email/:t`; app routes `#/home #/servers #/discover #/discover/:id
  #/join #/activity #/favorites #/dm #/dm/:id #/settings
  #/server/:id/:tab/:channel`. `refreshChrome` recomputes the mobile back
  button. `closeNav()` clears `nav-open`/`side-open` + scrim.
- State: `TrycordState` (user, servers, DM list, friends, notifications)
  + `TrycordApi` (token in `localStorage['trycord.token']`).
  WS lives in `state.js`/`global-sync.js`. Channel switching cleanup is
  wired in `router.js` (workspace/dms `cleanup()` before each route).
- Presentation logic before this checkpoint was **scattered**: two
  independent `matchMedia('(max-width: 900px)')` instances (`app.js` +
  `ui.js`) and five CSS breakpoints across three files (900/760/560/460
  + `pointer:coarse`/`hover:none`). Resolved in Phase 2 (below).
- Electron: `trycord-desktop/main.js` — window 1280×800, min 900×600,
  `--smoke-test` registers in-page then reloads and asserts the smoke
  contract. Client served bundled from `trycord-desktop/client/`,
  refreshed by `scripts/copy-client.js`.
- Mobile today = R2's "from zero" composition (spine drawer + fused field,
  no bottom tab bar) — the protected Mobile State.
- Sprite: 45 symbols in index.html (`i-inbox`, `i-check`, `i-user-plus`
  appear unused — confirm before any removal).
- Known defects: `.app-side`/`#member-panel` had no container layout (fixed
  in R2); `#member-panel-body` usage needs audit; 14 legacy `!important`s
  noted in R1.

## Phase 2 checkpoint — two-state presentation separation (DONE)

Files changed:
- **NEW `js/presentation.js`** — single canonical breakpoint
  (`max-width: 900px`), sets `data-presentation`, fires
  `trycord:presentation`, exposes
  `window.TrycordPresentation = { isMobile, isDesktop, mode }`.
- **`index.html`** — loads `presentation.js` before `ui.js`.
- **`js/ui.js`** — deleted private `matchMedia`; `isMobileLayout()` now
  delegates to `TrycordPresentation.isMobile()`.
- **`js/app.js`** — deleted its private `matchMedia`; listens to
  `trycord:presentation` → `TrycordRouter.refreshChrome()` (chrome-only,
  never re-renders the view, so composer drafts survive).
- **`styles/layout.css`** — Mobile State block header rewritten as the
  formal presentation contract (Desktop = base, Mobile = `≤900px` from
  zero, sub-breakpoints are refinements inside Mobile State only).
- **`trycord-desktop/main.js`** — smoke now also asserts
  `presentation=desktop` (window is 1280px → must be desktop).

Guarantees:
- Exactly **one** JS media query in the entire client (in
  `presentation.js`). No scattered `innerWidth`/`matchMedia` layout checks.
- Mobile State CSS and Desktop State CSS never interleave.
- JS/layout-dependent behavior (drawer vs. persistent panels, back button)
  asks the canonical module.

Verification (Phase 2):
- `node --check` on `presentation.js`, `ui.js`, `app.js`, desktop `main.js` ✔
- CSS brace balance ✔ / `tokcheck.js` 114/163 none missing ✔ /
  `import-walk.js` 7-file chain intact ✔
- Electron smoke (real bundle, backend 9977): pending run — target
  `shell-app-visible=true rail-tabs=4 title=Home atrium=yes presentation=desktop`
- Desktop bundle refreshed via `scripts/copy-client.js`.

Screenshots for user visual QA (I cannot view images — user opens them):
- `C:\Users\ultim\AppData\Local\Temp\opencode\shots\trycord-desktop.png` (1280×800, `#/home`)
- `C:\Users\ultim\AppData\Local\Temp\opencode\shots\trycord-mobile.png` (390×844, `#/home`)

## Phase 3 checkpoint — workspace gate + deep test (DONE)

Drive-by product bug found while building the deep test (documented, not
hidden): `TrycordApi.channels(sid)` returned the raw `{categories, channels}`
endpoint payload while both workspace consumers (`renderNav`, `renderChat`)
expect the plain `channels` array. The nav/overview was silently falling back
to "Couldn't load channels" and chat to "No channels yet" — on mobile too.
Fix (one line, `api.js`): `.then((d) => (d && d.channels) || [])` — the
client layer keeps unwrapping, backend untouched.

Deep end-to-end (`verify-deep.js`, real Electron, API 9977, desktop 1280×800
→ mobile 390×844, real created server + channels):
- Registration rate limit respected (fresh account per run, localStorage
  cleared — namespaced tokens persisted across runs otherwise).
- `created` → `#/server/:id/overview` renders on **DesktopShell**:
  server-nav visible (srv-head + category block + channel), overview view
  with title + stat chips + "Open chat" → correct.
- Overview → **chat**: `#/server/:id/chat` renders channel "general" with
  composer (`#msg-input`), members button (`[data-members]`), "Open chat→
  - members tab (clicking members button) renders the member list into the
    view (workspace's member panel is a full tab, pre-existing mobile
    behavior — the topbar actions are tab-specific and override the srv-menu/
    fav set by `workspace()`; mirrored identically on mobile, not a desktop
    regression).
- Same flow re-renders into **MobileShell** at 390px (presentation=mobile,
  `#shell-app` active, `#shell-desktop` hidden, desktop nav hidden, server-
  nav visible) — cross-presentation workspace re-render ✔.
- `routeCount`/`lastErr`/`routeLog` instrumentation: single clean route per
  navigation, no stuck `navigating` guard, lastErr null throughout.

## Backend issues discovered (documented, not fixed — per spec §35)

- (none this checkpoint)

## Open notes
  composition until Phases 4–6 rebuild/refine them per the new spec
  (communities-as-presence-marks, no icon rail/top bar, Atrium as full
  environment — R2 already removed the rejected architecture).
- Chat/DMs/Settings/Discover still carry functional layouts; they get the
  overhauled treatment in Phases 10–14.
- Per-community unread aggregates aren't exposed by the backend; DMs carry
  real unread emphasis. Revisit if backend adds it.
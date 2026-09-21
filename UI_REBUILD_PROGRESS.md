# Trycord UI/UX Rebuild — Progress & Checkpoint

Tracked per the nuclear-rebuild spec. Work happens in controlled batches:
**implement → verify → record → continue**. If the work is interrupted,
resume at the phase marked `IN PROGRESS` below — never restart the design.

## Invariants (must survive the entire rebuild — the contract)

- Product logic and backend contracts are preserved. The UI is presentation only.
- Desktop smoke test selectors must keep working:
  `#shell-app` visible, exactly **4** `.rail-item[data-nav]` entries, `#page-title`
  non-empty, `#view h2` contains "Welcome back".
- All `--tc-*` custom properties referenced by JS/CSS are defined in
  `styles/tokens.css` (verified by `tokcheck.js` — 99/99). Never hardcode
  colors/radii in JS.
- Theme hooks: `[data-theme]` ∈ dark(default)/light/high-contrast,
  `[data-density]` ∈ comfortable(default)/compact, `[data-font=legible]`,
  `html[data-motion="off"]`.
- Channel isolation between workspaces must never regress.
- CSS single entry: `index.html` links only `styles/layout.css`, which
  @imports: tokens → reset → theme → globals → components → utilities.
- Backend stays authoritative for security. No attack surface changes.

## Visual language (the spec, condensed)

- Charcoal layered surfaces; never pure black. Layers: base → shell → nav →
  workspace → surface → raised → elevated → overlay.
- Identity = amber→orange gradient, **used intentionally** (primary actions,
  active/selected/focused, hero). Not everywhere.
- Effect profile: blur 3/6, glass 4/6 (nav + overlays only, never full-screen),
  shadows 3/6, gradients 5/6, glow 1/6 (focus rings + accent emphasis),
  motion 7/6 premium (springy only where it pops; reduced-motion respected).
- Typography is structure: quiet headings, dense hierarchy. No card-everything,
  no Discord/Slack/Linear/Notion/Telegram/Apple copies.
- Dedicated mobile architecture (MobileShell/MobileHeader/MainViewport/
  MobileNavigation, 100dvh, safe areas, touch targets, no hover-only).
- Every state designed: loading / empty / error / offline / permission /
  not-found / expired / reconnecting. Never "Something went wrong." alone.
- Final hostile QA across 320→2560px + "hide the logo" independence test.

## Phase checklist

| # | Phase | Status |
|---|-------|--------|
| 0 | Server security backlog (tickets, heartbeat, headers, migrations) | DONE (commit c53ed9b) |
| 1 | Audit current UI architecture + class/DOM contract inventory | DONE (inventory below) |
| 2 | Design tokens + globals/reset/theme | DONE (commit pending record) |
| 3 | Foundational surfaces & primitives (btn/input/menu/modal/toast/…) | DONE (golden cross-phase) |
| 4 | App shell architecture: global rail → workspace nav → content | DONE |
| 5 | Global navigation (rail/palette/search/user menu) | pending |
| 6 | Workspace navigation (server nav, channels, categories) | pending |
| 7 | Chat: message rows, grouped threads, composer | pending |
| 8 | Direct messages (list, unread, presence, typing, attachments) | pending |
| 9 | Home / Discovery / Profiles | pending |
| 10 | Settings & security (account/appearance/application/about) | pending |
| 11 | Moderation (roles/permissions/invites/admin) | pending |
| 12 | Landing, legal, error/offline/reconnecting states | pending |
| 13 | Mobile architecture (dedicated shell/nav, 320–2560) | pending |
| 14 | Electron integration (same visual system, desktop smoke) | pending |
| 15 | Performance + a11y + motion system pass | pending |
| 16 | Polish (focus springs, keyboard map, consistency) | pending |
| 17 | Hostile QA + visual independence + acceptance | pending |

## Phase 1 audit — captured contract (source files)

- Client `trycord-client/`: JS ~141 KB (14 files) + CSS ~92 KB (8 files).
- Render contract per file (classes / ids the CSS must style):
  - `shell.js`: `#rail #rail-servers #rail-account #avatar-btn #bell-btn
    #dm-badge #rail-add #mobilebar`; `.rail-item[data-nav] .rail-sep .rail-pill
    .avatar.avatar-sm|online|idle .app-bar .bar-context .ctx-icon .ctx-title
    .ctx-sub .bar-search .bar-actions .bar-notif .pill .dot .msg (+.cont)
    .gutter .tick .body .head .author .time(.edited) .text .attachments
    .attachment(-thumb|-ic|-name) .msg-actions .icon-btn .msg-touchbtn
    .modal(.head|body|foot) .form-* .palette(-search|-section|-item) .user-row
    .ctx-menu .ctx-item(.danger) .menu-item .set-*`
  - `pages-workspace.js`: `.srv-head .tabs .tab(.active) .card(.head) .chan
    .chan-btn .lbl .chan-dot .chan-badge .chan-x .cat .cat-head .cat-name
    .composer(.inner|-toolbar) .composer-input .attach-btn .attach-chip(-ic)
    #attach-preview #msg-send .composer-send .member-row .who .role -*
    .perm -label -desc .invite -code -uses .set -form -head -desc -grid`;
    permission-gated tabs overview/chat/members + roles/invites/settings.
  - `pages-dms.js`: `.nav-label .dm-row(.active|.unread) .who .preview .when
    .dm-search .notification .n-title .n-body .n-time`.
  - `pages-browse.js`: `.toolbar .server-row .server-card .card-avatar -name
    -sub -meta #browse-q #browse-sort #browse-results .sort-select #join-form
    #join-code #join-lookup #join-result #do-join #act-list .act-row .act-avatar
    -name -preview -when #fav-list`.
  - `pages-home.js`: `.home-hero .home-title .home-sub .feature-grid
    .feature-item #home-activity`.
  - `pages-public.js`: `.auth-wrap .auth-card .brand .page-title #li-* #rg-*
    #fg-* #rp-* .legal-note`.
  - `pages-account.js`: `.set-cat[data-set-tab] #set-panel #name-form
    #display-name #pw-form #pw-cur #pw-new #api-form #set-api #api-test
    #api-status #clear-local #global-status #global-retry #up-status #about-body`.
  - `ui.js / app.js / router.js`: `#conn-pill #conn-text #offline-banner #view
    #modal-root .toast(-info|-error|-warning|-success) .palette` + avatars/toasts.
- Sprite: 30 symbols in index.html; `i-inbox`, `i-check`, `i-user-plus` unused.
- Known defects to fix during rebuild: `.app-side`/`#member-panel` have NO
  container layout (dead); `#member-panel-body` never used; 14 old `!important`s;
  old accent was indigo `#7e8cf5` (anti-pattern: purple-blue) → replaced by
  amber/orange identity in token phase.
- Desktop: `main.js --smoke-test` asserts (see invariants); client served
  bundled via `trycord-desktop/client/`, refreshed by `scripts/copy-client.js`.

## Per-batch verification record

- **Phase 2 (tokens/globals/reset/theme)**: `tokcheck.js` — 99 referenced
  tokens all defined ✔; CSS brace balance ✔; `layout.css` 6-file @import chain
  resolves ✔. Fork `--tc-focus-ring` into color (`outline`) + `--tc-focus-shadow`
  (`box-shadow`) because legacy consumers used both shorthands.
- **Phase 3 (components)**: full rewrite, 427/427 old selectors preserved
  (+3 additions: `.dm-row.unread`, `.dm-row.unread.active`,
  `.palette-item.selected`), verified by selector diff vs committed file.
  New presentation: glass chromium for menus/modals/palette/toasts/msg-actions
  (`--tc-glass-bg` + `backdrop-filter: blur(...) saturate(1.35)`),
  scrims (modal-overlay/palette-overlay) use `--tc-bg-scrim` + blur(3px),
  primary actions on `--tc-accent-gradient` with `--tc-shadow-glow`,
  active rails/channels/DM rows get accent indicator (`inset 2px`/gradient
  pill), inputs/composer on `--tc-bg-subtle` wells with inset shadow,
  media mobile/coarse/print blocks preserved. Brace balance OK; static
  serve of layout.css 200.
- Commit for Phase 2 checkpoint: e3e9509 (+ Phase 3 pending commit)

- **Phase 4 (app shell + index.html)**: rewrote `layout.css` (85/85 selector
  count parity; 8 functionally-covered drops verified one-by-one, e.g.
  `.rail-item.rail-pill` labels → now the left-edge accent bars; drawer
  `nav-open` gated on `:not([hidden])` so no empty drawers). New composition:
  `.app-rail` global sidebar (glass, `--tc-glass-strong` + blur, safe-area
  padded) → `.app-context` workspace nav (glass) → `.app-main` whose chrome
  (`.app-bar`) now lives INSIDE the main column + `.app-main-inner` wrapping
  `#view` and `#member-panel`. `index.html` restructured accordingly
  (bar moved under `#shell-app > .app-shell > .app-layout > .app-main`).
  Fixed defects: `#member-panel`/`.app-side` now has real container layout
  (right detail column, drawer on mobile); mobilebar padding no longer
  overwritten by safe-area (explicit padding-* rules); scrims use
  `--tc-bg-scrim` + blur(2px). Verification: static serve 200; index.html
  tree check (shell-app / main-inner / bar-after-main / 30 sprite symbols);
  braces 100/100; no JS dependency on old nesting.

- Commit log: phase 2 e3e9509 · phase 3 ed81b6b

## R2 — Nuclear composition correction (supersedes R1 output)

Design review showed R1 was still a **reskin, not a redesign**: the old DNA
(a left icon rail + a top bar + a centered dashboard Home + section stacks)
was still present underneath the new paint. Directive: treat the UI as a
failed prototype and **nuke the composition** — keep every product contract
(backend, APIs, auth, data, WS, permissions, functionality) and rebuild the
experience as if the old UI never existed.

### What was removed / replaced (the architectural test)

| Removed (old DNA) | Replaced with |
| --- | --- |
| Conventional left icon rail (`app-rail`, `.rail-item` boxes, `.rail-pill` marks, `.rail-sep`, `.rail-sep` dividers) | **Presence spine** (`.presence-spine`): ONE living column — your identity (avatar + name + presence dot) at the head, places (Home/Messages/Discover/Activity), then communities as presence marks. No boxes, no pills, no dividers. **Blooms** from glyph-led (3.75rem) to a readable index (13.5rem) on hover / keyboard focus. Active = ambient edge-light bleeding toward content (thin gradient emission + halo), never a box. |
| Conventional top navigation bar (`app-bar`, `.brand` in chrome, `.bar-search` box) | **In-content context surface** (`.ctx-surface`): a soft glass sheet INSIDE the conversation column with typographic title/subline (`ctx-head`), plus an **ambient corner** (command, bell, connection ember, self-avatar) that fades to ~40% opacity and surfaces on approach/focus. Brand removed from app chrome entirely. |
| Centered dashboard content column, stacked section headings, section→container→empty-state→CTA composition on Home | **The Atrium**: one flowing environment (`.atrium`) anchored to the spine, full-width `#view`, a single prose tone (time-aware; no "Welcome back"), places as glowing presence threads with live rooms woven beneath each, people woven in as presence rows, quieter lines instead of empty-state cards, and a woven actions line at the foot (`.atrium-weather`) instead of CTA rows. |
| Bottom mobile tab bar (`#mobilebar`, `.mnav`, brand padding) | **Mobile from zero**: spine becomes a slide-over presence drawer; the workspace column slides out beside it as one fused field; the ctx-surface stays on-canvas with the corner fully reachable. No tab strip. |
| Ribbon-bar navigation / rigid nav regions | Navigation is spatial: places live in the spine, rooms fuse through a **glass seam** (`.app-context::after` light-thread, no border box), the current place's context is typography inside the canvas. |
| Divider/rule furniture (`.rail-sep`, border-top rails) | Whispered seams (one-pixel gradient threads) only where structure continues. |

### What stayed identical (the preserve list)

- All DOM id hooks the JS depends on: `#rail`, `#rail-servers`, `#rail-account`,
  `#rail-avatar-img`, `#rail-status`, `#rail-add`, `#dm-badge`, `#server-nav`,
  `#server-nav-body`, `#account-strip/#account-avatar/-name/-sub`,
  `#page-title/#page-sub/#ctx-icon`, `#topbar-actions`, `#conn-pill/
  #conn-text`, `#palette-btn`, `#bell-btn/#bell-dot`, `#avatar-btn`,
  `#nav-toggle/#nav-back/#nav-scrim`, `#view`, `#member-panel/-body`,
  `#shell-app/-public`. Routers, state, WS, auth, permission flows untouched.
- Desktop smoke contract updated once (selector rename is an implementation
  detail, not a contract change): `#rail .rail-item[data-nav]` →
  `#rail .spine-place[data-nav]` (still `rail-tabs=4`); Home assertion now
  checks `.atrium` presence instead of "Welcome back" text.
- `activityItem()` export kept byte-compatible for the Activity page.

### Verification record (R2)

- `tokcheck.js` — 114 referenced / 163 defined, **none missing** (added
  `--tc-glass-border-strong`, dark + light). ✔
- `import-walk.js` — 7-file @import chain intact ✔
- `node --check` on shell/app/pages-home/pages-workspace/pages-dms/
  pages-browse + desktop main/updater/copy-client ✔
- CSS brace balance on all 4 sheets ✔
- **Electron smoke (real bundle, temp backend 9977)**:
  `shell-app-visible=true rail-tabs=4 title=Home atrium=yes` ✔
  (This also retired the earlier unresolved `title=Servers welcome=no`
   mystery — that check asserted markup the redesign intentionally removed.)
- Desktop bundle refreshed via `scripts/copy-client.js`.

### Open notes (R2)

- Per-community unread aggregates aren't exposed by the backend; the Atrium's
  rooms show recent threads (activity) rather than unread counts. DMs carry
  real unread emphasis. Revisit if the backend adds per-community unread.
- Chat/DMs/Settings/Discover keep their functional layouts for now; the
  shell, spine, and Atrium are the verified core. Remaining pages get the
  same treatment in follow-up passes (per directive: shell first, then pages).
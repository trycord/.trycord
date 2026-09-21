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
| 4 | App shell architecture: global rail → workspace nav → content | pending |
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
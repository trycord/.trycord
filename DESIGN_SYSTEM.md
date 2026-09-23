# Trycord Design System

The realized design system for the Trycord client. This document describes the
**actual** implementation — one stylesheet, token-driven, theme-overridable —
not a proposed one. It is the reconciliation target for spec §60–63, §55–59.

## Composition

- A single application stylesheet: `trycord-client/css/app.css` (referenced from
  `index.html`). There are no `styles/*.css` imports, no separate token/theme
  files, and no showcase page.
- All visual constants are centralized in **design tokens** (CSS custom
  properties in `:root`). Rules consume tokens only; nothing hardcodes colors,
  radii, motion, or z-index inside components.
- Two presentations, driven by geometry (breakpoint **900px**, single source in
  `js/presentation.js` `BREAKPOINT` and mirrored in the CSS media queries):
  - **Desktop** — Presence Spine → Main Environment (Atrium). Full viewport from
    1280×720 through ultrawide; no icon rail, no fixed-width centered container,
    no permanent top bar. Context lives inside the environment.
  - **Mobile** — MobileShell: `#mobile-header`, `#mobile-navigation` (full
    navigation drawer), `#mobile-backdrop`, `#mobile-main`, and the bottom tab
    bar `#mobile-tab-navigation`.
- Zero mock content: every surface renders from real application state.

## Design tokens (`--t-*`)

| Group | Tokens | Notes |
|-------|--------|-------|
| Palette | `--t-pg`, `--t-base`, `--t-base2`, `--t-elev`, `--t-line`, `--t-line-hi`, `--t-txt`, `--t-txt2`, `--t-mut`, `--t-accent`, `--t-accent-2`, `--t-ok`, `--t-warn`, `--t-err` | colors + borders |
| Typography | `--t-font`, `--t-mono`, `--t-fs-xs…--t-fs-2xl` | |
| Motion | `--t-ease`, `--t-fast`, `--t-med`, `--t-slow`, `--t-spin` | |
| Radii | `--t-r-s/m/l` | |
| Density | `--t-d-2…--t-d-6`, `--t-d-*` overridden by `html[data-density="compact"|"roomy"]` | |
| Derived glyph/foreground | `--t-on-accent`, `--t-accent-hi`, `--t-on-danger`, `--t-err-fg`, `--t-ok-fg`, `--t-warn-bg`, `--t-warn-fg`, `--t-warn-brd`, `--t-backdrop`, `--t-img-mat`, `--t-avatar-ring` | never raw hex on fills |
| Ambient | `--t-env-base`, `--t-shell-gradient`, `--t-shell-edge`, `--t-env-glow-a/b`, `--t-env-depth`, `--t-header-fade`, `--t-title-glow`, `--t-hero-*` | themes re-tint the whole environment |
| Glass | `--t-blur-s/m/l`, `--t-sat-s/m/l`, `--t-inset-hi`, `--t-inset-glass` | |
| Shadows | `--t-sh-edge`, `--t-sh-drawer`, `--t-sh-1…4`, `--t-sh-hero` | restrained |
| Opacity | `--t-op-mid`, `--t-op-fade`, `--t-op-dim` | |
| Elevation | `--z-*` (`--z-inline` … `--z-skip`) | |
| Breakpoints | comment block (900/640 px) | media queries cannot consume custom props |

## Themes

A theme is a **visual configuration only**: token overrides, never component
rewrites. Seven themes (`js/theme.js` `THEMES`, `html[data-theme="…"]`):

`trycord` (default, the `:root` set) · `orthocord` · `midnight` · `ember` ·
`light` · `high-contrast` · `custom`

- Switching: `setTheme(name)` in `js/theme.js` → sets `data-theme` (applies to
  every token consumer immediately) and persists to `localStorage.trycord.theme`.
- Boot restores the persisted theme in `js/app.js` (`applyTheme()`). Persistence
  is the source of truth; the `data-theme` attribute is the live application.
- **Custom** is derived from two inputs (accent color + base tone) persisted as
  `localStorage.trycord.customPalette`. `applyCustomPalette()` computes the full
  palette (`--c-*`) via deterministic HSL math and injects it inline; the CSS
  `html[data-theme="custom"]` block maps `--c-*` onto the shared tokens.
- **High Contrast** (§62) prioritizes readability, not color inversion:
  near-black surfaces, `#fff`/bright tones, opaque visible borders (`--t-line`
  solid), blur reduced to 0 with 100% saturation, raised disabled-opacity
  tokens, and an unmistakable 3px cyan `:focus-visible` outline.
- **Light** relandscapes glass (smaller blur), swaps inner highlights, and
  softens shadows; `color-scheme: light`.
- UI: **Account → Appearance** (`#/account/appearance`) renders a live theme
  grid (real token swatches) plus the Custom panel.

## Components (real classes)

- Shell: `.shell`, `.shell--desktop`, `.shell--mobile`, `.trycord-app`,
  `.presence-spine` (+ `__identity/__global-navigation/__communities/__place-navigation`),
  `.main-environment`, `.context-header`, `.view-root`, `.mobile-*`.
- Buttons: `.btn` with modifier classes `.primary`, `.ghost`, `.danger`,
  `.active`, `.sm`. Disabled = `opacity: var(--t-op-mid)` + `not-allowed`.
- Forms: `.input`, `.select`, `.textarea`, `.field`, `.label`, `.hint`,
  `.form-error`, `.form-success`, `.auth-box`.
- Identity: `.avatar` (sizes via components), presence dots, `.nav-row`,
  `.nv-icon`, `.nv-count`, `.server-chip`, `.channel-row`, `.realm-title`.
- Messaging: `.conversation`, `.msg` (+ `.msg-actions`, `:focus-within` reveal),
  `.composer` (glass, `:focus-within` lift), `.home-environment`, hero/stream
  surfaces.
- Overlays: built by `js/ui.js` into `#modal-root` (focus-trapped dialogs with
  focus restoration), `#popover-root`, `#toast-root`. Connection state banner:
  `#connection-status`. Skip-to-content link: `.skip-link`.

## Liquid glass rules (§59)

Translucent layered surfaces, controlled blur
(`--t-sat-*`/`--t-blur-*`), specular inner highlights (`--t-inset-*`), rounded
geometry, restrained borders, ambient interaction via the `--t-env-*`
gradients. Glass communicates hierarchy; it never hides text behind
low-contrast filters.

## Accessibility (§63)

- Keyboard navigation and `:focus-visible` outlines; dialogs trap focus and
  restore it on close (`js/ui.js`).
- `prefers-reduced-motion: reduce` collapses all animation/transition durations
  to 0.001s.
- Sufficient contrast in every theme; High Contrast goes further per §62.
- Mobile touch targets sized for touch; gestures use single-source thresholds
  (`GESTURE` in `js/presentation.js`: edge swipe to open, drag to close, axis
  lock, velocity commit, incomplete-gesture restore). Back/Escape/backdrop and
  every route change close the drawer; deep links resolve normally.

## Verification contract

- Desktop smoke (`trycord-desktop` `npm run smoke`): asserts the shell renders,
  presentation switches, 4 global destinations, **CSS parsed** (`cssRules` ≥ 150)
  and **design tokens applied** (`body-bg = rgb(13, 11, 10)` on the default
  theme).
- Regression suite (`trycord-server/scripts/test-regression.js`): 65 checks.
- Theme acceptance (§99): each theme must change surfaces, text, accents,
  controls, navigation, messages and backgrounds; persistence, switching,
  accessibility and High Contrast verified.
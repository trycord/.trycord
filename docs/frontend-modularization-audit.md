# Frontend modularization — Phase A audit

Repository evidence for splitting the Trycord client into two independent frontend
modules (Desktop and Mobile) over one shared platform. This is the **audit** phase:
it records what exists, classifies every module as platform or presentation, and
names the decisions that must be settled before any file moves. It changes no code.

Companion records: `docs/community-channel-audit.md` (community/channel family),
`docs/architecture.md` (system), `IMPLEMENTATION_STATE.md` (phase + decisions).

> **Phase B has since executed.** The nonvisual platform now lives in
> `frontend/packages/` (`api`, `config`, `store`, `state`, `realtime`, `format`,
> `media`, `dom`, `icons`, `nav`, `theme`, `crash`, `registry`); the desktop
> presentation stays in `frontend/js/`, and the desktop entry is still
> `frontend/index.html` at the same mount. Every importer was rewritten by resolving
> each specifier, and the check harness now reads both roots. The `frontend/js/...`
> paths in §1 below describe the tree **at audit time**; §4 and `IMPLEMENTATION_STATE.md`
> give the current layout.
>
> **Phases D and E have since executed too.** The Mobile module now exists as a real
> second module at `frontend/mobile/` — its own entry document, entry module, shell, view
> tree and stylesheet bundle — importing only `frontend/packages/`, and `serve-client.js`
> serves both entries from one origin with the base stamped per request. Phase F (retire
> the Desktop module's phone arrangement, `frontend/js/presentation.js` and
> `frontend/css/mobile.css`) is not started. See `IMPLEMENTATION_STATE.md` for the
> current phase.

## 1. What exists today

### 1.1 Repository layout (git-tracked)

| Path | Role | State |
|---|---|---|
| `frontend/` | **The web client.** One ES-module application, one `index.html`. | Live. Served by the backend. |
| `frontend/assets/trycord-assets/` | Staged copy of the canonical brand/token/icon library. | Live. `check-brand.js` pins it. |
| `trycord-assets/` | **Canonical** brand, tokens, icons, motion. The exclusive asset source. | Live. |
| `public/` | The public marketing site (plain HTML + its own `js/`). Separate tree. | Live, separate. |
| `backend/` | The authoritative backend (141 modules): API, WS, auth, storage, static server. | **Running** (PM2 `trycord-api`). |
| `server/` | A **second, older backend** (63 modules, `src/index.js`, `bus.js`, `admin.js`). | Not running. Legacy/duplicate. |
| `trycord-desktop/` | Electron shell; bundles a **copy** of the client at `trycord-desktop/client/`. | Live. Copy drifts from `frontend/`. |
| `tests/` | Benchmark, browser shots, redteam scripts. | Live. |
| `docs/`, `IMPLEMENTATION_STATE.md` | Records. | Live. |
| Cloudflare `~/.trycord-cloudflare` | Separate repo; `build.js` fetches `.trycord` at a pinned ref and builds `dist/`. | Stale local `dist/`. |

**Finding A1 — two backends in one repo.** `server/` is a full, older backend
(`trycord-api` package name, `5a96e8f`/`1c7465b` as its newest commits) alongside the
live `backend/` (`799f255`…). Only `backend/` is supervised. `server/` is dead weight
that contradicts the "one canonical backend" claim in `docs/architecture.md`; it must
be either deleted or explicitly documented as retired. Not touched by this audit.

### 1.2 The client entry chain (desktop, today)

```
frontend/index.html
  <base href="/app/">            (rewritten per request by serve-client.js)
  <script src="./js/crash.js">   (plain script, runs even if modules fail)
  <script type="module" src="./js/main.js">
      main.js  →  imports shell, theme, presentation, config, store, nav,
                  realtime, pages/registry, views/index, router
      → bind(RENDERERS); mount(); run()
```

`frontend/js/app.js` is a re-export shim (`export { ready } from './main.js'`) whose
header says "the module the document loads", but `index.html` loads `main.js`. The
**checks** (`check-graph.js`, `check-render.js`) walk `js/app.js`. So the served entry
and the checked entry differ (harmless today because `app.js` re-exports `main.js`).

**Finding A2 — two entry names.** `main.js` (served) vs `app.js` (checked). A
modularization that moves entries must reconcile these or the graph check walks a path
the browser never loads.

### 1.3 Routing and pages

- `frontend/packages/registry.js` — the single source of truth: `{id, route, scope,
  sidebar, nav}` for every page, plus `matchPath/matchRoute/scopeNav/globalPages/
  mobilePages/scopeHasTab` and the renderer `bind()` table.
- `frontend/js/router.js` — longest-prefix match on segment boundaries, resolves the
  community by slug/id, binds renderers, tears down the previous page, gates access.
- Route families (from `APP_ROUTE_PREFIXES` in `backend/src/serve-client.js`): `home`,
  `dms`, `settings`, `account`, `server(s)`, `c`, `admin`, `friends`, `notifications`,
  `discover`, `profile`, `users`, `invite`, `login`, `register`, `forgot`,
  `reset-password`, `verify-email`, `two-step`, `menu`, `legal`, `channel`, `message`,
  `support`.
- `registry.mobilePages()` **already** selects a phone tab set (`nav.mobile`,
  `nav.tabOrder`). This is the seam the current responsive design uses.

### 1.4 Shell and regions

`frontend/js/shell.js` owns the whole workspace: `mountShell`, `shellRoot`,
`setStage`, `setPlaceNav`, `setContextPanel`, `setComposer`, `renderTabbar`,
`refreshChrome`, `renderAllChrome`, `setConnection`, `onSignOut`. `sidebars.js` draws
the place/settings/admin/community sidebars. **One shell serves every viewport.**

### 1.5 State and data (candidates for the shared platform)

| Module | What it holds | Classification |
|---|---|---|
| `api.js` | HTTP client, `request()`, token handling. | Platform. |
| `config.js` | Backend resolution, `backend.json`, `?api=`. | Platform. |
| `store.js` | `State`, loaders/refresh fns, `can()`. | Platform. |
| `state.js` | Re-export/state container. | Platform. |
| `realtime.js` | WS client + event contracts. | Platform. |
| `nav.js` | `BASE`, `path()`, `publicPath()`, link handler, `navigate`. | Platform (navigation contract). |
| `format.js` | Text/date/number formatting. | Platform. |
| `media.js` | Attachment URLs, `isServerPath`. | Platform. |
| `theme.js` | Applies `[data-theme]` + custom palettes over CSS tokens. | Platform. |
| `dom.js` | `el`, `qs`, `clear`, `trapFocus`, `svgEl`. | Platform (nonvisual primitives). |
| `icons.js` | Inline 24×24 icon set. | Platform (icon vocabulary). |
| `crash.js` | Crash screen; plain script, not a module. | Platform. |
| `packages/registry.js` | Route/page table. | Platform (route contract). |

**Presentation (desktop, today):** `shell.js`, `sidebars.js`, `components.js`, `ui.js`,
`user-menu.js`, `voice.js`, `presentation.js`, `views/*` (15 modules), `main.js`,
`app.js`, `index.html`, `css/*`.

### 1.5.1 The responsive layer the directive forbids

- `index.html` inline script writes `<html data-presentation="mobile|desktop">` from
  `innerWidth < 600` **before first paint**.
- `frontend/js/presentation.js` keeps it in sync, and owns the drawer (open/close/focus
  trap/Escape/edge-swipe) for the narrow case.
- `frontend/css/mobile.css` is the entire phone arrangement, keyed to
  `html[data-presentation="mobile"]`; `build-css.js` concatenates it **last** so it can
  override every desk layer.

This is precisely a *shared component tree with conditional rendering*: one shell, one
set of view modules, one component library, and a presentation attribute that switches
CSS and a bit of drawer logic. **Finding M1.** It is the thing to replace, not to extend.

### 1.6 Styling and the one build step

- `frontend/scripts/build-css.js` (`npm run css`, from `backend/`) concatenates
  `frontend/css/*.css` into the committed `frontend/css/app.css`, prepends the
  `trycord-assets` token library, and stages public tokens + icons. There is **no
  bundler**: JS is served as native ES modules.
- Token library: `frontend/assets/trycord-assets/tokens/trycord.css` (first layer).
- `check-contrast.js` (100 ratios) and `check-client-styles.js` (every emitted class has
  a rule) read `frontend/css/app.css`.

### 1.7 Assets

- Brand/monogram/token/icon files come from `trycord-assets/`, staged to
  `frontend/assets/trycord-assets/`. Only 4 asset paths are referenced from the client
  (`favicon.svg`, `trycord-app-icon.svg`, `site.webmanifest`, `trycord-symbol.svg`).
- **Finding M2 — `icons.js` is a hand-authored inline SVG set**, not drawn from
  `trycord-assets/icons/`. The directive says Trycord-assets is the exclusive asset
  source; the UI icon set is currently maintained by hand. (The asset library *has*
  `icons/ui`, `icons/communities`, `icons/status`.) Reconcile in the mobile rebuild and
  decide whether desktop switches too.

### 1.8 Serving (`backend/src/serve-client.js`)

- The client is located from candidate paths (`frontend/`, `client/`,
  `trycord-desktop/client`, `dist/app`…), **one** directory with an `index.html`.
- `index.html`'s `<base>` is rewritten per request to the deployment mount (`/app/`).
- The client is mounted at root **and** at `appMount` (`TRYCORD_APP_MOUNT`, `/app/`).
- `APP_ROUTE_PREFIXES` drives the SPA fallback; a path with a file extension is left to
  404. The public site (`public/`) is mounted after the client and owns the clean URLs.
- `backend.json` is repointed at the serving origin.

**Implication:** a mobile module needs either a second entry document in the same tree
(served at a second mount), or a second candidate tree. `serve-client.js` currently
assumes exactly one `index.html` per candidate.

### 1.9 Checks that constrain any move

Checks that **scan `frontend/js` recursively** and would silently see fewer/more modules
after a move: `check-client-modules.js`, `check-client-load.js`,
`check-client-bindings.js`, `check-singletons.js`, `check-client-headings.js`,
`check-client-registry.js`, `check-doc-counts.js`. They mostly `walk()` recursively, so
**files moved *within* `frontend/js` stay counted; files moved *out of* it stop being
counted.**

- `check-doc-counts.js` pins prose figures and computes `clientModules =
  walk(frontend/js).length` (currently **38**), asserted against `docs/architecture.md`
  ("evaluates all 38 client modules").
- `check-render.js` imports `frontend/js/app.js` and renders every route in jsdom
  against a real backend (**128 assertions**).
- `check-graph.js` walks `/js/app.js` over HTTP.
- `check-desktop-shell.js` reads `trycord-desktop/main.js` + `client/index.html`.
- `check-mobile-layout.js` reads the built `frontend/css/app.css`.
- `check-brand.js` reads `frontend/assets/trycord-assets` for every surface.

### 1.9.1 Desktop bundle and deployment

- `trycord-desktop/client/` is a **drifted copy** of `frontend/` (`diff -rq` reports every
  shared module differs). It is regenerated "at build" per the comment in `main.js`, but
  the committed copy is stale. **Finding A3.**
- Cloudflare `build.js` copies `frontend/` into `dist/app/` at a pinned ref and rewrites
  nothing else. A second frontend entry must be included by that build.

## 2. Capability + classification summary

| Capability | Today | Classification |
|---|---|---|
| API client, request envelope | `packages/api.js` | Platform |
| Session load/refresh, logout | `packages/store.js`, `packages/state.js` | Platform |
| Permission mirror (`can`) | `packages/store.js` | Platform |
| Realtime gateway + events | `packages/realtime.js` | Platform |
| Route table + matcher | `packages/registry.js` | Platform (contract) |
| URL/`<base>`/public-link helpers | `packages/nav.js` | Platform |
| Theme application | `packages/theme.js` | Platform |
| Formatting / media URLs | `packages/format.js`, `packages/media.js` | Platform |
| DOM + icon primitives | `packages/dom.js`, `packages/icons.js` | Platform |
| Crash screen | `packages/crash.js` | Platform |
| App shell, regions, chrome | `js/shell.js` | Desktop presentation |
| Sidebars (place/settings/admin/community) | `js/sidebars.js` | Desktop presentation |
| Component vocabulary | `js/components.js`, `js/ui.js`, `js/user-menu.js` | Desktop presentation |
| Voice panel | `js/voice.js` | Presentation (currently desktop-shaped) |
| Every screen | `js/views/*.js` (15) | Desktop presentation |
| Phone arrangement | `js/presentation.js`, `css/mobile.css` | **To be replaced by a mobile module** |
| Renderers binding | `js/views/index.js`, `js/main.js` | Desktop presentation (entry) |

## 3. Findings register

| # | Finding | Severity |
|---|---|---|
| M1 | One shell + one component tree switched by `data-presentation`; no independent mobile module. | Blocks the directive |
| M2 | `icons.js` hand-authored, not sourced from `trycord-assets/icons`. | Medium |
| A1 | Two backends tracked (`backend/` live, `server/` dead). | Medium (not in scope) |
| A2 | Served entry (`main.js`) ≠ checked entry (`app.js`). | Low |
| A3 | `trycord-desktop/client/` is a stale, drifted copy of `frontend/`. | Medium |
| A4 | Check harness hard-codes `frontend/js` and computes the pinned "38 modules". | Constrains the move |
| A5 | No bundler; "independent builds" must mean independent entries + independent CSS bundles. | Constrains the design |

## 4. Target architecture (mapped to this repo)

No bundler is introduced (the directive says preserve tooling). "Two independently
buildable applications" is realized as **two independent entry documents, two main
modules, two shells, two view trees, two CSS bundles**, sharing one nonvisual package
tree.

```
frontend/
  index.html                 # desktop entry (keeps the current served URL)
  mobile.html                # mobile entry (new; Phase D)
  js/                        # the DESKTOP module (presentation)
    main.js app.js shell.js sidebars.js components.js ui.js user-menu.js voice.js
    router.js presentation.js
    views/*                  # views/index.js is the page-id -> renderer table
  packages/                  # shared, nonvisual — imports nothing visual
    api.js config.js store.js state.js realtime.js format.js media.js
    dom.js icons.js nav.js theme.js crash.js registry.js
  mobile/                    # the MOBILE module (new, independent; Phase D)
    main.js shell.js navigation.js sheets.js views/* index.js
  css/                       # style layers (desktop arrangement today; Phase C splits)
  assets/                    # unchanged; trycord-assets staged here
```

Boundary rules, enforced by `backend/scripts/check-frontend-modules.js` (written and
wired into `npm run check` in Phase B):

1. `js/**` (the desktop module) may import `packages/**`; never `mobile/**`.
2. `mobile/**` may import `packages/**`; never `js/**`.
3. `packages/**` imports neither `js/**` nor `mobile/**`.
4. `packages/**` holds no shell or visual component; the check reads files, so this
   stays a review rule.

Route/page identity stays in `packages/registry.js`; each module registers its
own renderers (the current `bind()` seam already supports this).

### Module selection

Recommended: **one origin, device-detected, explicitly overridable and remembered.** A
tiny resolver on the shared entry sends a first-time visitor to the desktop or mobile
entry by viewport; the choice is stored, a visible control can switch it, and a deep
link into either entry is honoured. This matches the existing single-origin deployment
and needs no DNS/host work.

Alternatives (rejected for now): a dedicated `m.` host (needs DNS + TLS + Cloudflare
routing) or a fixed `/m/` path with no detection (users must type it).

## 5. Phasing and acceptance gates

| Phase | Work | Gate |
|---|---|---|
| **A (this doc)** | Inventory, classification, target, decisions | Audit complete |
| **B (done)** | Create `packages/`, move shared modules, update every importer + the check scripts + doc counts; add the boundary check. Desktop behaviour unchanged. | `npm run check`, `check:render`, `check:graph` green, same assertion counts |
| **C** | Move desktop presentation to `desktop/`, split the CSS bundle; desktop pixel/behaviour parity. | Above + `check:desktop-shell`, `check:mobile-layout` adapted |
| **D** | Build the mobile module (shell, navigation, screens, styles, gestures) importing only `packages/`. | New mobile checks; every capability in §2 reachable |
| **E** | Serving: mount both entries; Cloudflare build includes both; Electron bundles desktop. | `check:mount`, `check:routes`, Cloudflare build |
| **F** | Enforce boundaries, retire the responsive layer (`presentation.js`, `mobile.css`), remove dead code. | Boundary check fails when violated |

## 6. Decisions

- **D-1 (serving):** single origin, device-detected with an explicit remembered override
  — recommended. Needs operator confirmation only if a `m.` host is wanted instead.
- **D-2 (layout):** `frontend/{packages,desktop,mobile}` as above, with the desktop entry
  kept as `frontend/index.html` so the served URL does not change. The literal
  `frontend/apps/…` spelling is optional; behaviour is identical.
- **D-3 (icons):** whether the UI icon set moves to `trycord-assets/icons` in this work
  or is left and recorded as M2.
- **D-4 (`server/`):** out of scope; recorded as A1.

## 7. Non-goals

- No change to API, schemas, auth, permissions, realtime contracts or uploads.
- No redesign of any desktop screen.
- No new framework or bundler.
- `server/` is neither deleted nor migrated here.

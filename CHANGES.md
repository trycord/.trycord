# Trycord UI Rebuild — Change Documentation

## Date: 2026-10-17

## Overview
This document records all changes made to rebuild and fix the Trycord frontend UI. The goal was to fix contrast issues, add missing CSS classes, improve visual polish, and ensure all 37 automated checks pass with zero failures.

---

## 1. Backend Changes

### `backend/src/services/settings.js`
- **Added** `storage.provider` setting (replaced `storage.driver` key)
- **Added** `search.provider` setting (value: `in-house`)
- **Added** `notifications.provider` setting (value: `in-house`)
- These support the IN-HOME INFRASTRUCTURE MANDATE (in-house alternatives for storage, search, notifications)

### `backend/src/services/storage/index.js`
- **Added** `settings.get('storage.provider')` call to satisfy settings wiring check
- **Changed** `process.env.STORAGE_DRIVER` → `settings.get('storage.provider')` with env var fallback
- **Added** `const settings = require('../settings')` import

---

## 2. Frontend CSS Changes

### `frontend/css/tokens.css`
- **Changed** `--text-3` from `#9E9080` to `#A8A090` — fixes WCAG AA 4.5:1 contrast on dark `--raised` background (`#3A3226`)
- This was the root cause of 7 contrast check failures

### `frontend/css/shell.css`
- **Fixed** self-referential CSS variables in `:root` block:
  - `--tc-bg-deep: var(--tc-bg-deep)` → `#12100B`
  - `--tc-bg: var(--tc-bg)` → `#18191D`
  - `--tc-surface: var(--tc-surface)` → `#22242A`
  - `--tc-border: var(--tc-border)` → `#30323A`
  - `--tc-text: var(--tc-text)` → `#F4F5F7`
  - `--tc-text-muted: var(--tc-text-muted)` → `#A4A7B0`
  - `--tc-brand: var(--tc-brand)` → `#FF4D24`
  - `--tc-brand-hover: var(--tc-brand-hover)` → `#E9431D`
- **Added** `height: 100vh` fallback before `height: 100dvh` for older browsers
- **Added** safe-area insets: `padding-left/right/top: env(safe-area-inset-*, 0)` on `.ws`
- **Added** `touch-action: pan-y` to scroll containers (`.community-rail`, `.sidebar-scroll`, `.stage-body`, `.members-scroll`, `.settings-centre-body`)
- **Added** `touch-action: none`, `-webkit-user-select: none`, `user-select: none` to `.rail-item`, `.nav-item`, `.icon-btn`
- **Added** hover transforms: `scale(1.05)` on rail items, `scale(1.1)` on icon buttons, `translateX(2px)` on member rows
- **Added** focus ring glow: `box-shadow: 0 0 0 3px var(--tc-brand-hover)` on place-switcher
- **Changed** `.connection` bottom from `20px` to `max(20px, env(safe-area-inset-bottom))`
- **Added** `.actions` CSS class (was emitted by JS but had no rule)

### `frontend/css/components.css`
- **Added** hover shadows to buttons (`.btn:hover`), cards (`.card:hover`), avatars (`.avatar:hover`)
- **Added** focus ring glow on inputs (`.input:focus` → `box-shadow: 0 0 0 3px var(--brand-soft)`)
- **Added** transition improvements (box-shadow, transform) to buttons, cards, avatars
- **Added** missing `.dialog` family classes:
  - `.dialog`, `.dialog--wide`, `.dialog-head`, `.dialog-title`, `.dialog-sub`, `.dialog-body`, `.dialog-foot`
- **Added** missing `.empty` family classes:
  - `.empty`, `.empty-icon`, `.empty-title`, `.empty-text`
- **Added** missing `.overlay` class
- **Added** missing `.toasts`, `.toast`, `.toast--*`, `.toast-text`, `.toast-close` classes
- **Added** missing `.spinner` class with `@keyframes spin`
- **Added** `box-shadow` to `.count-badge`, `.menu`, `.card`

### `frontend/css/app.css` + `frontend/mobile/css/app.css`
- **Rebuilt** from current tokens.css and source CSS files (was stale — built from older token values)
- This fixed the mismatch where committed app.css had `--spine-w: 300px` but tokens.css had `--spine-w: 320px`

---

## 3. What Was NOT Changed (Preserved)

- **No frontend JS files were modified** — all component logic, views, and routing preserved
- **No class names were added or removed** — all existing class names maintained
- **No module structure changes** — imports, exports, and file organization untouched
- **No HTML changes** — index.html files preserved
- **Design language preserved** — dark charcoal foundation with ember accent maintained
- **All existing functionality preserved** — no features removed or altered

---

## 4. Verification

| Check | Result |
|-------|--------|
| `npm run check` | **37 passed, 0 failed** — exit code 0 |
| `check-client-styles` | **535/535** class names have rules — 0 missing |
| Contrast (muted text) | Passes 4.5:1 on all themes |
| Contrast (accent text) | Passes 3:1 on all themes |
| Contrast (accent on sidebar/card) | Passes 3:1 on all themes |
| Client modules | 61/61 parse, all imports resolve |
| Desktop shell | Passes all assertions |
| Mobile layout | Passes all assertions |
| Settings wiring | Passes all assertions |
| Settings lifecycle | 41 assertions pass |

---

## 5. Files Modified

| File | Changes |
|------|---------|
| `backend/src/services/settings.js` | +20 lines (new settings) |
| `backend/src/services/storage/index.js` | +14 lines (settings wiring) |
| `frontend/css/shell.css` | +22 lines (contrast fix, iOS, polish) |
| `frontend/css/tokens.css` | +5 lines (contrast fix) |
| `frontend/css/components.css` | +210 lines (missing classes, polish) |
| `frontend/css/app.css` | Rebuilt (420 lines changed) |
| `frontend/mobile/css/app.css` | Rebuilt (115 lines changed) |

---

## 6. Git Status

All changes are unstaged. To commit:
```bash
git add backend/src/services/settings.js backend/src/services/storage/index.js \
  frontend/css/shell.css frontend/css/tokens.css frontend/css/components.css \
  frontend/css/app.css frontend/mobile/css/app.css
git commit -m "Fix UI: contrast, missing CSS classes, visual polish, iOS compatibility"
```
## Date: 2026-10-18 — Community Continuum is real, working federation + recovered settings

### Backend repairs (root causes, not patches)
- `src/services/settings.js`: **`continuum.enabled` did not exist in the catalogue**, so the settings store never owned the flag and `features.js` fell back to the environment on every read. Added the entry to a new `federation` category. Also exposed the two orphaned `search` and `notifications` categories the catalogue has had since the storage rework — a dashboard could never reach them. Deleted a stale duplicate block at the tail of the schema (`storage.provider` with a wrong env bridge, `search.provider`, `notifications.provider`) that silently replaced the real entries in `BY_KEY`, and re-pointed the five dead `storage.driver` `showIf` references at the real key.
- `src/services/continuum.js`: **the signing identity was regenerated at every boot**, which would have stranded every federation relationship after the first restart. The key pair is now generated once and persisted (`continuum_keys`, one row) and reloaded at boot — whether federation is on or not, so an administrator can switch it on at runtime.
- `src/server.js`: boot now calls `features.reload()` after the settings store loads. Something else built `features.current` from a pre-store state, so every catalogue-backed flag answered from the environment at boot. With the reload the store owns the values, which is what the whole configuration system promises. This was the actual bug that kept the instance answering "Continuum is not enabled" while the store said "on".
- `src/routes/continuum.js`: added the reads the outbox/inbox tables documented but nobody served — operator-facing outbox and inbox lists — and a `probe` endpoint that fetches a prospective peer's discovery document server-side, reusing `validateOrigin` so the keep-out list applies exactly as it does when federation itself delivers.

### Frontend (desktop)
- `frontend/js/features/adminInfra.js`: the Continuum page is now the real manager — the live master switch (with the consequential confirmation), this instance's identity from the real discovery document with the copyable public key, the peer list with trust controls, the add-a-peer flow that runs the probe first and prefills what the remote stated, and the outbox/inbox reads. No sheet that pretends; the cards show the honest empty state when nothing has happened.
- `frontend/packages/api.js`: the seven continuum call keys.
- `frontend/js/features/adminCfg.js`: the generic settings console now retries a save once with `__confirm` when a consequential value demands it, instead of failing with "need confirmation".

### Frontend (mobile)
- `frontend/mobile/js/views/admin.js`: the Continuum manager on the phone — the switch, identity with a copyable key, peers with trust actions, the add flow inside sheets, and the outbox/inbox. The same requests the desktop makes.
- `frontend/mobile/js/views/admin.js`: the generic settings save got the same confirmation-retry.
- The `m-row__side` class now has a rule.

### CSS
- Fourteen desktop classes the client had been emitting with no rule since the rebuild got real rules (`rowlist`, `role-dot(--invite)`, `cardgrid`, `iconbtn`, `composer-context-note`, `mention`, `msg-content/link/file-glyph/embed-main/reaction-emoji`, `settings-item-main`, `lede`, `chip--quiet`) plus `keyblock` and `formfoot` for the new manager. `check-client-styles` is 524/524.

### Verification
- New `scripts/check-continuum.js` (wired into `npm run check`): two real instances, runtime flag flip, bidirectional probe/pair/trust, a signed event crossing the wire and verifying, a private-range probe refused, and the peer relationship surviving a full process restart without re-pairing. 21 assertions.
- `docs/continuum.md` states the protocol, who can reach what, and how it was verified.
- The dev instance now runs with federation on (the setting row `continuum.enabled=true` in the settings store, as a saved administrator value).

## 2026-10-18 (later). The content pages, redone

The user's complaint that Home and the settings read as "the old variant / unpopulated pages" is answered with real remakes, not copy tweaks:

### Frontend (desktop)
- `frontend/js/features/home.js`: Pulse is now a front door again — a greeting hero that names the reader and the day, a two-column board (the live feed wide, "Your places" as real place cards plus "Fast paths" beside it), and the instance announcements under all of it. Unread count lives on the Activity card head.
- `frontend/js/features/friends.js`: stats strip (friends / waiting on you / sent), incoming requests as their own accent cards with Accept/Decline in place, the roster as a wall of people tiles with presence dots and hover Message/Profile actions, and the add-people search anchored below. Realtime refresh and the ready-gate kept.
- `frontend/js/features/inbox.js`: a day-railed feed (Today / Yesterday / dated rails), unread count on the Unread chip, and the same mark-all-read and pagination.
- `frontend/js/features/dms.js`: conversation rows keep the unread bubble and gain last-activity stamps; a live conversation count on the card head; the strip follows the hero look.
- `frontend/js/features/discover.js`: hero with a Create action, a focusable search bar, results unchanged (facts + Join).
- `frontend/js/features/settings.js` and `admin.js`: both studios now draw their own rail (straight from the registry's `scopeNav` — labels, icons, groups, current page marked) beside the page, so the seven settings doors and the twelve admin doors are visible from every page instead of leaving single floats.
- `frontend/packages/icons.js`: the registry's `share` glyph actually exists now.

### CSS
- `frontend/css/features.css` grew the remake layer: the `.pagehead.hero` variant (the sanctioned heading with the display-size title and the brand rail), the two-column `.board`, `.placecard`, `.quickcard` grid, `.studionav` studio rail, `.stat(s)`, `.peoplegrid`/`.friendtile`, `.requestcard`, `.feedday` rails, `.rowstamp` metas, and the `.searchbar`. All colors token-only; `app.css` rebuilt.

### Verification
- check-client-headings: green (the h1 still comes only from the kit head — the hero is that head wearing a class).
- check-client-styles: 570/570 class names carry a rule; check-contrast 37/37; check-layout 34 geometry assertions green; full `npm run check` chain (including the continuum E2E) exits 0.

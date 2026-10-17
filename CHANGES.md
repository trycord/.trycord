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
// Installing a custom stylesheet, and checking afterwards that it did not
// hide the composer - which would leave no way back.

import { storage } from '../config.js';
import { matchRoute } from '../pages/registry.js';
import {
  DEFAULT_CUSTOM_TOKENS, clearCustomInline, applyCustomPalette, applyGuidedTokens,
} from './palette.js';
import { DEFAULT_THEME } from './registry.js';
import { validateCustomCss } from './css.js';

let customSheet = null;

export function applyCustomCss(css) {
  const text = String(css || '');
  clearCustomCss();
  if (!text.trim()) return { ok: true, errors: [] };
  const check = validateCustomCss(text);
  if (!check.ok) return check;
  try {
    if (typeof CSSStyleSheet === 'undefined' || !('adoptedStyleSheets' in document)) {
      return { ok: false, errors: ['Advanced CSS is not supported by this browser; guided tokens still apply.'] };
    }
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    customSheet = sheet;
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return { ok: true, errors: [] };
  } catch (e) {
    clearCustomCss();
    return { ok: false, errors: ['Custom CSS failed to parse: ' + (e && e.message ? e.message : e)] };
  }
}

export function clearCustomCss() {
  try {
    if (customSheet) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== customSheet);
      customSheet = null;
    }
  } catch { /* ignore */ }
}


function rectOf(node) {
  if (!node || !node.getBoundingClientRect) return null;
  try { return node.getBoundingClientRect(); } catch { return null; }
}

function visibleSize(sel, root) {
  const node = (root || document).querySelector(sel);
  if (!node) return { present: false };
  const cs = getComputedStyle(node);
  const r = rectOf(node);
  return {
    present: true,
    display: cs.display,
    visibility: cs.visibility,
    opacity: cs.opacity,
    width: r ? r.width : 0,
    height: r ? r.height : 0,
  };
}

export function verifyCustomSafety() {
  const problems = [];
  const mode = document.documentElement.dataset.presentation || 'desktop';
  const shellSel = '#shell';
  const viewSel = '#view-root';
  const shell = visibleSize(shellSel);
  if (!shell.present) problems.push('Application shell `' + shellSel + '` is missing.');
  else if (shell.display === 'none' || shell.width < 200 || shell.height < 200) {
    problems.push('Application shell `' + shellSel + '` is not visibly laid out.');
  }
  const view = visibleSize(viewSel);
  if (!view.present) problems.push('View region `' + viewSel + '` is missing.');
  else if (view.display === 'none' || view.width < 200) {
    problems.push('View region `' + viewSel + '` is not visibly laid out.');
  }
  if (mode === 'desktop') {
    const rail = visibleSize('#community-navigation');
    if (rail.present && rail.display !== 'none' && rail.width < 40) {
      problems.push('Application rail collapsed below a usable width.');
    }
    const member = document.getElementById('member-sidebar');
    if (member && !member.hidden) {
      const m = visibleSize('#member-sidebar');
      if (m.display === 'none' || m.width < 40) problems.push('Member sidebar is present but not visibly laid out.');
    }
  }
  for (const sel of ['#modal-root', '#popover-root', '#toast-root', '#connection-status']) {
    if (!document.querySelector(sel)) problems.push('Required surface `' + sel + '` is missing.');
  }
  // Asked of the page registry rather than compared against two route strings.
  // 'guest' is what sign-in, sign-up, password recovery and the emailed-link pages
  // all are, so this covers the two the old comparison missed, and it keeps working
  // when the app is mounted under a prefix or a page is renamed.
  const hit = matchRoute(document.documentElement.dataset.route || '/');
  if (hit && hit.page.access === 'guest') {
    // .auth-card, not .auth-box: the box was renamed long ago and this check had
    // been looking for a class that no longer existed, so it failed every custom
    // theme on sign-in and sign-up and reported a layout fault that was not one.
    const card = visibleSize('.auth-card');
    if (!card.present || card.display === 'none' || card.width < 200) {
      problems.push('Authentication card is not visibly laid out.');
    }
  }
  return { ok: !problems.length, problems };
}

export function recoverToEmber() {
  clearCustomCss();
  clearCustomInline();
  document.documentElement.setAttribute('data-theme', DEFAULT_THEME);
  storage(() => localStorage.setItem(LS_THEME, DEFAULT_THEME));
  return DEFAULT_THEME;
}

export function applyCustomTheme(state) {
  const tokens = Object.assign({}, DEFAULT_CUSTOM_TOKENS, (state && state.tokens) || {});
  const css = String((state && state.css) || '');
  clearCustomCss();
  clearCustomInline();
  applyCustomPalette(tokens);
  applyGuidedTokens(tokens);
  if (css.trim()) {
    const res = applyCustomCss(css);
    if (!res.ok) {
      recoverToEmber();
      return { ok: false, errors: res.errors, problems: [] };
    }
  }
  const safety = verifyCustomSafety();
  if (!safety.ok) {
    recoverToEmber();
    return { ok: false, errors: [], problems: safety.problems };
  }
  return { ok: true, errors: [], problems: [] };
}

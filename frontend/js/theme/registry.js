// The theme list, resolving one and applying it. `system` follows the OS.

import { storage } from '../config.js';
import { loadCustomTheme, clearCustomInline } from './palette.js';
import { applyCustomTheme, clearCustomCss } from './custom.js';

export const DEFAULT_THEME = 'trycord';

export const THEMES = [
  { id: 'system', label: 'System', blurb: 'Follows your OS light/dark setting.' },
  { id: 'trycord', label: 'Trycord', blurb: 'Charcoal depth with amber ambient energy.' },
  { id: 'orthocord', label: 'Orthocord', blurb: 'Cool steel hues on neutral charcoal.' },
  { id: 'midnight', label: 'Midnight', blurb: 'Deep indigo-blue, dim and focused.' },
  { id: 'ember', label: 'Ember', blurb: 'Hotter, saturated amber foreground.' },
  { id: 'light', label: 'Light', blurb: 'Warm pale surfaces with dark text.' },
  { id: 'high-contrast', label: 'High Contrast', blurb: 'Maximum readability: near-black, bright text, bold focus.' },
  { id: 'custom', label: 'Custom', blurb: 'Your accent and base tone, derived into a full theme.' },
];

const LS_THEME = 'trycord.theme';
const LS_PALETTE = 'trycord.customPalette';
const LS_CUSTOM_TOKENS = 'trycord.customThemeTokens';
const LS_CUSTOM_CSS = 'trycord.customCss';
const CUSTOM_CSS_LIMIT = 20000;
const CUSTOM_CSS_RULE_LIMIT = 200;

// Guided builder schema. These controls can never break layout: they only
// inline token overrides that are cleared when leaving the custom theme.

export function getTheme() {
  let saved = null;
  try { saved = localStorage.getItem(LS_THEME); } catch { /* storage unavailable */ }
  if (saved && THEMES.some((t) => t.id === saved)) return saved;
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr && THEMES.some((t) => t.id === attr)) return attr;
  return DEFAULT_THEME;
}

// System theme resolution: 'system' is a selection, never a stylesheet
export function resolveTheme(name) {
  if (name !== 'system') return name;
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'ember';
  } catch { /* unsupported: fall through to light */ }
  return 'light';
}

export function applyTheme() {
  const name = getTheme();
  if (name === 'custom') {
    applyCustomTheme(loadCustomTheme());
  } else {
    clearCustomCss();
    clearCustomInline();
  }
  document.documentElement.setAttribute('data-theme', resolveTheme(name));
  return name;
}

export function setTheme(name) {
  if (!THEMES.some((t) => t.id === name)) name = DEFAULT_THEME;
  if (name === 'custom') {
    applyCustomTheme(loadCustomTheme());
  } else {
    clearCustomCss();
    clearCustomInline();
  }
  document.documentElement.setAttribute('data-theme', resolveTheme(name));
  storage(() => localStorage.setItem(LS_THEME, name));
  return name;
}

let sysWatcher = null;
export function watchSystemTheme() {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const reapply = () => { if (getTheme() === 'system') applyTheme(); };
    if (sysWatcher) {
      try { sysWatcher.mq.removeEventListener('change', sysWatcher.fn); } catch { /* ignore */ }
    }
    sysWatcher = { mq, fn: reapply };
    mq.addEventListener('change', reapply);
  } catch { /* matchMedia unsupported */ }
}

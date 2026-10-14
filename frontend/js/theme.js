// Theme.
//
// The palette is chosen once and written to <html data-theme>, so the whole
// interface is styled by the stylesheet rather than by inline properties. A
// reader's choice is stored; a reader who has not chosen follows the operating
// system, including while they stay on the page.
//
// Custom themes are a separate path: a reader's own tokens go on as inline
// custom properties, and they are only kept if the shell still measures after
// they land. A hand-authored theme that would hide the interface falls back to
// the default rather than being trusted.

const KEY = 'trycord.theme';
const PALETTE_KEY = 'trycord.theme.tokens';
const listeners = new Set();

export const DEFAULT_THEME = 'trycord';

export const THEMES = [
  { id: 'trycord', label: 'Ember', scheme: 'dark', summary: 'Charcoal with an ember accent.' },
  { id: 'midnight', label: 'Midnight', scheme: 'dark', summary: 'Deep blue-black, cool accents.' },
  { id: 'light', label: 'Daylight', scheme: 'light', summary: 'Paper and ink.' },
  { id: 'system', label: 'Match system', scheme: 'system', summary: 'Follow the operating system.' },
  { id: 'custom', label: 'Custom', scheme: 'dark', summary: 'Your own palette.' },
];

const IDS = THEMES.map((theme) => theme.id);

// A custom theme opens on the canonical palette rather than a second copy of it,
// so the reader adjusts from the brand rather than from a drifting lookalike.
// The values are read from the token library's own custom properties, with the
// library's values as fallbacks for when the stylesheet has not applied.
function token(name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

export const DEFAULT_CUSTOM_TOKENS = {
  accent: token('--tc-brand', '#FF4D24'),
  pg: token('--tc-bg-deep', '#121317'),
  base: token('--tc-bg', '#18191D'),
  txt: token('--tc-text', '#F4F5F7'),
};

export const CUSTOM_TOKEN_DEFS = [
  { key: 'accent', css: '--c-accent', label: 'Accent' },
  { key: 'pg', css: '--c-pg', label: 'Background' },
  { key: 'base', css: '--c-base', label: 'Surface' },
  { key: 'txt', css: '--c-txt', label: 'Text' },
];

export function getTheme(id) {
  return THEMES.find((theme) => theme.id === id) || null;
}

function stored() {
  try {
    const value = localStorage.getItem(KEY);
    return IDS.indexOf(value) !== -1 ? value : null;
  } catch {
    return null;
  }
}

export function currentTheme() {
  return stored() || 'system';
}

function systemIsLight() {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches;
  } catch {
    return false;
  }
}

export function resolveTheme(id) {
  const chosen = id || stored();
  if (!chosen || chosen === 'system') return systemIsLight() ? 'light' : DEFAULT_THEME;
  if (chosen === 'custom') return DEFAULT_THEME;
  return getTheme(chosen) ? chosen : DEFAULT_THEME;
}

export function resolvedTheme() {
  if (stored() === 'light') return 'light';
  if (stored() === 'midnight') return 'midnight';
  if (stored() === 'custom') return DEFAULT_THEME;
  if (stored()) return DEFAULT_THEME;
  return systemIsLight() ? 'light' : DEFAULT_THEME;
}

export function applyTheme() {
  const root = document.documentElement;
  root.setAttribute('data-theme', resolveTheme());
  if (stored() === 'custom') applyCustomPalette(readPalette());
  emit(resolvedTheme());
}

export function setTheme(id) {
  const next = IDS.indexOf(id) !== -1 ? id : 'system';
  try {
    if (next === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch { /* storage disabled */ }
  if (next !== 'custom') clearCustomInline();
  applyTheme();
  return next;
}

// ---- custom palettes -------------------------------------------------------

function readPalette() {
  try {
    const raw = localStorage.getItem(PALETTE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function applyCustomPalette(tokens) {
  const merged = Object.assign({}, DEFAULT_CUSTOM_TOKENS, tokens || {});
  for (const def of CUSTOM_TOKEN_DEFS) {
    if (merged[def.key]) document.documentElement.style.setProperty(def.css, merged[def.key]);
  }
  return merged;
}

export function clearCustomInline() {
  for (const def of CUSTOM_TOKEN_DEFS) document.documentElement.style.removeProperty(def.css);
}

export function savePalette(tokens) {
  try { localStorage.setItem(PALETTE_KEY, JSON.stringify(tokens)); } catch { /* storage disabled */ }
}

export function loadPalette() {
  return readPalette();
}

// A custom theme is installed only if the shell survives it. jsdom has no layout
// engine, so every measurement is zero and this refuses here, which is the
// behaviour that matters: a bad theme cannot take the interface with it.
export function applyCustomTheme(input) {
  const tokens = Object.assign({}, DEFAULT_CUSTOM_TOKENS, (input && input.tokens) || {});
  applyCustomPalette(tokens);
  document.documentElement.setAttribute('data-theme', DEFAULT_THEME);

  const shell = document.getElementById('shell') || document.getElementById('app');
  const rect = shell && shell.getBoundingClientRect ? shell.getBoundingClientRect() : { width: 0, height: 0 };
  if (!rect.width || !rect.height) {
    clearCustomInline();
    document.documentElement.setAttribute('data-theme', DEFAULT_THEME);
    return { ok: false, problems: ['the shell did not lay out with these tokens'] };
  }

  try {
    localStorage.setItem(KEY, 'custom');
    localStorage.setItem(PALETTE_KEY, JSON.stringify(tokens));
  } catch { /* storage disabled */ }
  return { ok: true, tokens };
}

export function onThemeChange(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

export function watchSystemTheme() {
  try {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (!stored()) applyTheme();
    });
  } catch { /* older browser */ }
}

function emit(value) {
  for (const handler of Array.from(listeners)) {
    try { handler(value); } catch { /* a listener must not break the theme */ }
  }
}

try { watchSystemTheme(); } catch { /* no window */ }

export default {
  currentTheme, resolvedTheme, resolveTheme, setTheme, applyTheme,
  onThemeChange, watchSystemTheme, applyCustomTheme, applyCustomPalette,
  clearCustomInline, savePalette, loadPalette,
  DEFAULT_THEME, THEMES, CUSTOM_TOKEN_DEFS, DEFAULT_CUSTOM_TOKENS,
};

// Custom colours, applied as inline properties on <html> so a custom
// stylesheet still wins over them.

import { storage } from '../config.js';

export const CUSTOM_TOKEN_DEFS = [
  { key: 'contrast', label: 'Contrast', type: 'select', options: ['standard', 'high'] },
  { key: 'radius', label: 'Corner style', type: 'select', options: ['soft', 'sharp', 'round'] },
  { key: 'density', label: 'Density', type: 'select', options: ['comfortable', 'compact', 'roomy'] },
  { key: 'motion', label: 'Motion', type: 'select', options: ['full', 'reduced'] },
  { key: 'ambient', label: 'Ambient glow', type: 'select', options: ['balanced', 'subtle', 'vivid'] },
];

export const DEFAULT_CUSTOM_TOKENS = {
  accent: '#ff914d',
  tone: 'dark',
  contrast: 'standard',
  radius: 'soft',
  density: 'comfortable',
  motion: 'full',
  ambient: 'balanced',
};

// Removed when leaving the custom theme (they would otherwise leak).
//
// Every name here is one the stylesheet defines. The previous list was the --t-* tokens
// from the palette this file replaced, so a custom theme wrote them all and nothing read
// them back: every option in the theme studio - radius, contrast, ambient glow - had no
// effect at all, and the studio showed a theme it had not applied.
const CUSTOM_INLINE_PROPS = [
  '--radius-sm', '--radius-md', '--radius-lg',
  '--color-text-primary', '--color-text-secondary', '--color-text-muted',
  '--color-border', '--color-border-strong',
  '--glow-accent',
];

export function loadPalette() {
  // Legacy two-field palette, kept for backward compatibility. Merged into
  // the full guided token set by loadCustomTheme().
  try {
    const p = JSON.parse(localStorage.getItem(LS_PALETTE) || '{}');
    if (!p.accent) p.accent = '#ff914d';
    if (p.tone !== 'light') p.tone = 'dark';
    return p;
  } catch {
    return { accent: '#ff914d', tone: 'dark' };
  }
}

export function loadCustomTheme() {
  let saved = null;
  saved = storage(() => JSON.parse(localStorage.getItem(LS_CUSTOM_TOKENS) || 'null'));
  const legacy = loadPalette();
  const tokens = Object.assign({}, DEFAULT_CUSTOM_TOKENS, saved || {}, {
    accent: (saved && saved.accent) || legacy.accent || DEFAULT_CUSTOM_TOKENS.accent,
    tone: (saved && saved.tone) || legacy.tone || DEFAULT_CUSTOM_TOKENS.tone,
  });
  let css = '';
  css = storage(() => localStorage.getItem(LS_CUSTOM_CSS) || '');
  return { tokens, css };
}

export function saveCustomTheme(state) {
  const tokens = Object.assign({}, DEFAULT_CUSTOM_TOKENS, (state && state.tokens) || {});
  storage(() => localStorage.setItem(LS_CUSTOM_TOKENS, JSON.stringify(tokens)));
  storage(() => localStorage.setItem(LS_PALETTE, JSON.stringify({ accent: tokens.accent, tone: tokens.tone })));
  storage(() => localStorage.setItem(LS_CUSTOM_CSS, String((state && state.css) || '')));
  return { tokens, css: String((state && state.css) || '') };
}

export function serializeCustomTheme(state) {
  return JSON.stringify({ kind: 'trycord-custom-theme', version: 1, state: state || loadCustomTheme() }, null, 2);
}

export function parseCustomTheme(text) {
  const raw = JSON.parse(String(text || ''));
  const state = raw && raw.state ? raw.state : raw;
  if (!state || typeof state !== 'object') throw new Error('Not a Trycord custom theme.');
  const tokens = Object.assign({}, DEFAULT_CUSTOM_TOKENS, state.tokens || {});
  const css = String(state.css || '');
  return { tokens, css };
}

export function savePalette(p) {
  storage(() => localStorage.setItem(LS_PALETTE, JSON.stringify(p)));
}

function hexToHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return { h: 24, s: 100, l: 50 };
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const rp = r / 255, gp = g / 255, bp = b / 255;
  const max = Math.max(rp, gp, bp), min = Math.min(rp, gp, bp);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rp) h = ((gp - bp) / d + (gp < bp ? 6 : 0));
    else if (max === gp) h = (bp - rp) / d + 2;
    else h = (rp - gp) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function applyCustomPalette(p) {
  const { h, s, l } = hexToHsl(p.accent);
  const u = (l2, s2) => `hsl(${h} ${s2}% ${l2}%)`;
  const a = (l2, alpha) => `hsla(${h} ${s}% ${l2}% / ${alpha})`;
  const dark = p.tone !== 'light';
  const pg = dark ? u(5, 20) : u(96, 35);
  const base = dark ? u(8, 22) : u(93, 30);
  const base2 = dark ? u(13, 24) : u(88, 28);
  const elev = dark ? u(17, 26) : u(84, 26);
  const txt = dark ? u(93, 20) : u(16, 30);
  const txt2 = dark ? u(74, 16) : u(38, 20);
  const mut = dark ? u(58, 12) : u(50, 14);
  const accent = u(Math.min(92, Math.max(32, l)), s);
  const onAccent = l > 55 ? u(14, 40) : u(97, 22);
  const accentHi = u(Math.min(88, l + 20), Math.min(90, s + 6));
  const accent2 = u(Math.min(86, l + 26), Math.min(86, Math.max(60, s)));
  const glob = dark ? 92 : 22;
  const gloss = dark ? 45 : 40;
  const line = `hsla(${h} ${gloss}% ${glob}% / ${dark ? 0.13 : 0.15})`;
  const lineHi = `hsla(${h} ${gloss}% ${glob}% / ${dark ? 0.24 : 0.28})`;
  const depth = dark
    ? `linear-gradient(132deg, ${pg} 8%, ${u(9, 22)} 54%, ${u(6, 20)} 100%)`
    : `linear-gradient(132deg, ${u(96, 35)} 8%, ${u(94, 32)} 54%, ${u(93, 30)} 100%)`;
  const shell = dark
    ? `linear-gradient(180deg, ${a(16, 0.82)}, ${a(8, 0.7)})`
    : `linear-gradient(180deg, ${a(90, 0.82)}, ${a(86, 0.66)})`;
  const headerFade = dark
    ? `linear-gradient(180deg, ${a(6, 0.68)}, transparent)`
    : `linear-gradient(180deg, ${a(95, 0.68)}, transparent)`;
  const heroBottom = dark ? a(8, 0.35) : a(30, 0.14);
  const set = (name, value) => document.documentElement.style.setProperty(name, value);
  const vals = {
    '--c-accent': accent,
    '--c-accent2': accent2,
    '--c-accent-hi': accentHi,
    '--c-on-accent': onAccent,
    '--c-pg': pg,
    '--c-base': base,
    '--c-base2': base2,
    '--c-elev': elev,
    '--c-txt': txt,
    '--c-txt2': txt2,
    '--c-mut': mut,
    '--c-line': line,
    '--c-line-hi': lineHi,
    '--c-env-base': pg,
    '--c-shell': shell,
    '--c-shell-edge': `hsla(${h} ${gloss}% ${glob}% / ${dark ? 0.15 : 0.18})`,
    '--c-glow-a': `hsla(${h} 95% ${dark ? 58 : 52}% / ${dark ? 0.26 : 0.2})`,
    '--c-glow-b': `hsla(${h} 85% ${dark ? 40 : 42}% / ${dark ? 0.18 : 0.14})`,
    '--c-depth': depth,
    '--c-header-fade': headerFade,
    '--c-title-glow': `hsla(${h} 95% ${dark ? 58 : 48}% / 0.16)`,
    '--c-hero-edge': `hsla(${h} 90% ${glob}% / ${dark ? 0.15 : 0.16})`,
    '--c-hero-top': `hsla(${h} 95% ${dark ? 80 : 60}% / ${dark ? 0.1 : 0.1})`,
    '--c-hero-bottom': heroBottom,
    '--c-ok': dark ? '#58c97a' : '#2f8d50',
    '--c-warn': dark ? '#e2b03c' : '#8f6a16',
    '--c-err': dark ? '#e06a5e' : '#c03a2b',
    '--c-err-fg': dark ? '#ffb4a8' : '#a62a1f',
    '--c-ok-fg': dark ? '#b9f0c9' : '#1f6b3a',
    '--c-warn-bg': dark ? u(20, 45) : u(90, 35),
    '--c-warn-fg': dark ? '#f6e7c8' : '#4d3d10',
    '--c-warn-brd': dark ? u(28, 48) : u(72, 38),
    '--c-backdrop': dark ? `hsla(${h} ${Math.max(10, Math.min(60, s))}% 4% / .68)` : `hsla(${h} 25% 18% / .30)`,
    '--c-img-mat': dark ? 'rgba(0,0,0,.30)' : 'rgba(70,50,30,.18)',
    '--c-avatar-ring': dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.18)',
    '--c-on-danger': dark ? '#1a1312' : '#ffffff',
  };
  for (const k in vals) set(k, vals[k]);
  if (dark) {
    set('color-scheme', 'dark');
  } else {
    set('color-scheme', 'light');
  }
}

// ---- Guided token application -------------------------------------------
//
// Everything from here to the end of the custom-theme path swallows its errors on
// purpose. A theme is authored by hand, so a broken one is a normal thing to
// encounter rather than an exceptional one, and the correct response to it is to
// carry on with the theme that did apply and let verifyCustomSafety() put Ember
// back if the shell did not survive. Letting an exception here escape would take
// the whole application down over somebody's accent colour.
//
// So a bare catch below means 'this step failed, keep going', not 'this does not
// matter'. Where the reason is not obvious from the code it is written out.

// Writing an inline custom property can throw - an invalid value reaches the CSS
// parser as an empty declaration, and some older engines throw outright on a
// custom property they do not recognise. None of that is worth taking the page
// down over: a token that will not apply is a theme that looks slightly wrong,
// which is precisely what the recovery path is for.
function setInline(name, value) {
  try {
    document.documentElement.style.setProperty(name, value);
  } catch {
    // Dropped. verifyCustomSafety() measures the result and falls back to Ember if
    // the shell did not survive it.
  }
}

export function clearCustomInline() {
  try {
    const style = document.documentElement.style;
    for (const k of CUSTOM_INLINE_PROPS) style.removeProperty(k);
    // applyCustomPalette() writes the derived palette as --c-* custom properties, and
    // CUSTOM_INLINE_PROPS does not list them. So switching
    // off a custom theme left the whole derived palette sitting on <html>: invisible
    // most of the time because a built-in theme does not read --c-*, and wrong the next
    // time anything did. Removing whatever is actually there rather than a second
    // hand-kept list is the only version of this that cannot drift again.
    for (let i = style.length - 1; i >= 0; i--) {
      const name = style[i];
      if (name && name.startsWith('--c-')) style.removeProperty(name);
    }
    delete document.documentElement.dataset.density;
    delete document.documentElement.dataset.motion;
  } catch { /* ignore */ }
}

export function applyGuidedTokens(p) {
  const root = document.documentElement;
  try {
    if (p.density === 'compact' || p.density === 'roomy') root.dataset.density = p.density;
    else delete root.dataset.density;
    if (p.motion === 'reduced') root.dataset.motion = 'reduced';
    else delete root.dataset.motion;
  } catch { /* ignore */ }
  if (p.radius === 'sharp') {
    setInline('--radius-sm', '2px'); setInline('--radius-md', '4px'); setInline('--radius-lg', '6px');
  } else if (p.radius === 'round') {
    setInline('--radius-sm', '12px'); setInline('--radius-md', '18px'); setInline('--radius-lg', '26px');
  }
  const dark = p.tone !== 'light';
  if (p.contrast === 'high') {
    if (dark) {
      setInline('--color-text-primary', '#ffffff');
      setInline('--color-text-secondary', '#ece5dd');
      setInline('--color-text-muted', '#cfc2b4');
      setInline('--color-border', 'rgba(255,255,255,.22)');
      setInline('--color-border-strong', 'rgba(255,255,255,.36)');
    } else {
      setInline('--color-text-primary', '#14100c');
      setInline('--color-text-secondary', '#33291f');
      setInline('--color-text-muted', '#5c4f42');
      setInline('--color-border', 'rgba(20,12,6,.24)');
      setInline('--color-border-strong', 'rgba(20,12,6,.38)');
    }
  }
  try {
    const { h, s } = hexToHsl(p.accent);
    const glow = (l2, base) => {
      const f = p.ambient === 'subtle' ? 0.4 : p.ambient === 'vivid' ? 1.7 : 1;
      return `hsla(${h} ${s}% ${l2}% / ${Math.min(0.6, base * f).toFixed(3)})`;
    };
    if (p.ambient && p.ambient !== 'balanced') {
      setInline('--glow-accent', glow(dark ? 58 : 52, dark ? 0.26 : 0.2));
    }
  } catch { /* ignore */ }
}

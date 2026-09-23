// Theme system. Single source of truth for theme state (persistence, the
// html[data-theme] attribute, and the Custom palette derivation).

export const DEFAULT_THEME = 'trycord';

export const THEMES = [
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

export function getTheme() {
  let saved = null;
  try { saved = localStorage.getItem(LS_THEME); } catch { /* storage unavailable */ }
  if (saved && THEMES.some((t) => t.id === saved)) return saved;
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr && THEMES.some((t) => t.id === attr)) return attr;
  return DEFAULT_THEME;
}

export function applyTheme() {
  const name = getTheme();
  if (name === 'custom') applyCustomPalette(loadPalette());
  document.documentElement.setAttribute('data-theme', name);
  return name;
}

export function setTheme(name) {
  if (!THEMES.some((t) => t.id === name)) name = DEFAULT_THEME;
  if (name === 'custom') applyCustomPalette(loadPalette());
  document.documentElement.setAttribute('data-theme', name);
  try { localStorage.setItem(LS_THEME, name); } catch { /* ignore */ }
  return name;
}

// ---- Custom palette -----------------------------------------------------

export function loadPalette() {
  try {
    const p = JSON.parse(localStorage.getItem(LS_PALETTE) || '{}');
    if (!p.accent) p.accent = '#ff914d';
    if (p.tone !== 'light') p.tone = 'dark';
    return p;
  } catch {
    return { accent: '#ff914d', tone: 'dark' };
  }
}

export function savePalette(p) {
  try { localStorage.setItem(LS_PALETTE, JSON.stringify(p)); } catch { /* ignore */ }
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
  };
  for (const k in vals) set(k, vals[k]);
  if (dark) {
    set('color-scheme', 'dark');
  } else {
    set('color-scheme', 'light');
  }
}

export default { getTheme, applyTheme, setTheme, loadPalette, savePalette, buildCustom: applyCustomPalette };
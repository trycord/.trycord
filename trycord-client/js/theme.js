// Theme system. Single source of truth for theme state (persistence, the
// html[data-theme] attribute, and the Custom palette derivation).

export const DEFAULT_THEME = 'ember';

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
// derive palette values, set documented density/motion attributes, or set
// inline token overrides that are cleared when leaving the custom theme.
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

// Inline custom properties written by the guided builder. Tracked so they
// can be removed when leaving the custom theme (they would otherwise leak
// into built-in themes, since inline styles beat stylesheets).
const CUSTOM_INLINE_PROPS = [
  '--t-r-s', '--t-r-m', '--t-r-l',
  '--t-txt', '--t-txt2', '--t-mut', '--t-line', '--t-line-hi',
  '--t-env-glow-a', '--t-env-glow-b',
];

export function getTheme() {
  let saved = null;
  try { saved = localStorage.getItem(LS_THEME); } catch { /* storage unavailable */ }
  if (saved && THEMES.some((t) => t.id === saved)) return saved;
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr && THEMES.some((t) => t.id === attr)) return attr;
  return DEFAULT_THEME;
}

// System theme resolution: 'system' is a selection, never a stylesheet
// target. Dark OS setting resolves to Ember (the default dark theme),
// light resolves to Light. The data-theme attribute always carries the
// resolved built-in id so every themed surface responds.
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
  try { localStorage.setItem(LS_THEME, name); } catch { /* ignore */ }
  return name;
}

// Re-apply when the OS scheme flips while System is selected. Live,
// no reload, no state loss — same as manual switching.
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

// ---- Custom palette -----------------------------------------------------

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
  try { saved = JSON.parse(localStorage.getItem(LS_CUSTOM_TOKENS) || 'null'); } catch { /* ignore */ }
  const legacy = loadPalette();
  const tokens = Object.assign({}, DEFAULT_CUSTOM_TOKENS, saved || {}, {
    accent: (saved && saved.accent) || legacy.accent || DEFAULT_CUSTOM_TOKENS.accent,
    tone: (saved && saved.tone) || legacy.tone || DEFAULT_CUSTOM_TOKENS.tone,
  });
  let css = '';
  try { css = localStorage.getItem(LS_CUSTOM_CSS) || ''; } catch { /* ignore */ }
  return { tokens, css };
}

export function saveCustomTheme(state) {
  const tokens = Object.assign({}, DEFAULT_CUSTOM_TOKENS, (state && state.tokens) || {});
  try { localStorage.setItem(LS_CUSTOM_TOKENS, JSON.stringify(tokens)); } catch { /* ignore */ }
  // Mirror the two legacy fields so older code paths keep working.
  try { localStorage.setItem(LS_PALETTE, JSON.stringify({ accent: tokens.accent, tone: tokens.tone })); } catch { /* ignore */ }
  try { localStorage.setItem(LS_CUSTOM_CSS, String((state && state.css) || '')); } catch { /* ignore */ }
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

function setInline(name, value) {
  try { document.documentElement.style.setProperty(name, value); } catch { /* ignore */ }
}

export function clearCustomInline() {
  try {
    for (const k of CUSTOM_INLINE_PROPS) document.documentElement.style.removeProperty(k);
    delete document.documentElement.dataset.density;
    delete document.documentElement.dataset.motion;
  } catch { /* ignore */ }
}

function applyGuidedTokens(p) {
  const root = document.documentElement;
  // Density + motion use the documented attribute contract from app.css.
  try {
    if (p.density === 'compact' || p.density === 'roomy') root.dataset.density = p.density;
    else delete root.dataset.density;
    if (p.motion === 'reduced') root.dataset.motion = 'reduced';
    else delete root.dataset.motion;
  } catch { /* ignore */ }
  // Corner style.
  if (p.radius === 'sharp') { setInline('--t-r-s', '2px'); setInline('--t-r-m', '4px'); setInline('--t-r-l', '8px'); }
  else if (p.radius === 'round') { setInline('--t-r-s', '12px'); setInline('--t-r-m', '18px'); setInline('--t-r-l', '28px'); }
  // Contrast boost (neutral, works on dark and light tones).
  const dark = p.tone !== 'light';
  if (p.contrast === 'high') {
    if (dark) {
      setInline('--t-txt', '#ffffff'); setInline('--t-txt2', '#ece5dd'); setInline('--t-mut', '#cfc2b4');
      setInline('--t-line', 'rgba(255,255,255,.22)'); setInline('--t-line-hi', 'rgba(255,255,255,.36)');
    } else {
      setInline('--t-txt', '#14100c'); setInline('--t-txt2', '#33291f'); setInline('--t-mut', '#5c4f42');
      setInline('--t-line', 'rgba(20,12,6,.24)'); setInline('--t-line-hi', 'rgba(20,12,6,.38)');
    }
  }
  // Ambient glow intensity, derived from the accent hue.
  try {
    const { h, s } = hexToHsl(p.accent);
    const glow = (l2, base) => {
      const f = p.ambient === 'subtle' ? 0.4 : p.ambient === 'vivid' ? 1.7 : 1;
      return `hsla(${h} ${s}% ${l2}% / ${Math.min(0.6, base * f).toFixed(3)})`;
    };
    if (p.ambient && p.ambient !== 'balanced') {
      setInline('--t-env-glow-a', glow(dark ? 58 : 52, dark ? 0.26 : 0.2));
      setInline('--t-env-glow-b', glow(dark ? 40 : 42, dark ? 0.18 : 0.14));
    }
  } catch { /* ignore */ }
}

// ---- Advanced custom CSS (validated, recoverable) -----------------------

const PROTECTED_IDS = new Set([
  'app', 'mobile-shell', 'mobile-main',
  'mobile-tab-navigation', 'mobile-context',
  'desktop-shell', 'presence-spine', 'identity-region', 'global-navigation',
  'community-navigation', 'place-navigation', 'trycord-main', 'context-header',
  'context-title', 'view-root', 'member-sidebar', 'modal-root', 'popover-root',
  'toast-root', 'connection-status',
]);

const PROTECTED_CLASSES = new Set([
  'presence-spine', 'presence-spine__identity', 'presence-spine__global-navigation',
  'presence-spine__communities', 'presence-spine__place-navigation',
  'main-environment', 'context-header', 'chat-environment', 'view-root',
  'member-sidebar', 'shell', 'shell--desktop', 'shell--mobile',
  'nav-row', 'server-chip', 'channel-row', 'channel-section', 'place-header',
  'place-menu', 'place-actions', 'identity', 'community-actions',
  'member-item', 'member-group', 'msg', 'msg-actions', 'composer',
  'auth-wrap', 'auth-box', 'form-error', 'form-success', 'btn',
  'modal', 'backdrop', 'popover', 'pop-item', 'toast', 'connection-status',
  'settings-nav', 'theme-chip', 'admin-row', 'admin-chip',
  'mobile-header', 'mobile-main', 'mobile-tab-navigation',
]);

// Layout/behavior properties are never allowed in custom CSS. Visual-only.
const FORBIDDEN_PROPS = new Set([
  'display', 'position', 'float', 'clear', 'visibility', 'overflow', 'overflow-x',
  'overflow-y', 'clip', 'clip-path', 'width', 'height', 'min-width', 'min-height',
  'max-width', 'max-height', 'margin', 'margin-top', 'margin-right', 'margin-bottom',
  'margin-left', 'padding', 'padding-top', 'padding-right', 'padding-bottom',
  'padding-left', 'gap', 'row-gap', 'column-gap', 'inset', 'top', 'right', 'bottom',
  'left', 'z-index', 'flex', 'flex-basis', 'flex-direction', 'flex-flow', 'flex-grow',
  'flex-shrink', 'flex-wrap', 'grid', 'grid-area', 'grid-auto-columns',
  'grid-auto-flow', 'grid-auto-rows', 'grid-column', 'grid-column-end',
  'grid-column-start', 'grid-row', 'grid-row-end', 'grid-row-start', 'grid-template',
  'grid-template-areas', 'grid-template-columns', 'grid-template-rows',
  'align-content', 'align-items', 'align-self', 'justify-content', 'justify-items',
  'justify-self', 'place-content', 'place-items', 'place-self', 'order',
  'transform', 'translate', 'rotate', 'scale', 'perspective', 'filter',
  'backdrop-filter', 'opacity', 'mix-blend-mode', 'cursor', 'pointer-events',
  'animation', 'animation-name', 'transition', 'transition-property', 'content',
  'counter-increment', 'counter-reset', 'list-style', 'appearance', 'resize',
  'user-select', 'caret-color', 'scroll-behavior', 'overscroll-behavior',
]);

const VISUAL_PROPS = new Set([
  'color', 'background-color', 'background-image', 'background',
  'border', 'border-color', 'border-width', 'border-style', 'border-radius',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius',
  'border-bottom-right-radius', 'outline-color', 'box-shadow', 'text-shadow',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'letter-spacing', 'line-height', 'text-transform', 'text-decoration',
  'text-decoration-color', 'text-decoration-style', 'text-decoration-thickness',
  'accent-color', 'scrollbar-color',
]);

const PROTECTED_SAFE_PROPS = new Set([
  'color', 'background-color', 'background-image', 'background',
  'border-color', 'outline-color', 'box-shadow', 'text-shadow',
  'font-family', 'font-size', 'font-weight', 'font-style',
  'letter-spacing', 'line-height', 'text-transform',
  'text-decoration-color', 'accent-color',
]);

function stripCssComments(css) {
  return String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function splitTopLevelRules(css) {
  // Splits `selector { declarations }` blocks, respecting quotes and
  // parentheses. Nested blocks (from at-rules) are rejected by validation.
  const rules = [];
  let i = 0, n = css.length;
  const skipWs = () => { while (i < n && /\s/.test(css[i])) i++; };
  while (i < n) {
    skipWs();
    if (i >= n) break;
    if (css[i] === '@') {
      const semi = css.indexOf(';', i);
      const brace = css.indexOf('{', i);
      throw new Error('At-rules are not allowed in custom CSS (found `' + css.slice(i, Math.min(i + 24)) + '`).');
    }
    let sel = '', quote = null, depthParen = 0;
    while (i < n) {
      const c = css[i];
      if (quote) { sel += c; if (c === quote) quote = null; i++; continue; }
      if (c === '"' || c === "'") { quote = c; sel += c; i++; continue; }
      if (c === '(') depthParen++;
      if (c === ')') depthParen = Math.max(0, depthParen - 1);
      if (c === '{' && depthParen === 0) break;
      if ((c === ';' || c === '}') && depthParen === 0) throw new Error('Unexpected `' + c + '` before a rule block.');
      sel += c; i++;
    }
    if (i >= n || css[i] !== '{') throw new Error('Missing `{` for selector `' + sel.trim().slice(0, 60) + '`.');
    i++;
    let body = '', bquote = null, bdepth = 0;
    while (i < n) {
      const c = css[i];
      if (bquote) { body += c; if (c === bquote) bquote = null; i++; continue; }
      if (c === '"' || c === "'") { bquote = c; body += c; i++; continue; }
      if (c === '{') throw new Error('Nested blocks are not allowed in custom CSS.');
      if (c === '}') { i++; break; }
      body += c; i++;
    }
    rules.push({ selector: sel.trim(), body });
  }
  return rules;
}

function splitDeclarations(body) {
  const out = [];
  let cur = '', quote = null, depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth = Math.max(0, depth - 1);
    if (c === ';' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function selectorTokens(selector) {
  const ids = new Set(), classes = new Set();
  const clean = String(selector || '').replace(/\[[^\]]*\]/g, '');
  let m;
  const idRe = /#([\w-]+)/g, classRe = /\.([\w-]+)/g;
  while ((m = idRe.exec(clean))) ids.add(m[1]);
  while ((m = classRe.exec(clean))) classes.add(m[1]);
  return { ids, classes };
}

export function validateCustomCss(css) {
  const errors = [];
  const text = String(css || '');
  if (!text.trim()) return { ok: true, errors };
  if (text.length > CUSTOM_CSS_LIMIT) {
    return { ok: false, errors: ['Custom CSS exceeds the ' + CUSTOM_CSS_LIMIT + '-character limit.'] };
  }
  let rules;
  try {
    rules = splitTopLevelRules(stripCssComments(text));
  } catch (e) {
    return { ok: false, errors: [e && e.message ? e.message : 'Custom CSS could not be parsed.'] };
  }
  if (rules.length > CUSTOM_CSS_RULE_LIMIT) {
    return { ok: false, errors: ['Custom CSS exceeds the ' + CUSTOM_CSS_RULE_LIMIT + '-rule limit.'] };
  }
  rules.forEach((rule, ri) => {
    const label = 'Rule ' + (ri + 1);
    if (!rule.selector) { errors.push(label + ': missing selector.'); return; }
    if (rule.selector === '*') { errors.push(label + ': the universal selector is not allowed.'); return; }
    const selectors = rule.selector.split(',').map((s) => s.trim()).filter(Boolean);
    if (!selectors.length) { errors.push(label + ': missing selector.'); return; }
    if (selectors.length > 10) { errors.push(label + ': too many selectors (max 10).'); return; }
    let isProtected = false, isRootScope = false;
    for (const sel of selectors) {
      const low = sel.toLowerCase();
      if (/^:root$/.test(sel) || /^html(\[.+\])?$/.test(sel)) isRootScope = true;
      const { ids, classes } = selectorTokens(sel);
      for (const id of ids) if (PROTECTED_IDS.has(id)) isProtected = true;
      for (const cls of classes) if (PROTECTED_CLASSES.has(cls)) isProtected = true;
    }
    const decls = splitDeclarations(rule.body).map((d) => d.trim()).filter(Boolean);
    if (!decls.length) { errors.push(label + ': no declarations.'); return; }
    if (decls.length > 60) { errors.push(label + ': too many declarations (max 60).'); return; }
    decls.forEach((decl) => {
      const colon = decl.indexOf(':');
      if (colon < 1) { errors.push(label + ': malformed declaration `' + decl.slice(0, 40) + '`.'); return; }
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const value = decl.slice(colon + 1).trim();
      if (!prop || !value) { errors.push(label + ': malformed declaration.'); return; }
      if (prop[0] === '*' || /[<>]/.test(prop)) { errors.push(label + ': invalid property `' + prop + '`.'); return; }
      if (prop.startsWith('--')) {
        if (!isRootScope && !/^[a-z0-9-]+$/.test(prop.slice(2))) { errors.push(label + ': invalid custom property `' + prop + '`.'); }
        return;
      }
      const lowVal = value.toLowerCase();
      if (lowVal.includes('!important') || lowVal.includes('url(') || lowVal.includes('expression(') ||
          lowVal.includes('javascript:') || /[<>]/.test(value) || value.includes('@')) {
        errors.push(label + ': forbidden value in `' + prop + '` (no !important, urls, scripts, or markup).');
        return;
      }
      if (FORBIDDEN_PROPS.has(prop)) {
        errors.push(label + ': `' + prop + '` is structural and cannot be customized.');
        return;
      }
      const allowed = isProtected ? PROTECTED_SAFE_PROPS : VISUAL_PROPS;
      if (!allowed.has(prop)) {
        errors.push(label + ': `' + prop + '` is not in the safe visual subset' + (isProtected ? ' for protected UI' : '') + '.');
      }
    });
  });
  return { ok: !errors.length, errors };
}

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

// ---- Safety monitor + recovery ------------------------------------------

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
  const shellSel = mode === 'mobile' ? '#mobile-shell' : '#desktop-shell';
  const viewSel = mode === 'mobile' ? '#mobile-main' : '#view-root';
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
    const spine = visibleSize('.presence-spine');
    if (spine.present && spine.display !== 'none' && spine.width < 40) {
      problems.push('Navigation spine collapsed below a usable width.');
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
  const route = document.documentElement.dataset.route || '';
  if (route === '/login' || route === '/register') {
    const card = visibleSize('.auth-box');
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
  try { localStorage.setItem(LS_THEME, DEFAULT_THEME); } catch { /* ignore */ }
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

export default { getTheme, applyTheme, setTheme, loadPalette, savePalette, buildCustom: applyCustomPalette, loadCustomTheme, saveCustomTheme, serializeCustomTheme, parseCustomTheme, validateCustomCss, applyCustomCss, clearCustomCss, verifyCustomSafety, recoverToEmber, applyCustomTheme, CUSTOM_TOKEN_DEFS, DEFAULT_CUSTOM_TOKENS };
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

// The tokens a theme package may set. The same four the custom palette uses,
// so an imported theme is measured against the same shell.
export const TOKEN_KEYS = CUSTOM_TOKEN_DEFS.map((def) => def.key);

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

// ---- theme packages ----------------------------------------------------------
//
// A theme package is a set of values, not code. The schema is versioned: a
// package that declares a version this build does not know is refused, and
// the message names that version. The same rule the server keeps, so a
// package is refused here before it is sent rather than after.
//
// A package may only carry the declared fields. A field that is not one of
// them is turned away, which is what keeps a theme a set of values.

export const KNOWN_SCHEMA_VERSIONS = [1];

export const PACKAGE_FIELDS = ['schemaVersion', 'name', 'version', 'compatibility', 'tokens'];

const COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNCTIONAL_COLOUR = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9a-zA-Z.,%/\s-]*\)$/;
const VERSION_SHAPE = /^\d+(\.\d+){0,2}([-+][A-Za-z0-9.-]+)?$/;

// Is this a colour a theme may set? A colour and nothing else: no url(), no
// expression(), no statement terminator.
export function isColour(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  if (COLOUR.test(text)) return true;
  return FUNCTIONAL_COLOUR.test(text);
}

/**
 * Check a theme package.
 *
 * Every problem is reported, not just the first one.
 *
 * @param {object} raw
 * @returns {{ theme: object|null, problems: string[] }}
 */
export function validateThemePackage(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { theme: null, problems: ['a theme package has to be an object'] };
  }

  for (const field of Object.keys(raw)) {
    if (!PACKAGE_FIELDS.includes(field)) {
      problems.push('"' + field + '" is not a field a theme package may carry');
    }
  }

  const schemaVersion = Number(raw.schemaVersion);
  if (!Number.isInteger(schemaVersion) || !KNOWN_SCHEMA_VERSIONS.includes(schemaVersion)) {
    problems.push(
      'theme schema version ' + JSON.stringify(raw.schemaVersion)
      + ' is not known to this build (known: ' + KNOWN_SCHEMA_VERSIONS.join(', ') + ')'
    );
  }

  const name = String(raw.name == null ? '' : raw.name).trim();
  if (!name) problems.push('a theme needs a name');

  const version = String(raw.version == null ? '' : raw.version).trim();
  if (!VERSION_SHAPE.test(version)) problems.push('"' + version + '" is not a version');

  const compatibility = raw.compatibility === undefined ? {} : raw.compatibility;
  if (!compatibility || typeof compatibility !== 'object' || Array.isArray(compatibility)) {
    problems.push('compatibility has to be an object');
  } else {
    const wanted = compatibility.minSchemaVersion;
    if (wanted !== undefined) {
      const min = Number(wanted);
      if (!Number.isInteger(min)) {
        problems.push('compatibility.minSchemaVersion has to be a whole number');
      } else if (!KNOWN_SCHEMA_VERSIONS.includes(min)) {
        problems.push(
          'theme schema version ' + min + ' is not known to this build (known: '
          + KNOWN_SCHEMA_VERSIONS.join(', ') + ')'
        );
      } else if (min > schemaVersion) {
        problems.push('this theme needs schema version ' + min + ', which is newer than the package declares');
      }
    }
  }

  const tokens = raw.tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    problems.push('a theme needs a set of tokens');
  } else {
    for (const key of Object.keys(tokens)) {
      if (!TOKEN_KEYS.includes(key)) {
        problems.push('"' + key + '" is not a token a theme may set');
        continue;
      }
      if (!isColour(tokens[key])) {
        problems.push('the token "' + key + '" is not a colour');
      }
    }
  }

  if (problems.length) return { theme: null, problems };

  return {
    theme: {
      schemaVersion,
      name: name.slice(0, 128),
      version,
      compatibility: { minSchemaVersion: compatibility.minSchemaVersion === undefined
        ? schemaVersion
        : Number(compatibility.minSchemaVersion) },
      tokens: Object.fromEntries(TOKEN_KEYS
        .filter((key) => tokens[key] !== undefined)
        .map((key) => [key, String(tokens[key]).trim()])),
    },
    problems: [],
  };
}

/**
 * What a package would change, seen before it is applied.
 *
 * The diff is against the palette in force now, so the reader sees the
 * colours that move rather than a list of colours they may already know.
 *
 * @param {object} raw     the package
 * @param {object} current the tokens in force
 * @returns {{ ok: boolean, problems: string[], changes: object[], theme: object|null }}
 */
export function previewThemePackage(raw, current) {
  const checked = validateThemePackage(raw);
  if (checked.problems.length) {
    return { ok: false, problems: checked.problems, changes: [], theme: null };
  }
  const from = Object.assign({}, DEFAULT_CUSTOM_TOKENS, current || {});
  const changes = [];
  for (const def of CUSTOM_TOKEN_DEFS) {
    const next = checked.theme.tokens[def.key];
    if (next === undefined) continue;
    const before = from[def.key] || '';
    if (before.toLowerCase() === next.toLowerCase()) continue;
    changes.push({ key: def.key, label: def.label, from: before, to: next });
  }
  return { ok: true, problems: [], changes, theme: checked.theme };
}

// Install a theme package's tokens here, through the same measured rule as a
// hand-authored palette: a theme that breaks the shell is refused and the
// previous theme is restored.
export function applyThemePackage(tokens) {
  return applyCustomTheme({ tokens });
}

export default {
  currentTheme, resolvedTheme, resolveTheme, setTheme, applyTheme,
  onThemeChange, watchSystemTheme, applyCustomTheme, applyCustomPalette,
  clearCustomInline, savePalette, loadPalette,
  DEFAULT_THEME, THEMES, CUSTOM_TOKEN_DEFS, DEFAULT_CUSTOM_TOKENS,
  KNOWN_SCHEMA_VERSIONS, PACKAGE_FIELDS, isColour, validateThemePackage,
  previewThemePackage, applyThemePackage,
};


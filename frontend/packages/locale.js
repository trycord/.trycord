// Localisation.
//
// The reader's own language, the packs this instance has, and the formatting
// that follows from the locale they chose.
//
// Three things live here, and they are the whole of it:
//
//   - the preference, which the server keeps for the reader and the reader
//     changes by asking for it
//   - the catalogue of strings a pack provides, which the client reads where
//     it has a key for it
//   - the formatting, which follows the locale: a date in French is written
//     in French
//
// The strings themselves are English in the source. A pack may translate any
// string the build declares, and the client asks for the catalogue rather
// than carrying a second copy of it, so a pack that translates nothing leaves
// the interface exactly as it was.

import Api from './api.js';

// The state the client holds: the locale in force, where it came from, the
// strings the pack provides, and the locales this instance can answer in.
const state = {
  locale: 'en',
  source: 'fallback',
  strings: {},
  locales: [],
  pack: null,
};

const listeners = new Set();

function notify() {
  for (const handler of Array.from(listeners)) {
    try { handler(state.locale, state.source); } catch { /* a listener must not break the locale */ }
  }
}

// The locale in force.
export function currentLocale() {
  return state.locale || 'en';
}

// Where the locale came from: the reader, the instance, the browser, or
// nothing at all.
export function currentSource() {
  return state.source || 'fallback';
}

// The pack in force, if any.
export function currentPack() {
  return state.pack;
}

// The strings the pack provides. A pack that translates part of the
// catalogue leaves the rest as the source wrote it.
export function strings() {
  return state.strings;
}

// The locales this instance has a pack for.
export function availableLocales() {
  return state.locales.slice();
}

// A string from the catalogue, or the fallback the caller gave.
export function t(key, fallback) {
  if (state.strings && Object.prototype.hasOwnProperty.call(state.strings, key)) {
    return state.strings[key];
  }
  return fallback === undefined ? key : fallback;
}

// Listen for the locale changing. Returns the unsubscribe.
export function onLocaleChange(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

// Read the locale this instance is answering in, and the catalogue it is
// answering with. A signed-in reader gets their own preference; a reader who
// is not signed in gets the instance's.
export async function loadLocale(serverId) {
  const answer = await Api.localisation(serverId);
  state.locale = (answer && answer.locale) || 'en';
  state.source = (answer && answer.source) || 'fallback';
  state.pack = (answer && answer.pack) || null;
  state.strings = (answer && answer.strings) || {};
  state.locales = Array.isArray(answer && answer.locales) ? answer.locales : [];
  notify();
  return state;
}

// The reader's own preference: the locale they chose, or nothing when they
// follow the instance.
export async function loadPreference() {
  const answer = await Api.localisationPreference();
  return answer && answer.locale ? answer.locale : null;
}

// Change the reader's preference and take effect at once.
//
// The server keeps the preference and the client re-reads the catalogue, so
// the strings that arrive are the ones the instance is serving for this
// reader rather than a guess made here.
export async function setPreference(locale) {
  const wanted = locale ? String(locale).trim() : null;
  await Api.setLocalisationPreference(wanted);
  await loadLocale();
  repaint();
  return state.locale;
}

// The interface redraws itself, so the dates and numbers already on screen are
// written the new way rather than the next time they are drawn.
export function repaint() {
  try {
    window.dispatchEvent(new window.CustomEvent('trycord:navigate', { detail: {} }));
  } catch { /* no document */ }
}

// ---- formatting --------------------------------------------------------------

// A locale the Intl API will accept. An unknown tag falls back rather than
// throwing in the middle of a page.
function tag() {
  const wanted = currentLocale();
  try {
    Intl.DateTimeFormat(wanted);
    return wanted;
  } catch {
    return 'en';
  }
}

// A date, written the way the reader's locale writes it.
export function formatDate(value, options) {
  const date = value instanceof Date ? value : new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  const opts = options || { year: 'numeric', month: 'short', day: 'numeric' };
  try {
    return new Intl.DateTimeFormat(tag(), opts).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

// A date and a time.
export function formatDateTime(value, options) {
  const date = value instanceof Date ? value : new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  const opts = options || {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  };
  try {
    return new Intl.DateTimeFormat(tag(), opts).format(date);
  } catch {
    return date.toISOString();
  }
}

// The time of day.
export function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(tag(), { hour: 'numeric', minute: '2-digit' }).format(date);
  } catch {
    return '';
  }
}

// A number, written the way the reader's locale writes it.
export function formatNumber(value, options) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  try {
    return new Intl.NumberFormat(tag(), options).format(n);
  } catch {
    return String(n);
  }
}

export default {
  currentLocale, currentSource, currentPack, strings, availableLocales, t,
  onLocaleChange, loadLocale, loadPreference, setPreference, repaint,
  formatDate, formatDateTime, formatTime, formatNumber,
};

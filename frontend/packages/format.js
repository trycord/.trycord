// Presentation helpers. No module here reads state or touches the network: they
// turn a value the server sent into the string a person reads.
//
// The dates and numbers are written the way the reader's locale writes them,
// so a pack that changes the language changes the way a date reads too.

import locale from './locale.js';

const UNITS = [
  ['year', 31536000000],
  ['month', 2592000000],
  ['week', 604800000],
  ['day', 86400000],
  ['hour', 3600000],
  ['minute', 60000],
];

export function toDate(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  // The API sends ISO strings; SQLite-backed rows sometimes send epoch millis.
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(n) && n > 1000000000 && String(value).length <= 14) return new Date(n);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function relativeTime(value) {
  const d = toDate(value);
  if (!d) return '';
  const diff = Date.now() - d.getTime();
  const abs = Math.abs(diff);
  if (abs < 45000) return 'just now';
  if (abs < 3600000) return Math.round(abs / 60000) + 'm ago';
  if (abs < 86400000) return Math.round(abs / 3600000) + 'h ago';
  if (abs < 604800000) return Math.round(abs / 86400000) + 'd ago';
  return shortDate(d);
}

export function shortDate(value) {
  const d = toDate(value);
  if (!d) return '';
  const now = new Date();
  const opts = d.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' };
  return locale.formatDate(d, opts);
}

export function joinedLabel(value) {
  const d = toDate(value);
  if (!d) return '';
  const now = new Date();
  const opts = d.getFullYear() === now.getFullYear()
    ? { month: 'long', day: 'numeric' }
    : { month: 'long', year: 'numeric' };
  return locale.formatDate(d, opts);
}

export function timeOfDay(value) {
  const d = toDate(value);
  if (!d) return '';
  return locale.formatTime(d);
}

// The label above a run of messages: Today, Yesterday, or a date.
export function dayLabel(value) {
  const d = toDate(value);
  if (!d) return '';
  const now = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (days === 0) return locale.t('date.today', 'Today');
  if (days === 1) return locale.t('date.yesterday', 'Yesterday');
  if (days < 7) return locale.formatDate(d, { weekday: 'long' });
  return shortDate(d);
}

export function fullTimestamp(value) {
  const d = toDate(value);
  if (!d) return '';
  return locale.formatDateTime(d, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// Grouping is by wall-clock proximity, not by a fixed slot: two messages are in
// the same run when the same author sent them within seven minutes.
export function sameRun(a, b, windowMs) {
  const da = toDate(a);
  const db = toDate(b);
  if (!da || !db) return false;
  return db.getTime() - da.getTime() < (windowMs || 7 * 60 * 1000);
}

export function fileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return locale.formatNumber(n) + ' B';
  if (n < 1024 * 1024) {
    return locale.formatNumber(Number((n / 1024).toFixed(n < 10240 ? 1 : 0)), { maximumFractionDigits: 1 }) + ' KB';
  }
  if (n < 1024 * 1024 * 1024) {
    return locale.formatNumber(Number((n / (1024 * 1024)).toFixed(1)), { maximumFractionDigits: 1 }) + ' MB';
  }
  return locale.formatNumber(Number((n / (1024 * 1024 * 1024)).toFixed(2)), { maximumFractionDigits: 2 }) + ' GB';
}

export function initials(name) {
  const text = String(name || '').trim();
  if (!text) return '?';
  const words = text.replace(/[_-]+/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

// A stable hue per identity, so the same person is the same colour everywhere
// without the server having to store one.
export function hueOf(id) {
  const text = String(id || '');
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

export function plural(count, one, many) {
  return count === 1 ? one : (many || one + 's');
}

export function truncate(text, max) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)).trimEnd() + '\u2026';
}

// Mention and channel tokens, used by the composer's inline highlighting and by
// the message renderer. Deliberately conservative: an @ inside a word is not a
// mention.
const MENTION = /(^|[\s([{])@([a-zA-Z0-9_.-]{2,32})/g;
const CHANNEL = /(^|[\s([{])#([a-z0-9][a-z0-9-]{0,38})/g;

export function findMentions(text) {
  const out = [];
  let m;
  MENTION.lastIndex = 0;
  while ((m = MENTION.exec(String(text || '')))) out.push(m[2]);
  return out;
}

export function tokensIn(text) {
  const source = String(text || '');
  const marks = [];
  let m;
  const mention = new RegExp(MENTION.source, 'g');
  while ((m = mention.exec(source))) marks.push({ at: m.index + m[1].length, end: m.index + m[0].length, kind: 'mention' });
  const channel = new RegExp(CHANNEL.source, 'g');
  while ((m = channel.exec(source))) marks.push({ at: m.index + m[1].length, end: m.index + m[0].length, kind: 'channel' });
  marks.sort((a, b) => a.at - b.at);
  return marks;
}

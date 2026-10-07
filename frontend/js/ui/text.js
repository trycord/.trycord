import { el } from './dom.js';
import { TrycordConfig } from '../config.js';

// Text and time formatting.
// 
// Not UI in the sense the rest of this directory means it, and the two most-called
// functions in the client were sitting next to the modal system.

export function insertAtCursor(field, text) {
  try {
    field.focus();
    const s = field.selectionStart == null ? field.value.length : field.selectionStart;
    const e = field.selectionEnd == null ? field.value.length : field.selectionEnd;
    field.setRangeText(String(text), s, e, 'end');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  } catch {
    field.value += text;
  }
  focusQuietly(field)
}


// A count and its noun. `plural('member')` reads better at the call site than
// `n + ' member' + (n === 1 ? '' : 's')`, and it cannot be got wrong by forgetting
// the ternary.
export function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : (many || one + 's'));
}


export function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 604800) return Math.floor(s / 86400) + 'd';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function fullTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}


export function apiSrc(path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return TrycordConfig.apiUrl().replace(/\/+$/, '') + path;
}

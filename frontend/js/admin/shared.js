import { esc, el, btn, clear, relTime, fullTime } from '../ui.js';
import { statusChip } from '../components.js';
import { navigate } from '../nav.js';

export function debounced(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function denied(msg) {
  return el('div', { class: 'empty-state' },
    el('div', { class: 'form-error' }, msg || 'You do not have platform administration access.'),
    el('div', { class: 'row-line' },
      el('button', { class: 'btn primary', type: 'button', onClick: () => { navigate('/home'); } }, 'Home')));
}

export function loadError(ex, retry) {
  return el('div', { class: 'empty-state' },
    el('div', { class: 'form-error' }, (ex && ex.message) || 'Failed to load.'),
    el('button', { class: 'btn primary', type: 'button', onClick: retry }, 'Retry'));
}

// server's own message so we never fabricate a cause.
// render() handles its own fetch failure, so this is only reached if it throws for
// some other reason. Left unhandled, that rejection vanished and the reader was
// left looking at the previous filter's rows under the label of the new filter -
// reports, appeals and audit entries, all read as something other than what was on
// screen.
export function reportListFailure(listWrap) {
  return (ex) => {
    clear(listWrap);
    listWrap.appendChild(el('p', { class: 'form-error' }, adminError(ex, 'Could not load that list.')));
  };
}

export function adminError(ex, fallback) {
  const code = ex && ex.code;
  if (code === 'AUTH_REQUIRED') return 'You need to sign in to perform this action.';
  if (code === 'PERMISSION_DENIED') return 'You do not have permission to perform this action.';
  if (code === 'NOT_FOUND' || code === 'SERVER_NOT_FOUND') return 'This community could not be found. It may already be gone.';
  if (code === 'USER_NOT_FOUND') return 'This account could not be found.';
  return (ex && ex.message) || fallback || 'The request could not be completed. Please try again.';
}

export function statTile(label, value) {
  return el('div', { class: 'admin-stat' }, el('b', {}, value), el('span', {}, label));
}

export function actionRow(a) {
  return el('div', { class: 'admin-history-row' },
    statusChip(a.actionType || 'ACTION'),
    el('div', { class: 'grow' },
      el('div', {}, esc(a.reason || '(no reason)')),
      el('div', { class: 'muted small' },
        (a.actor_name ? esc(a.actor_name) + ' · ' : '') + relTime(a.createdAt),
        a.expiresAt ? ' · expires ' + fullTime(a.expiresAt) : '')),
    el('div', { class: 'muted small admin-when' }, relTime(a.createdAt)));
}

// The paint sequence number. Sections receive theirs as an argument; only the frame
// issues one, so it lives here with the rest of the shared state.
let adminSeq = 0;

export const nextSeq = () => ++adminSeq;
export const currentSeq = () => adminSeq;

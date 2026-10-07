// What a pane shows when it has nothing better: loading, empty, failed.
//
// A bare catch used to leave the surface blank, and a blank pane is indistinguishable
// from a slow network.
import { clear, el, toast } from './ui.js';
import { emptyState } from './components.js';

// Reserves its own height so content doesn't jump in, and announces itself.
export function loadingState(label = 'Loading', opts = {}) {
  const box = el('div', {
    class: 'state-block state-block--loading',
    role: 'status',
    'aria-live': 'polite',
  });
  const bar = el('div', { class: 'skeleton' });
  bar.setAttribute('aria-hidden', 'true');
  box.appendChild(bar);
  const text = el('span', { class: 'state-block__label' }, label + '…');
  box.appendChild(text);
  if (opts.detail) box.appendChild(el('span', { class: 'muted small' }, opts.detail));
  return box;
}

// Worded differently from an error on purpose. "You have not blocked anyone" and
// "we could not load your blocks" have to be tellable apart at a glance.
export function emptyMessage(title, detail, action) {
  return emptyState(null, title, detail, action);
}

// Prefers the server's own wording - "This conversation is not available" beats
// anything generic. Retry only when the caller can repeat the request.
export function errorState(message, onRetry, opts = {}) {
  const box = el('div', {
    class: 'state-block state-block--error',
    role: 'alert',
  });
  const line = el('div', { class: 'state-block__label' }, message || opts.fallback || 'Something went wrong.');
  box.appendChild(line);
  if (opts.detail) box.appendChild(el('div', { class: 'muted small' }, opts.detail));
  if (onRetry) {
    const retry = el('button', { class: 'btn ghost sm', type: 'button' }, 'Try again');
    retry.addEventListener('click', () => {
      retry.disabled = true;
      retry.textContent = 'Retrying…';
      Promise.resolve(onRetry()).catch(() => {
        // The retry paints its own outcome into the host; this only makes sure
        // the button is not left stuck disabled if it throws before doing so.
        retry.disabled = false;
        retry.textContent = 'Try again';
      });
    });
    box.appendChild(el('div', { class: 'state-block__actions' }, retry));
  }
  return box;
}

// Paint into a host, replacing what's there. Callers that repaint on every
// attempt use this so the three cases can't drift apart.
export function paintState(host, kind, payload) {
  if (!host) return null;
  clear(host);
  let node;
  if (kind === 'loading') node = loadingState(payload && payload.label, payload || {});
  else if (kind === 'error') node = errorState(payload && payload.message, payload && payload.onRetry, payload || {});
  else if (kind === 'empty') node = emptyMessage(payload && payload.title, payload && payload.detail, payload && payload.action);
  else return null;
  host.appendChild(node);
  return node;
}

// repaintView() invokes the refresh function without awaiting it, so a rejection has
// nowhere to go. Six call sites answered that with .catch(() => {}), which does
// stop the unhandled rejection and does nothing else: the panel quietly stops
// updating, and a panel that has stopped updating looks exactly like a panel where
// nothing changed. A role moved, a channel was renamed, and the member list went on
// showing the old one with no hint that it had.
//
// Warned once per window rather than per event. repaintView fires on realtime
// messages, and a listener that complains about each one is worse than one that
// complains once.
const STALE_WARN_WINDOW = 30000;
let lastStaleWarning = 0;

export function onStale(what) {
  return (ex) => {
    const now = Date.now();
    if (now - lastStaleWarning < STALE_WARN_WINDOW) return;
    lastStaleWarning = now;
    const why = (ex && ex.message) ? ': ' + ex.message : '.';
    toast(what + ' could not be refreshed' + why, 'warn');
  };
}

export default { loadingState, emptyMessage, errorState, paintState, onStale };
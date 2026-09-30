// The three states a surface that fetches can be in.
//
// Before this there were three unrelated answers to "this has no data yet".
// A bare muted paragraph reading "Loading…", which is invisible to a screen
// reader as a status and shifts layout when it is replaced; an inline style
// empty-state built by emptyState(); and, on a failure, whatever the catch block
// happened to append - usually nothing, so the surface just stayed blank with no
// explanation and no way to try again.
//
// A blank pane is the worst of them, because it is indistinguishable from a
// slow network. Every fetch in the client routes its pending and failed states
// through here so that "nothing yet" always looks like nothing yet, always says
// so, and always offers the retry that is missing from a raw catch.

import { el, clear } from './ui.js';
import { emptyState } from './components.js';

/**
 * A pending surface.
 *
 * The row reserves its own height so the content does not jump when it arrives,
 * and it is a live region so a screen reader announces the change rather than
 * the reader discovering it by listening for nothing.
 */
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

/**
 * A surface with nothing in it.
 *
 * This is not the same as an error and must not look like one: "you have not
 * blocked anyone" and "we could not load your blocks" need different words, and a
 * reader who cannot tell them apart has to guess whether to retry.
 */
export function emptyMessage(title, detail, action) {
  return emptyState(null, title, detail, action);
}

/**
 * A surface whose fetch failed.
 *
 * The server's own message is shown when it sent one, because "This conversation
 * is not available" tells a reader more than anything generic would. A retry is
 * offered whenever the caller can repeat the request, which is the difference
 * between a dead end and a slow network.
 */
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

/**
 * Render one of the three into a host, replacing whatever was there.
 *
 * Callers that paint into a host on every attempt use this rather than clear()
 * followed by a branch, because the three cases then cannot drift apart.
 */
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

export default { loadingState, emptyMessage, errorState, paintState };
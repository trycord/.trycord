// The phone's interaction kit.
//
// A bottom sheet for every action, a long-press for every context, a toast for
// every answer. The primitives are small and one-way: open a sheet, it closes;
// press and hold, the actions come.

import { el, clear } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';

// --- bottom sheet -----------------------------------------------------------

let sheetLive = null;

/**
 * Open a bottom sheet. Returns { close, body } — the caller fills `body` and
 * calls close() when it is done.
 * @param {{ title: string, note?: string }} options
 */
export function sheet(options) {
  closeSheet();
  const veil = el('div', { class: 'm-sheet-veil' });
  const grip = el('div', { class: 'm-sheet__grip' });
  const title = el('div', { class: 'm-sheet__title' }, (options && options.title) || '');
  const quit = el('button', {
    class: 'm-bar__btn', type: 'button', 'aria-label': 'Close',
    onClick: () => close(),
  }, icon('x', { size: 20 }));
  const head = el('div', { class: 'm-sheet__head' }, title, quit);
  const body = el('div', { class: 'm-sheet__body' });
  if (options && options.note) body.appendChild(el('p', { class: 'm-sheet__note' }, options.note));
  const panel = el('div', { class: 'm-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title.textContent },
    grip, head, body);

  // While the sheet is open, the keyboard belongs to it: Tab stays inside the
  // panel, and the reader's place is given back when it closes.
  let returnFocus = null;
  function trapFocus(event) {
    if (event.key !== 'Tab') return;
    const focusable = panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    else if (!panel.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
  }
  function onKeydown(event) {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
    else trapFocus(event);
  }
  function close() {
    if (!sheetLive || sheetLive.panel !== panel) return;
    sheetLive = null;
    panel.classList.remove('is-open');
    veil.style.opacity = '0';
    veil.style.transition = 'opacity 120ms var(--tc-ease)';
    setTimeout(() => { veil.remove(); panel.remove(); }, 160);
    document.removeEventListener('keydown', onKeydown, true);
    if (returnFocus && returnFocus.focus) returnFocus.focus();
  }
  veil.addEventListener('click', close);
  document.addEventListener('keydown', onKeydown, true);
  document.body.appendChild(veil);
  document.body.appendChild(panel);
  requestAnimationFrame(() => {
    panel.classList.add('is-open');
    returnFocus = document.activeElement;
    const first = panel.querySelector('button, [href], input, select, textarea');
    if (first) first.focus();
  });
  sheetLive = { panel, close };
  return { close, body };
}

export function closeSheet() {
  if (sheetLive) sheetLive.close();
}

// --- confirm ------------------------------------------------------------------

/** A question the reader answers with one press. Resolves true/false. */
export function confirm(options) {
  return new Promise((resolve) => {
    const layer = sheet({ title: (options && options.title) || 'Are you sure?' });
    const text = el('p', { class: 'm-sheet__note' }, (options && options.text) || '');
    const no = el('button', { class: 'm-go m-go--quiet', type: 'button', onClick: () => answer(false) }, (options && options.cancelLabel) || 'Keep it');
    const yes = el('button', {
      class: 'm-go' + ((options && options.danger) ? ' m-go--danger' : ''),
      type: 'button', onClick: () => answer(true),
    }, (options && options.confirmLabel) || 'Confirm');
    function answer(out) { layer.close(); resolve(out); }
    layer.body.append(text, el('div', { class: 'm-stack' }, no, yes));
  });
}

// --- toast ---------------------------------------------------------------------

export function toast(message, options) {
  const kind = options && options.type;
  const host = document.getElementById('m-toasts');
  if (!host) return;
  const node = el('div', { class: 'm-toast' + (kind ? ' m-toast--' + kind : '') },
    el('span', { class: 'm-toast__text' }, message));
  host.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity 160ms var(--tc-ease)';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 180);
  }, 3200);
}

/** The one-line answer to a refused request: the sentence the server sent. */
export function failed(error) {
  toast((error && error.message) || 'That did not go through.', { type: 'danger' });
}

// --- long press ------------------------------------------------------------------

/**
 * Attach a long-press that opens a menu of actions at the finger. The same
 * primitive the desktop uses for touch, kept under the same name: press and
 * hold a row, a message, a face.
 */
export function attachLongPress(target, builder) {
  let timer = null;
  let startX = 0; let startY = 0;
  const CANCEL_MS = 460;

  function openAt(x, y) {
    const items = builder();
    if (!items || !items.length) return;
    const menu = el('div', {
      class: 'm-menu', role: 'menu',
      style: { left: Math.min(x, window.innerWidth - 232) + 'px', top: Math.min(y, window.innerHeight - 40 - items.length * 44) + 'px' },
    });
    for (const item of items) {
      if (!item) continue;
      menu.appendChild(el('button', {
        class: 'm-menu__item' + (item.danger ? ' m-menu__item--danger' : ''),
        type: 'button', role: 'menuitem',
        onClick: () => { menu.remove(); veil.remove(); if (item.onClick) item.onClick(); },
      }, item.icon ? icon(item.icon, { size: 17 }) : null, item.label));
    }
    const veil = el('div', { class: 'm-sheet-veil' });
    veil.addEventListener('click', () => { veil.remove(); menu.remove(); });
    document.addEventListener('keydown', function onKey(event) {
      if (event.key === 'Escape') { veil.remove(); menu.remove(); document.removeEventListener('keydown', onKey, true); }
    }, true);
    document.body.appendChild(veil);
    document.body.appendChild(menu);
  }

  target.addEventListener('touchstart', (event) => {
    const touch = event.touches[0];
    startX = touch.clientX; startY = touch.clientY;
    timer = setTimeout(() => {
      timer = null;
      if (navigator.vibrate) { try { navigator.vibrate(8); } catch { /* no vibration */ } }
      openAt(startX, startY);
    }, CANCEL_MS);
  }, { passive: true });
  target.addEventListener('touchmove', (event) => {
    if (!timer) return;
    const touch = event.touches[0];
    if (Math.abs(touch.clientX - startX) > 12 || Math.abs(touch.clientY - startY) > 12) {
      clearTimeout(timer); timer = null;
    }
  }, { passive: true });
  target.addEventListener('touchend', () => { if (timer) { clearTimeout(timer); timer = null; } }, { passive: true });
  target.addEventListener('touchcancel', () => { if (timer) { clearTimeout(timer); timer = null; } }, { passive: true });
}

// --- small builders ---------------------------------------------------------------

/** A labelled section: kicker over a card. */
export function section(kicker, ...children) {
  return el('section', { class: 'm-stack' },
    el('div', { class: 'm-kicker' }, kicker),
    ...children);
}

/** The state pages: nothing here yet, could not read it, still working. */
export function emptyState(icon_0, title, text) {
  return el('div', { class: 'm-empty' },
    el('div', { class: 'm-empty__icon' }, icon(icon_0, { size: 24 })),
    el('div', { class: 'm-empty__title' }, title),
    text ? el('p', { class: 'm-empty__text' }, text) : null);
}

export function failure(error, retry) {
  const node = el('div', { class: 'm-fault' },
    el('p', { class: 'm-fault__text' }, (error && error.message) || 'Could not read that.'));
  if (retry) node.appendChild(el('button', { class: 'm-go m-go--quiet', type: 'button', onClick: retry }, 'Try again'));
  return node;
}

export function hold() {
  return el('div', { class: 'm-hold' }, el('div', { class: 'spinner' }));
}

/** A form field: label over control. */
export function field(label, control) {
  return el('label', { class: 'm-field' }, el('span', { class: 'm-field__label' }, label), control);
}

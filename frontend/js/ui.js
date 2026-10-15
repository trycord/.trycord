// Overlays and feedback.
//
// One place that knows how a menu closes, how a dialog traps focus and how a
// toast is dismissed. A view asks for the outcome; it does not build the
// mechanism, which is how every screen ended up with its own slightly different
// idea of whether Escape cancels or closes.

import { el, qs, trapFocus } from '../packages/dom.js';
import { icon } from '../packages/icons.js';

// -- toasts ------------------------------------------------------------------

let toastHost = null;

function host() {
  if (toastHost && document.body.contains(toastHost)) return toastHost;
  toastHost = el('div', { class: 'toasts', role: 'region', 'aria-label': 'Notifications' });
  document.body.appendChild(toastHost);
  return toastHost;
}

export function toast(message, options) {
  const opts = options || {};
  const node = el('div', { class: 'toast toast--' + (opts.type || 'info'), role: 'status' },
    icon(opts.type === 'error' ? 'alert' : opts.type === 'success' ? 'check' : 'info', { size: 18 }),
    el('div', { class: 'toast-text' }, message),
    opts.action
      ? el('button', {
        class: 'btn btn--sm btn--ghost',
        type: 'button',
        onClick: () => { opts.action.onClick(); dismiss(); },
      }, opts.action.label)
      : null,
    el('button', {
      class: 'toast-close', type: 'button', 'aria-label': 'Dismiss',
      onClick: () => dismiss(),
    }, icon('x', { size: 15 })),
  );

  function dismiss() {
    if (!node.parentNode) return;
    node.remove();
  }

  host().appendChild(node);
  const timeout = opts.timeout === undefined ? (opts.type === 'error' ? 7000 : 4500) : opts.timeout;
  if (timeout > 0) setTimeout(dismiss, timeout);
  return dismiss;
}

export function errorToast(error) {
  const message = error && error.message ? error.message : 'Something went wrong.';
  return toast(message, { type: 'error' });
}

// -- modal -------------------------------------------------------------------

const openLayers = [];

export function isOverlayOpen() {
  return openLayers.length > 0;
}

export function closeTopOverlay() {
  const top = openLayers[openLayers.length - 1];
  if (top) top.close();
  return !!top;
}

// A dialog is a promise about focus and Escape, so every dialog goes through
// here. `render` receives a close callback and returns the dialog element.
export function openDialog(options) {
  const opts = options || {};
  const overlay = el('div', { class: 'overlay', role: 'presentation' });
  let released = false;

  const layer = {
    close() { close(); },
  };

  function close(result) {
    if (released) return;
    released = true;
    const index = openLayers.indexOf(layer);
    if (index !== -1) openLayers.splice(index, 1);
    releaseFocus();
    overlay.remove();
    if (opts.onClose) opts.onClose(result);
  }

  const releaseFocus = trapFocus(overlay);

  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay && opts.dismissable !== false) close(undefined);
  });

  const dialog = el('div', {
    class: 'dialog' + (opts.wide ? ' dialog--wide' : ''),
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': opts.title || 'Dialog',
  });

  if (opts.title) dialog.appendChild(el('div', { class: 'dialog-head' },
    el('div', { class: 'dialog-title' }, opts.title),
    opts.sub ? el('div', { class: 'dialog-sub' }, opts.sub) : null));
  if (opts.body) dialog.appendChild(el('div', { class: 'dialog-body' }, opts.body));
  if (opts.foot) dialog.appendChild(el('div', { class: 'dialog-foot' }, opts.foot));

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  openLayers.push(layer);

  const focusTarget = qs('input,textarea,select,button', dialog);
  if (focusTarget) setTimeout(() => { try { focusTarget.focus(); } catch { /* gone */ } }, 30);

  return { close, element: dialog, overlay };
}

export function confirmDialog(options) {
  const opts = options || {};
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };

    const confirmBtn = el('button', {
      class: 'btn ' + (opts.danger ? 'btn--danger' : 'btn--primary'),
      type: 'button',
      onClick: () => { finish(true); dialog.close(); },
    }, opts.confirmLabel || 'Confirm');

    const cancelBtn = el('button', {
      class: 'btn btn--ghost', type: 'button',
      onClick: () => { finish(false); dialog.close(); },
    }, opts.cancelLabel || 'Cancel');

    const dialog = openDialog({
      title: opts.title || 'Are you sure?',
      sub: opts.body || null,
      foot: [cancelBtn, confirmBtn],
      onClose: () => finish(false),
    });
  });
}

// -- menus -------------------------------------------------------------------

let openMenuNode = null;
let openMenuCleanup = null;

export function closeMenu() {
  if (openMenuCleanup) openMenuCleanup();
}

export function isMenuOpen() {
  return !!openMenuNode;
}

// items: { label, icon, danger, disabled, checked, separator, header, onSelect }
export function openMenu(options) {
  const opts = options || {};
  closeMenu();

  const menu = el('div', { class: 'menu', role: 'menu' });

  for (const item of opts.items || []) {
    if (!item) continue;
    if (item.separator) { menu.appendChild(el('div', { class: 'menu-sep' })); continue; }
    if (item.header) { menu.appendChild(el('div', { class: 'menu-label' }, item.header)); continue; }
    menu.appendChild(el('button', {
      class: 'menu-item' + (item.danger ? ' menu-item--danger' : ''),
      type: 'button',
      role: 'menuitem',
      'aria-disabled': item.disabled ? 'true' : null,
      onClick: () => {
        closeMenu();
        if (!item.disabled && item.onSelect) item.onSelect();
      },
    },
      item.icon ? icon(item.icon, { size: 16 }) : null,
      el('span', { class: 'truncate' }, item.label),
      item.checked ? icon('check', { size: 15 }) : null,
    ));
  }

  if (!menu.childNodes.length) return null;

  menu.style.position = 'fixed';
  menu.style.left = '-9999px';
  menu.style.top = '0';
  document.body.appendChild(menu);

  // A menu can hang off a control, or open at a point - the second is what a
  // right-click and a long press need, and both go through the same closing rules.
  const atPoint = opts.x !== undefined && opts.x !== null;
  const anchor = opts.anchor;
  const rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 12, top: 12, right: 12, bottom: 12, width: 0, height: 0 };
  const menuRect = menu.getBoundingClientRect();

  let left = atPoint ? opts.x : (opts.align === 'right' ? rect.right - menuRect.width : rect.left);
  let top = atPoint ? (opts.y === undefined || opts.y === null ? 12 : opts.y) : rect.bottom + 6;

  if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - menuRect.width - 8;
  if (left < 8) left = 8;
  if (top + menuRect.height > window.innerHeight - 8) {
    // Flip above the anchor - or, for a point, above the pointer - but never off
    // the top of the window, which would hide the first items.
    top = Math.max(8, atPoint ? opts.y - menuRect.height : rect.top - menuRect.height - 6);
  }

  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  function onDocDown(event) {
    if (menu.contains(event.target)) return;
    closeMenu();
  }
  function onKey(event) {
    if (event.key === 'Escape') { event.stopPropagation(); closeMenu(); }
  }
  function onScroll() { closeMenu(); }

  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onScroll, true);
    window.addEventListener('scroll', onScroll, true);
  }, 0);

  openMenuNode = menu;
  openMenuCleanup = () => {
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onScroll, true);
    window.removeEventListener('scroll', onScroll, true);
    menu.remove();
    openMenuNode = null;
    openMenuCleanup = null;
  };

  const first = menu.querySelector('.menu-item:not([aria-disabled="true"])');
  if (first) setTimeout(() => { try { first.focus(); } catch { /* gone */ } }, 20);

  return { close: closeMenu, element: menu };
}

// A menu at a point rather than under a control. It is the same menu: same items,
// same items array, same Escape and outside-click rules.
export function openContextMenu(x, y, items, options) {
  return openMenu(Object.assign({}, options || {}, { items, x, y }));
}

const LONG_PRESS_MS = 480;
const LONG_PRESS_SLOP = 10;

// The two gestures that open an entity's menu: right-click with a pointer, and a
// long press on a phone. `build` is handed the point and the node, so the list can
// be derived from the row the gesture landed on; it may return a promise when the
// items depend on something the server knows.
export function attachContextMenu(node, build, options) {
  const opts = options || {};
  let timer = null;
  let startX = 0;
  let startY = 0;

  function summon(x, y) {
    Promise.resolve(build({ x, y, target: node })).then((items) => {
      if (items && items.length) openContextMenu(x, y, items, opts);
    }).catch(() => { /* a menu that cannot be built simply does not open */ });
  }

  node.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    summon(event.clientX, event.clientY);
  });

  function cancel() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  node.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) { cancel(); return; }
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    cancel();
    timer = setTimeout(() => { timer = null; summon(startX, startY); }, LONG_PRESS_MS);
  }, { passive: true });

  node.addEventListener('touchmove', (event) => {
    if (!timer) return;
    const touch = event.touches[0];
    if (Math.abs(touch.clientX - startX) > LONG_PRESS_SLOP
      || Math.abs(touch.clientY - startY) > LONG_PRESS_SLOP) cancel();
  }, { passive: true });

  node.addEventListener('touchend', cancel);
  node.addEventListener('touchcancel', cancel);
  node.addEventListener('scroll', cancel, { passive: true });
}

// -- page state helpers ------------------------------------------------------

export function emptyState(options) {
  const opts = options || {};
  return el('div', { class: 'empty' },
    el('div', { class: 'empty-icon' }, icon(opts.icon || 'sparkle', { size: 24 })),
    el('div', { class: 'empty-title' }, opts.title || 'Nothing here'),
    opts.text ? el('div', { class: 'empty-text' }, opts.text) : null,
    opts.action || null,
  );
}

export function loadingState(label) {
  return el('div', { class: 'empty' },
    el('div', { class: 'spinner', role: 'status', 'aria-label': label || 'Loading' }),
    el('div', { class: 'empty-text' }, label || 'Loading'),
  );
}

export function errorState(error, onRetry) {
  const message = error && error.message ? error.message : 'That did not load.';
  return el('div', { class: 'empty' },
    el('div', { class: 'empty-icon' }, icon('alert', { size: 24 })),
    el('div', { class: 'empty-title' }, 'Could not load this'),
    el('div', { class: 'empty-text' }, message),
    onRetry ? el('button', { class: 'btn btn--default', type: 'button', onClick: onRetry }, icon('refresh', { size: 16 }), 'Try again') : null,
  );
}

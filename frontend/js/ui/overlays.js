// Overlays and feedback.
//
// One place that knows how a menu closes, how a dialog traps focus and how a
// toast is dismissed. A view asks for the outcome; it does not build the
// mechanism, which is how every screen ended up with its own slightly different
// idea of whether Escape cancels or closes.

import { el, qs, trapFocus } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';

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
  const message = error && error.message ? error.message : 'That did not work. Try again.';
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
  const overlay = el('div', {
    class: 'overlay' + (opts.overlayClass ? ' ' + opts.overlayClass : ''),
    role: 'presentation',
  });
  const opener = document.activeElement;
  let released = false;

  const layer = {
    close() { close(); },
  };

  // Escape belongs to the dialog, but only the topmost one, and a menu open over
  // it gets first refusal - the same ordering the eye reads.
  function onEscape(event) {
    if (event.key !== 'Escape') return;
    if (openLayers[openLayers.length - 1] !== layer) return;
    if (isMenuOpen()) return;
    event.stopPropagation();
    close(undefined);
  }

  function close(result) {
    if (released) return;
    released = true;
    const index = openLayers.indexOf(layer);
    if (index !== -1) openLayers.splice(index, 1);
    document.removeEventListener('keydown', onEscape, true);
    releaseFocus();
    overlay.remove();
    if (opener && opener.focus && document.contains(opener)) {
      try { opener.focus(); } catch { /* the opener is gone */ }
    }
    if (opts.onClose) opts.onClose(result);
  }

  const releaseFocus = trapFocus(overlay);

  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay && opts.dismissable !== false) close(undefined);
  });

  const dialog = el('div', {
    class: 'dialog' + (opts.class ? ' ' + opts.class : '') + (opts.wide ? ' dialog--wide' : ''),
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': opts.title || 'Dialog',
  });

  if (opts.head !== false && (opts.title || opts.dismissable !== false)) {
    dialog.appendChild(el('div', { class: 'dialog-head' },
      el('div', { class: 'dialog-head-text' },
        opts.title ? el('div', { class: 'dialog-title' }, opts.title) : null,
        opts.sub ? el('div', { class: 'dialog-sub' }, opts.sub) : null),
      opts.dismissable === false
        ? null
        : el('button', {
          class: 'dialog-close', type: 'button', 'aria-label': 'Close',
          onClick: () => close(undefined),
        }, icon('x', { size: 16 }))));
  }
  if (opts.body) dialog.appendChild(el('div', { class: 'dialog-body' }, opts.body));
  if (opts.foot) dialog.appendChild(el('div', { class: 'dialog-foot' }, opts.foot));

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  openLayers.push(layer);
  document.addEventListener('keydown', onEscape, true);

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
    if (item.header) {
      // A header can carry a face and a line of detail under the name.
      //
      // The person sheet is a header with a face and the person's roles in
      // it, and neither was drawn: the face was passed and ignored, and the
      // roles were never passed at all.
      menu.appendChild(el('div', { class: 'menu-label' },
        item.lead ? el('span', { class: 'menu-lead' }, item.lead) : null,
        el('span', { class: 'menu-headtext' },
          el('span', { class: 'menu-headname' }, item.header),
          item.sub ? el('span', { class: 'menu-sub' }, item.sub) : null)));
      continue;
    }
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
  const rect = anchor && anchor.getBoundingClientRect
    ? anchor.getBoundingClientRect()
    : { left: 12, top: 12, right: 12, bottom: 12, width: 0, height: 0 };
  const menuRect = menu.getBoundingClientRect();

  // A menu opened at a point is placed a couple of pixels away from it.
  //
  // Putting the pointer exactly on the corner of the menu means the first
  // item is under the cursor, and the natural movement of the hand - to the
  // right, to the right and down - leaves the menu immediately. A couple of
  // pixels of offset puts the pointer just outside the menu, which is where
  // every other menu on every other platform puts it.
  const POINTER_OFFSET = 2;
  let left = atPoint ? opts.x + POINTER_OFFSET : (opts.align === 'right' ? rect.right - menuRect.width : rect.left);
  let top = atPoint ? ((opts.y === undefined || opts.y === null ? 12 : opts.y) + POINTER_OFFSET) : rect.bottom + 6;

  if (left + menuRect.width > window.innerWidth - 8) left = window.innerWidth - menuRect.width - 8;
  if (left < 8) left = 8;
  if (top + menuRect.height > window.innerHeight - 8) {
    // Flip above the anchor - or, for a point, above the pointer - but never off
    // the top of the window, which would hide the first items.
    top = Math.max(8, atPoint ? opts.y - menuRect.height - POINTER_OFFSET : rect.top - menuRect.height - 6);
  }

  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  function enabledItems() {
    return Array.from(menu.querySelectorAll('.menu-item:not([aria-disabled="true"])'));
  }

  function onDocDown(event) {
    if (menu.contains(event.target)) return;
    closeMenu();
  }

  // A scroll inside the menu is not a reason to close the menu.
  //
  // The listener is on the window in the capture phase, so it sees the scroll
  // of every element in the document - including the menu's own. A menu with
  // more items than fit could therefore never be scrolled: the scroll closed
  // the menu that was being scrolled. Worse, the menu's first item is focused
  // a moment after it opens, and focusing an item inside a scrolling box
  // scrolls that box, so a long menu closed itself before a pointer could
  // reach it.
  function onScroll(event) {
    const target = event && event.target;
    if (target && menu.contains(target)) return;
    closeMenu();
  }
  function onKey(event) {
    if (event.key === 'Escape') { event.stopPropagation(); closeMenu(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = enabledItems();
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown'
      ? (index + 1) % items.length
      : (index - 1 + items.length) % items.length;
    items[next].focus();
  }
  // The listeners are registered a tick later, so that the click which opened
  // the menu is not the click which closes it. The `armed` flag is what makes
  // that safe: a menu closed inside that tick never registers its listeners
  // at all.
  //
  // Without it, a menu opened and closed inside one tick left its handlers
  // behind - the removal ran before the registration, so the registration
  // happened afterwards and nothing ever took it off again. Those handlers
  // were not harmless. The stale scroll handler called closeMenu(), which
  // closes whatever menu is open *now* - so a menu could be closed by a scroll
  // that had nothing to do with it. The stale key handler moved the focus
  // into a menu that was no longer on the page, and the live menu then found
  // no focused item and sent the focus back to its first one.
  let armed = true;
  setTimeout(() => {
    if (!armed) return;
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onScroll, true);
    window.addEventListener('scroll', onScroll, true);
  }, 0);

  if (anchor && anchor.setAttribute) anchor.setAttribute('aria-expanded', 'true');

  openMenuNode = menu;
  openMenuCleanup = () => {
    armed = false;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onScroll, true);
    window.removeEventListener('scroll', onScroll, true);
    if (anchor && anchor.setAttribute) anchor.setAttribute('aria-expanded', 'false');
    menu.remove();
    openMenuNode = null;
    openMenuCleanup = null;
  };

  // The first item is focused a moment later, so the menu takes the keyboard
  // without the click that opened it being swallowed. A menu that has been
  // closed by then must not take the focus: the reader has moved on, and
  // pulling the focus back to a removed item is how a reader ends up typing
  // into nothing.
  const first = menu.querySelector('.menu-item:not([aria-disabled="true"])');
  if (first) {
    setTimeout(() => {
      if (!armed) return;
      try { first.focus(); } catch { /* gone */ }
    }, 20);
  }

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

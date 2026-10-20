// Mobile overlays.
//
// A phone has no room for a dialog in the middle of the screen, so everything the
// reader has to acknowledge or choose is a bottom sheet: it comes up from the edge
// a thumb can reach, traps focus while it is open, and gives focus back where it
// found it. One manager, so only the topmost layer answers Escape.

import { el, trapFocus, prefersReducedMotion } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { attachSheetDismiss } from '../js/gestures.js';

const stack = [];

function present(node, options) {
  const opts = options || {};
  const scrim = el('div', { class: 'm-scrim' });
  document.body.appendChild(scrim);
  document.body.appendChild(node);

  const layer = {
    node,
    scrim,
    release: trapFocus(node),
    close() {
      const index = stack.indexOf(layer);
      if (index !== -1) stack.splice(index, 1);
      try { layer.release(); } catch { /* element already gone */ }
      node.classList.remove('is-open');
      scrim.classList.remove('is-open');
      const remove = () => { node.remove(); scrim.remove(); };
      if (prefersReducedMotion()) remove();
      else setTimeout(remove, 200);
      if (typeof opts.onClose === 'function') opts.onClose();
    },
  };
  stack.push(layer);

  // Pulling a sheet down past the threshold dismisses it. The layer has to
  // exist first: the gesture is the layer's own close, and a layer that is
  // still being declared cannot be reached.
  attachSheetDismiss(node, layer.close);

  scrim.addEventListener('click', () => layer.close());
  // Opening on the next frame lets the transition run from the off-screen position.
  requestAnimationFrame(() => { scrim.classList.add('is-open'); node.classList.add('is-open'); });
  const focusable = node.querySelector('input, textarea, button');
  if (focusable && !prefersReducedMotion()) setTimeout(() => { try { focusable.focus(); } catch { /* nothing to focus */ } }, 60);

  return layer;
}

export function sheet(options) {
  const opts = options || {};
  const node = el('div', {
    class: 'm-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || 'Options',
  },
    el('div', { class: 'm-sheet__grip', 'aria-hidden': 'true' }),
    el('div', { class: 'm-sheet__head' },
      el('div', { class: 'm-sheet__title' }, opts.title || ''),
      el('button', {
        class: 'm-iconbtn', type: 'button', 'aria-label': 'Close',
        onClick: () => { const top = stack[stack.length - 1]; if (top) top.close(); },
      }, icon('x', { size: 20 }))),
    el('div', { class: 'm-sheet__body' }, opts.body || null),
    opts.footer ? el('div', { class: 'm-sheet__foot' }, opts.footer) : null);
  return present(node, opts);
}

// A sheet of choices. Selecting one closes the sheet and calls its handler.
export function menu(options) {
  const opts = options || {};
  const menuNode = el('div', { class: 'm-menu', role: 'menu' });
  let layer = null;
  for (const item of opts.items || []) {
    if (!item) continue;
    if (item.separator) { menuNode.appendChild(el('div', { class: 'm-menu__sep' })); continue; }
    if (item.header) { menuNode.appendChild(el('div', { class: 'm-menu__header' }, item.header)); continue; }
    menuNode.appendChild(el('button', {
      class: 'm-menu__item' + (item.danger ? ' is-danger' : ''),
      type: 'button', role: 'menuitem', disabled: item.disabled || null,
      onClick: () => { const fn = item.onSelect; if (layer) layer.close(); if (fn) fn(); },
    },
      item.icon ? icon(item.icon, { size: 20 }) : null,
      el('span', { class: 'truncate' }, item.label),
      item.checked ? el('span', { class: 'm-menu__check' }, icon('check', { size: 18 })) : null));
  }
  layer = present(el('div', { class: 'm-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || 'Menu' },
    el('div', { class: 'm-sheet__grip', 'aria-hidden': 'true' }),
    opts.title ? el('div', { class: 'm-sheet__head' }, el('div', { class: 'm-sheet__title' }, opts.title)) : null,
    el('div', { class: 'm-sheet__body' }, menuNode)), opts);
  return layer;
}

export function confirm(options) {
  const opts = options || {};
  return new Promise((resolve) => {
    let decided = false;
    const finish = (value) => { if (!decided) { decided = true; resolve(value); } };
    const layer = present(el('div', { class: 'm-sheet', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': opts.title || 'Confirm' },
      el('div', { class: 'm-sheet__grip', 'aria-hidden': 'true' }),
      el('div', { class: 'm-sheet__head' }, el('div', { class: 'm-sheet__title' }, opts.title || 'Are you sure?')),
      el('div', { class: 'm-sheet__body' },
        el('p', { class: 'm-lede' }, opts.text || ''),
        opts.body || null),
      el('div', { class: 'm-sheet__foot' },
        el('div', { class: 'm-actions' },
          el('button', { class: 'm-btn m-btn--block' + (opts.danger ? ' m-btn--danger' : ' m-btn--primary'), type: 'button',
            onClick: () => { finish(true); layer.close(); } }, opts.confirmLabel || 'Confirm'),
          el('button', { class: 'm-btn m-btn--block m-btn--ghost', type: 'button',
            onClick: () => { finish(false); layer.close(); } }, opts.cancelLabel || 'Cancel')))), {
      onClose: () => finish(false),
    });
  });
}

// -- the long press ------------------------------------------------------------
//
// A phone has no right-click, so the gesture that opens an entity's actions is
// a long press. It raises the same sheet of choices a right-click raises on a
// desk: the module's own bottom sheet, thumb-reachable.

const LONG_PRESS_MS = 480;
const LONG_PRESS_SLOP = 10;

export function attachLongPress(node, build, options) {
  const opts = options || {};
  let timer = null;
  let startX = 0;
  let startY = 0;

  function cancel() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function summon() {
    Promise.resolve(build({ target: node })).then((items) => {
      if (items && items.length) menu({ title: opts.title, items });
    }).catch(() => { /* a sheet that cannot be built simply does not open */ });
  }

  node.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) { cancel(); return; }
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    cancel();
    timer = setTimeout(() => { timer = null; summon(); }, LONG_PRESS_MS);
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
  return node;
}

let toastRoot = null;
export function toast(message, options) {
  const opts = options || {};
  if (!toastRoot) {
    toastRoot = el('div', { class: 'm-toast-root', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastRoot);
  }
  const node = el('div', { class: 'm-toast' + (opts.type ? ' m-toast--' + opts.type : '') }, message);
  toastRoot.appendChild(node);
  setTimeout(() => node.remove(), opts.duration || 3400);
  return node;
}

export function closeAll() {
  while (stack.length) stack[stack.length - 1].close();
}

export default { sheet, menu, confirm, toast, closeAll, attachLongPress };

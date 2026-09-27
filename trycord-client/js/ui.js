// Low-level UI primitives: DOM helpers, escaping, toasts, modals,
// popovers, and time formatting. Framework-free.

import { TrycordConfig } from './config.js';

export function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') node.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (v === true) node.setAttribute(k, '');
      else if (k in node && k !== 'value' && k !== 'type') { try { node[k] = v; } catch { node.setAttribute(k, v); } }
      else node.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function qs(sel, root = document) { return root.querySelector(sel); }
export function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

// ---- toasts -----------------------------------------------------------

export function toast(message, kind = 'info', timeout = 4200) {
  const root = qs('#toast-root');
  if (!root) return;
  const t = el('div', { class: 'toast ' + kind, role: 'status' }, message);
  root.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity 240ms';
    setTimeout(() => t.remove(), 260);
  }, timeout);
}

// ---- modals --------------------------------------------------------------

export function openModal({ title, eyebrow, closable, body, footer, closeText = 'Close' }) {
  let box;
  const backdrop = el('div', { class: 'backdrop' }, (box = el('div', {
    class: 'modal',
    role: 'dialog',
    'aria-modal': 'true',
  })));
  const titleId = 'modal-title-' + Math.random().toString(36).slice(2, 8);
  const doClose = () => close();
  if (title || closable) {
    const head = el('div', { class: 'modal-head' });
    const titles = el('div', {});
    if (eyebrow) titles.appendChild(el('p', { class: 'eyebrow' }, eyebrow));
    if (title) {
      box.setAttribute('aria-labelledby', titleId);
      titles.appendChild(el('h2', { id: titleId }, title));
    } else {
      box.setAttribute('aria-label', 'Dialog');
    }
    head.appendChild(titles);
    if (closable) {
      const x = el('button', { class: 'modal-close', type: 'button', 'aria-label': 'Close dialog' }, '×');
      x.addEventListener('click', doClose);
      head.appendChild(x);
    }
    box.appendChild(head);
  } else {
    box.setAttribute('aria-label', 'Dialog');
  }
  if (body) box.appendChild(el('div', {}, body));
  if (footer) box.appendChild(el('div', { class: 'row-line', style: { marginTop: 'var(--t-d-4)', justifyContent: 'flex-end' } }, footer));

  const prevFocus = document.activeElement;

  function focusables() {
    return Array.from(box.querySelectorAll(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter((n) => n.offsetParent !== null || n === document.activeElement);
  }

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (prevFocus && prevFocus !== document.body && typeof prevFocus.focus === 'function') {
      try { prevFocus.focus(); } catch { /* ignore */ }
    }
  }
  function onKey(e) {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'Tab') {
      const f = focusables();
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  (qs('#modal-root') || document.body).appendChild(backdrop);
  const first = box.querySelector('input, button, textarea, select, [tabindex]');
  if (first) setTimeout(() => first.focus(), 30);
  else { box.tabIndex = -1; setTimeout(() => box.focus(), 30); }
  return { close, box };
}

export function confirmDialog({ title, message, confirmText = 'Confirm', danger = false, onConfirm }) {
  let doClose = () => {};
  const cancelBtn = el('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
  const okBtn = el('button', { class: danger ? 'btn danger' : 'btn primary', type: 'button' }, confirmText);
  const modal = openModal({
    title, body: el('p', {}, message),
    footer: [cancelBtn, okBtn],
  });
  doClose = modal.close;
  cancelBtn.addEventListener('click', doClose);
  okBtn.addEventListener('click', async () => {
    try { await onConfirm(); } finally { doClose(); }
  });
  return modal;
}

// ---- popovers -----------------------------------------------------------

export function showPopover(anchor, items, { onSelect } = {}) {
  const root = qs('#popover-root') || document.body;
  const pop = el('div', { class: 'popover', hidden: true });
  for (const item of items || []) {
    if (item.sep) { pop.appendChild(el('div', { class: 'pop-sep' })); continue; }
    const b = el('button', { class: 'pop-item ' + (item.danger ? 'danger' : '') }, (() => {
      if (item.html) return item.html();
      const wrap = el('span', {});
      wrap.append(el('span', {}, item.label));
      if (item.desc) wrap.append(el('span', { class: 'pop-desc' }, item.desc));
      return wrap;
    })());
    b.addEventListener('click', () => {
      hidePopover();
      if (onSelect) onSelect(item);
      else if (item.onClick) item.onClick();
    });
    pop.appendChild(b);
  }
  root.appendChild(pop);
  // position
  const r = anchor.getBoundingClientRect();
  pop.removeAttribute('hidden');
  const pr = pop.getBoundingClientRect();
  let left = r.left;
  let top = r.bottom + 6;
  if (left + pr.width > innerWidth - 8) left = innerWidth - pr.width - 8;
  if (top + pr.height > innerHeight - 8) top = Math.max(8, r.top - pr.height - 6);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  function hide(e) {
    if (e && pop.contains(e.target)) return;
    hidePopover();
  }
  function hidePopover() {
    pop.remove();
    document.removeEventListener('pointerdown', hide);
    document.removeEventListener('keydown', onKey);
    if (pop.contains(document.activeElement) && anchor && typeof anchor.focus === 'function') {
      try { anchor.focus(); } catch { /* ignore */ }
    }
  }
  function onKey(e) { if (e.key === 'Escape') hidePopover(); }
  setTimeout(() => {
    document.addEventListener('pointerdown', hide);
    document.addEventListener('keydown', onKey);
  }, 0);
  return { pop, hide: hidePopover };
}

// ---- context menus ---------------------------------------------------------
// One menu system for every entity in the app. Callers do not build DOM; they
// hand over a plain action list and this decides how to present it.
//
// An action is one of:
//   { label, desc?, danger?, disabled?, onSelect?, items? }  items => submenu
//   { sep: true }                                            divider
//   { heading: 'Roles' }                                     group label
//
// Presentation is chosen by the surface, not the caller: a cursor-anchored menu
// with the pointer, a bottom sheet on touch/narrow. Both render the same action
// list, so a long-press and a right-click can never drift apart.
//
// opts:
//   target   { type, id }  identity of what was clicked
//   node     the element   used to refuse actions if it has since been removed
//   sheet    force the bottom-sheet presentation
//
// The `node` guard is the reason a stale menu cannot act. Menus are opened
// against a live element; if a route change, repaint or delete detaches that
// element before the user clicks, every action is refused rather than firing
// against whatever now occupies the same coordinates.

const MENU_EDGE = 8;
const LONG_PRESS_MS = 480;
const LONG_PRESS_SLOP = 10; // px of movement that still counts as a hold

// Every open menu, outermost first, so Escape/ArrowLeft can unwind the stack.
let menuStack = [];
let menuCleanup = null;

function sheetMode(force) {
  if (force) return true;
  try { return matchMedia('(hover: none) and (pointer: coarse)').matches || innerWidth < 560; }
  catch { return innerWidth < 560; }
}

// Normalise the action list: drop empties, coerce, and keep order.
function normItems(items) {
  const out = [];
  for (const it of items || []) {
    if (!it) continue;
    if (it.sep) { if (out.length && !out[out.length - 1].sep) out.push({ sep: true }); continue; }
    if (it.heading) { out.push({ heading: it.heading }); continue; }
    if (typeof it === 'string') { out.push({ label: it }); continue; }
    out.push(it);
  }
  while (out.length && out[out.length - 1].sep) out.pop();
  return out;
}

function buildMenu(items, ctx, depth) {
  const pop = el('div', {
    class: 'popover ctx-menu' + (depth ? ' ctx-menu--sub' : ''),
    role: 'menu',
    dataset: ctx.target && ctx.target.type ? { menuFor: ctx.target.type } : null,
  });
  if (ctx.target && ctx.target.id) pop.dataset.targetId = String(ctx.target.id);

  for (const item of normItems(items)) {
    if (item.sep) { pop.appendChild(el('div', { class: 'pop-sep', role: 'separator' })); continue; }
    if (item.heading) { pop.appendChild(el('div', { class: 'pop-heading' }, item.heading)); continue; }

    const hasSub = Array.isArray(item.items) && item.items.some(Boolean);
    const b = el('button', {
      class: 'pop-item' + (item.danger ? ' danger' : '') + (hasSub ? ' has-sub' : ''),
      type: 'button',
      role: 'menuitem',
      disabled: !!item.disabled,
      'aria-haspopup': hasSub ? 'menu' : null,
      'aria-expanded': hasSub ? 'false' : null,
      title: item.desc || item.label,
    });
    const wrap = el('span', { class: 'pop-item__text' });
    wrap.append(el('span', {}, item.label));
    if (item.desc) wrap.append(el('span', { class: 'pop-desc' }, item.desc));
    b.appendChild(wrap);
    if (hasSub) b.appendChild(el('span', { class: 'pop-item__caret', 'aria-hidden': 'true' }, '›'));

    if (hasSub) {
      // Submenus open on hover AND on ArrowRight, so the whole thing works with
      // a mouse and with a keyboard without two code paths.
      let sub = null;
      const openSub = () => {
        if (sub || b.disabled) return;
        // Only one submenu per parent level.
        for (let i = menuStack.length - 1; i > ctx.depth; i--) closeFrom(i);
        sub = showContextMenuAt(b, item.items, { ...ctx, depth: ctx.depth + 1, parent: pop, anchor: b });
        b.setAttribute('aria-expanded', 'true');
      };
      const closeSub = () => {
        if (!sub) return;
        closeFrom(ctx.depth + 1);
        sub = null;
        b.setAttribute('aria-expanded', 'false');
      };
      b.addEventListener('mouseenter', openSub);
      // Deliberately NOT on focus. Focus is how the keyboard walks the list, so
      // opening on it made a parent with a submenu a trap: arrowing onto it
      // pulled the next ArrowDown into the submenu and the user could never
      // reach the items below it. ArrowRight opens, and so does a tap.
      b.addEventListener('click', (e) => { e.stopPropagation(); openSub(); });
      b.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); openSub(); } });
    } else {
      b.addEventListener('mouseenter', () => {
        // Moving off a parent closes its submenu, the way every native menu does.
        if (ctx.depth < menuStack.length - 1) closeFrom(ctx.depth + 1);
      });
      b.addEventListener('click', () => {
        if (b.disabled) return;
        // Refuse to act on an entity that is no longer on screen.
        if (ctx.node && !ctx.node.isConnected) { closeContextMenu(); return; }
        closeContextMenu();
        if (item.onSelect) item.onSelect(ctx.target);
      });
    }
    pop.appendChild(b);
  }
  return pop;
}

function itemsOf(pop) {
  return [...pop.querySelectorAll('.pop-item')].filter((n) => !n.disabled);
}

function focusIndex(pop, delta, toEnd) {
  const list = itemsOf(pop);
  if (!list.length) return;
  const at = list.indexOf(document.activeElement);
  let next;
  if (toEnd === 'first') next = 0;
  else if (toEnd === 'last') next = list.length - 1;
  else if (at < 0) next = delta > 0 ? 0 : list.length - 1;
  else next = (at + delta + list.length) % list.length;
  list[next].focus();
}

function closeFrom(depth) {
  while (menuStack.length > depth) {
    const entry = menuStack.pop();
    if (!entry) continue;
    if (entry.anchorBtn) entry.anchorBtn.setAttribute('aria-expanded', 'false');
    try { entry.pop.remove(); } catch { /* already gone */ }
  }
}

function onMenuKey(e) {
  const top = menuStack[menuStack.length - 1];
  if (!top) return;
  const pop = top.pop;
  switch (e.key) {
    case 'Escape':
      e.preventDefault();
      e.stopPropagation();
      // Innermost first: Escape from a submenu closes only that submenu.
      if (menuStack.length > 1) closeFrom(menuStack.length - 1);
      else closeContextMenu();
      return;
    case 'ArrowDown': e.preventDefault(); focusIndex(pop, 1); return;
    case 'ArrowUp': e.preventDefault(); focusIndex(pop, -1); return;
    case 'Home': e.preventDefault(); focusIndex(pop, 0, 'first'); return;
    case 'End': e.preventDefault(); focusIndex(pop, 0, 'last'); return;
    case 'ArrowLeft':
      // Only a submenu closes on ArrowLeft; a root menu ignores it so the
      // browser/host can still handle back navigation.
      if (menuStack.length > 1) { e.preventDefault(); e.stopPropagation(); closeFrom(menuStack.length - 1); }
      return;
    case 'Tab':
      e.preventDefault();
      closeContextMenu();
      return;
    default: break;
  }
}

function onDocPointerDown(e) {
  if (menuStack.some((m) => m.pop.contains(e.target))) return;
  closeContextMenu();
}

// Clamp into the viewport.
//
// Sizing uses offsetWidth/offsetHeight, NOT getBoundingClientRect. The popover
// carries an entry animation that translates it, and a transformed rect reports
// the translated box - so measuring during the animation made a menu that was
// correctly placed look like it overflowed, and it got yanked to the top edge.
// The layout box is the honest size.
//
// Two passes, because the first measurement can precede late layout (a wrapped
// label, a freshly opened submenu) and clamping against a stale size leaves the
// menu hanging off the edge.
function place(pop, x, y) {
  const clampTo = () => {
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = x; let top = y;
    if (left + w > innerWidth - MENU_EDGE) left = Math.max(MENU_EDGE, innerWidth - w - MENU_EDGE);
    if (top + h > innerHeight - MENU_EDGE) top = Math.max(MENU_EDGE, innerHeight - h - MENU_EDGE);
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
  };
  clampTo();
  clampTo();

  // Judge fit from the arithmetic we just performed, not from a rect that may
  // still be mid-animation.
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const left = Math.min(Math.max(MENU_EDGE, x), Math.max(MENU_EDGE, innerWidth - w - MENU_EDGE));
  const top = Math.min(Math.max(MENU_EDGE, y), Math.max(MENU_EDGE, innerHeight - h - MENU_EDGE));
  const overflowsX = x + w > innerWidth - MENU_EDGE;
  const overflowsY = y + h > innerHeight - MENU_EDGE;
  if ((overflowsX && innerWidth - w - MENU_EDGE < MENU_EDGE) || (overflowsY && innerHeight - h - MENU_EDGE < MENU_EDGE)) {
    // Genuinely taller or wider than the window allows: pin to the top-left and
    // scroll rather than overflow.
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = MENU_EDGE + 'px';
    if (h > innerHeight - MENU_EDGE * 2) {
      pop.style.maxHeight = (innerHeight - MENU_EDGE * 2) + 'px';
      pop.style.overflowY = 'auto';
    }
  }
}

// Position a submenu beside its parent item, flipping to the left at the edge.
function placeSub(pop, anchorBtn) {
  const a = anchorBtn.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let left = a.right - 4;
  if (left + pr.width > innerWidth - MENU_EDGE) left = Math.max(MENU_EDGE, a.left - pr.width + 4);
  let top = a.top - 6;
  if (top + pr.height > innerHeight - MENU_EDGE) top = Math.max(MENU_EDGE, innerHeight - pr.height - MENU_EDGE);
  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(top) + 'px';
}

// Internal: open a menu anchored to an element (submenus) or a point (root).
function showContextMenuAt(anchor, items, ctx) {
  const pop = buildMenu(items, ctx, ctx.depth);
  if (!pop.querySelector('.pop-item')) return null;
  const root = qs('#popover-root') || document.body;

  if (ctx.depth > 0) {
    pop.classList.add('ctx-menu--sheet');
    root.appendChild(pop);
    placeSub(pop, ctx.anchor);
  } else if (ctx.sheet) {
    // Bottom sheet: same actions, thumb-reachable, full-width.
    pop.classList.add('ctx-menu--sheet');
    const scrim = el('div', { class: 'ctx-scrim' });
    root.appendChild(scrim);
    root.appendChild(pop);
    pop.style.left = '0px';
    pop.style.top = 'auto';
    pop.style.bottom = '0px';
    scrim.addEventListener('pointerdown', closeContextMenu);
  } else {
    root.appendChild(pop);
    place(pop, ctx.x, ctx.y);
  }

  menuStack.push({ pop, depth: ctx.depth, anchorBtn: ctx.anchorBtn || null });
  return pop;
}

export function showContextMenu(clientX, clientY, items, opts = {}) {
  closeContextMenu();
  const ctx = {
    x: clientX, y: clientY, depth: 0,
    target: opts.target || null,
    node: opts.node || null,
    sheet: sheetMode(opts.sheet),
  };
  const pop = showContextMenuAt(null, items, ctx);
  if (!pop) return { pop: null, hide: () => {} };

  const onKey = onMenuKey;
  const onScroll = () => closeContextMenu();
  const onResize = () => closeContextMenu();
  const bind = () => {
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
  };
  // Defer so the click that opened the menu does not immediately close it.
  setTimeout(bind, 0);
  menuCleanup = () => {
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
  };

  const first = itemsOf(pop)[0];
  if (first) { try { first.focus({ preventScroll: true }); } catch { /* ignore */ } }
  return { pop, hide: closeContextMenu };
}

// Wire an element to the menu system: right-click, long-press, and a keyboard
// equivalent. Returns a detach function so callers can unbind on teardown
// rather than leaking listeners through repaints.
export function attachContextMenu(el, factory, opts = {}) {
  if (!el) return () => {};
  const open = (x, y) => {
    const items = factory({ x, y, el, target: opts.target && opts.target(el) });
    if (!items || !items.length) return;
    showContextMenu(x, y, items, {
      target: opts.target ? opts.target(el) : null,
      node: el,
      sheet: opts.sheet,
    });
  };

  const onContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    open(e.clientX, e.clientY);
  };

  // Long press. Chromium does not fire `contextmenu` for a held touch the way
  // a mobile browser does, so a phone would otherwise get no menu at all.
  let timer = null; let sx = 0; let sy = 0; let fired = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  const onTouchStart = (e) => {
    if (e.touches.length !== 1) { cancel(); return; }
    fired = false;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    cancel();
    timer = setTimeout(() => { fired = true; open(sx, sy); }, LONG_PRESS_MS);
  };
  const onTouchMove = (e) => {
    if (!timer) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - sx) > LONG_PRESS_SLOP || Math.abs(t.clientY - sy) > LONG_PRESS_SLOP) cancel();
  };
  const onTouchEnd = () => { cancel(); };
  // A long press that opened the menu must not also fire a click underneath it.
  const onClickCapture = (e) => { if (fired) { e.stopPropagation(); e.preventDefault(); fired = false; } };

  // Keyboard equivalent: the menu key, and Shift+F10 which is the ARIA
  // convention for "context menu" on a focused element.
  const onKeyDown = (e) => {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      open(r.left + Math.min(24, r.width / 2), r.top + Math.min(24, r.height / 2));
    }
  };

  el.addEventListener('contextmenu', onContextMenu);
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchmove', onTouchMove, { passive: true });
  el.addEventListener('touchend', onTouchEnd);
  el.addEventListener('touchcancel', onTouchEnd);
  el.addEventListener('click', onClickCapture, true);
  el.addEventListener('keydown', onKeyDown);

  return () => {
    cancel();
    el.removeEventListener('contextmenu', onContextMenu);
    el.removeEventListener('touchstart', onTouchStart);
    el.removeEventListener('touchmove', onTouchMove);
    el.removeEventListener('touchend', onTouchEnd);
    el.removeEventListener('touchcancel', onTouchEnd);
    el.removeEventListener('click', onClickCapture, true);
    el.removeEventListener('keydown', onKeyDown);
  };
}

export function closeContextMenu() {
  closeFrom(0);
  menuStack = [];
  if (menuCleanup) { try { menuCleanup(); } catch { /* ignore */ } menuCleanup = null; }
  // Unconditional, and not part of menuStack: the emoji palette, the profile
  // card and the sheet scrim each own their popover and their listeners. Gating
  // this on menuCleanup - which only showContextMenu sets - left Escape unable
  // to close the palette.
  for (const pop of Array.from(document.querySelectorAll('.popover.user-card, .popover.emoji-picker, .ctx-scrim'))) {
    try { if (pop._ctxCleanup) pop._ctxCleanup(); } catch { /* ignore */ }
    pop.remove();
  }
}

export function isContextMenuOpen() {
  return menuStack.length > 0;
}

// Mini profile card anchored at a cursor point. The caller supplies the
// rendered avatar node (avatar lives in components.js; ui.js stays
// dependency-free) plus plain action descriptors.
export function showUserCard(clientX, clientY, { avatarEl, title, sub, statusLine, actions, bannerUrl = null } = {}) {
  closeContextMenu();
  const root = qs('#popover-root') || document.body;
  const pop = el('div', { class: 'popover user-card', role: 'dialog', 'aria-label': title || 'User' });
  // Banner is optional and loads through the authenticated media route, so
  // it is filled in asynchronously and simply stays empty when absent.
  const banner = el('div', { class: 'user-card__banner' });
  if (bannerUrl) {
    import('./components.js').then(({ loadAuthedImage }) => loadAuthedImage(bannerUrl)).then((url) => {
      if (!url || !pop.isConnected) return;
      banner.style.backgroundImage = 'url("' + url + '")';
      banner.classList.add('has-img');
    }).catch(() => {});
  }
  pop.appendChild(banner);
  const head = el('div', { class: 'user-card__head' });
  if (avatarEl) head.appendChild(avatarEl);
  pop.appendChild(head);
  const idBox = el('div', { class: 'user-card__body' });
  idBox.appendChild(el('strong', { class: 'user-card__name' }, title || 'Unknown'));
  if (sub) idBox.appendChild(el('span', { class: 'muted small' }, sub));
  if (statusLine) idBox.appendChild(el('span', { class: 'user-card__status' }, statusLine));
  pop.appendChild(idBox);
  const btnBox = el('div', { class: 'user-card__actions' });
  for (const a of actions || []) {
    const b = el('button', {
      class: 'btn sm' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''),
      type: 'button',
    }, a.label);
    b.addEventListener('click', () => {
      closeContextMenu();
      if (a.onSelect) a.onSelect();
    });
    btnBox.appendChild(b);
  }
  if (btnBox.children.length) pop.appendChild(btnBox);
  root.appendChild(pop);
  const pr = pop.getBoundingClientRect();
  let left = clientX;
  let top = clientY;
  if (left + pr.width > innerWidth - 8) left = Math.max(8, innerWidth - pr.width - 8);
  if (top + pr.height > innerHeight - 8) top = Math.max(8, innerHeight - pr.height - 8);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  const onKey = (e) => { if (e.key === 'Escape') closeContextMenu(); };
  const onDown = (e) => { if (!pop.contains(e.target)) closeContextMenu(); };
  const onScroll = () => closeContextMenu();
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
  }, 0);
  pop._ctxCleanup = () => {
    document.removeEventListener('pointerdown', onDown);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
  };
  return { pop, hide: closeContextMenu };
}

export async function copyText(text, label = 'Copied to clipboard.') {
  const value = String(text == null ? '' : text);
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // Clipboard API unavailable (permissions / non-secure context):
    // fall back to a transient textarea + execCommand.
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch { toast('Copy failed.', 'error'); return; }
  }
  toast(label, 'ok');
}

// ---- report dialog --------------------------------------------------------
// Trust & Safety entry point shared by message/user reports. Fixed
// categories map to the report reason (the backend has no category
// enum — reason + free-text description is the whole contract), so the
// admin queue shows a consistent label plus details.
export const REPORT_CATEGORIES = [
  'Harassment or bullying',
  'Spam',
  'Scam or fraud',
  'Hate or discriminatory content',
  'Threats or violence',
  'Sexual or inappropriate content',
  'Impersonation',
  'Illegal content',
  'Other',
];

export function openReportDialog({ targetType, targetId, title, subtitle, onSubmit }) {
  const err = el('div', { class: 'form-error', hidden: true });
  const sel = el('select', { class: 'input', 'aria-label': 'Reason' });
  for (const c of REPORT_CATEGORIES) sel.appendChild(el('option', { value: c }, c));
  const details = el('textarea', { class: 'textarea', style: { minHeight: '80px' }, maxlength: 4000, placeholder: 'Additional information (optional)' });
  const cancel = el('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
  const go = el('button', { class: 'btn danger', type: 'button' }, 'Submit report');
  const modal = openModal({
    title: title || 'Report',
    eyebrow: 'Trust & Safety',
    closable: true,
    body: el('div', {},
      subtitle ? el('p', { class: 'muted small' }, subtitle) : null,
      el('div', { class: 'field' }, el('label', {}, 'Reason'), sel),
      el('div', { class: 'field' }, el('label', {}, 'Additional information'), details),
      err),
    footer: el('div', { class: 'row-line' }, cancel, go),
  });
  cancel.addEventListener('click', () => modal.close());
  go.addEventListener('click', async () => {
    const category = sel.value || REPORT_CATEGORIES[0];
    const extra = details.value.trim();
    err.hidden = true;
    go.disabled = true;
    try {
      if (onSubmit) await onSubmit({ targetType, targetId, category, extra });
      modal.close();
      toast('Reported. Moderators will review it.', 'ok');
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message || 'Could not send report.';
    } finally {
      go.disabled = false;
    }
  });
  setTimeout(() => { try { details.focus(); } catch { /* ignore */ } }, 50);
  return modal;
}

// ---- emoji picker ---------------------------------------------------------
// A categorised, searchable palette that inserts at the caller's cursor. Pure
// client-side: no backend, no contracts — the composer sends plain text.
//
// Grouped with a sticky search field, because a single flat grid of ~70 emoji
// meant scrolling for anything past the first screenful. Categories are ordered
// by how often people reach for them, not alphabetically.
const EMOJI_CATEGORIES = [
  {
    id: 'faces', label: 'Smileys', emoji: ('😀 😁 😂 🤣 😊 😄 😍 🥰 😘 😗 😙 😚 🙂 🙃 😉 😌 😔 🥺 😢 😭 😤 😠 😡 🤬 '
      + '🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫣 🤭 🫢 🫡 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 '
      + '❓ ❗ 😇 🤠 😈 👿 👹 👺 🤡 💩 👻 💀 ☠️ 👽 👾 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾 🥳 😎 😕 🙃'),
  },
  {
    id: 'people', label: 'People', emoji: ('👋 🤚 🖐 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 '
      + '🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦿 🦵 🦶 👂 🦻 👃 🧠 🫀 🫁 🦷 🦴 👀 👁 👅 👄 💋 🩸'),
  },
  {
    id: 'nature', label: 'Nature', emoji: ('🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐽 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🐣 🐥 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🪱 🐛 🦋 🐌 🐞 🐜 🪰 🪲 🦂 🐢 🐍 🦎 🦖 🦕 🐙 🦑 🦐 🦞 🦀 🐡 🐠 🐟 🐬 🐳 🐋 '
      + '🦈 🐊 🐅 🐆 🦓 🦍 🦧 🐘 🦛 🦏 🐪 🐫 🦒 🦘 🐃 🐂 🐄 🐎 🐖 🐏 🐑 🦙 🐐 🦌 🐕 🐩 🦮 🐈 🐓 🦃 🦤 🦚 🦜 🦢 🕊 🐇 🦝 🦨 🦡 🦫 🦦 🦥 🐁 🐀 🐿 🦔 🌵 🎄 🌲 🌳 🌴 🪵 🌱 🌿 ☘️ 🍀 🎍 🎋 🍃 🍂 🍁 🍄 🌾 💐 🌷 🌹 🥀 🌺 🌸 🌼 🌻'),
  },
  {
    id: 'food', label: 'Food', emoji: ('🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🫑 🌽 🥕 🫒 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🫓 🥙 🧆 🌮 🌯 🥗 🥘 🫕 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🦪 🍤 🍙 🍚 🍘 🍥 🥠 🥮 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 🍼 🫖 ☕ 🍵 🧃 🥤 🧋 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉 🍾 🧊'),
  },
  {
    id: 'activity', label: 'Activity', emoji: ('⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🪀 🏓 🏸 🏒 🏑 🥍 🏏 🪃 🥅 ⛳ 🪁 🏹 🎣 🤿 🥊 🥋 🎽 🛹 🛼 🛷 ⛸️ 🥌 🎿 ⛷️ 🏂 🪂 🏋️ 🤼 🤸 ⛹️ 🤺 🤾 🏌️ 🏇 🧘 🏄 🏊 🤽 🚣 🧗 🚵 🚴 🏆 🥇 🥈 🥉 🏅 🎖️ 🏵️ 🎗️ 🎫 🎟️ 🎪 🤹 🎭 🩰 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🪕 🎻 🎲 ♟️ 🎯 🎳 🎮 🎰 🧩 🎆 🎇 🎊 🎉 🎈 🎁 🔔'),
  },
  {
    id: 'travel', label: 'Travel', emoji: ('🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🦯 🦽 🦼 🛴 🚲 🛵 🏍️ 🛺 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🛩️ 💺 🛰️ 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥️ 🛳️ ⛴️ 🚢 ⚓ 🪝 ⛽ 🚧 🚦 🚥 🗺️ 🗿 🗽 🗼 🏰 🎡 🎢 🎠 ⛲ ⛱️ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🗻 🏕️ ⛺ 🛖 🏠 🏡 🏘️ 🏚️ 🏗️ 🏭 🏢 🏬 🏣 🏤 🏥 🏦 🏨 🏪 🏫 🏩 💒 🏛️ ⛪ 🕌 🕍 🛕 🕋 🌁 🌃 🏙️ 🌄 🌅 🌆 🌇 🌉 ♨️ 🎑 🏞️ 🌠 🎇 🎆 🌌'),
  },
  {
    id: 'objects', label: 'Objects', emoji: ('⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💽 💾 💿 📀 📼 📷 📸 📹 🎥 📽️ 📞 ☎️ 📟 📠 📺 📻 🎙️ ⏱️ ⏲️ ⏰ 🕰️ ⌛ ⏳ 📡 🔋 🔌 💡 🔦 🕯️ 🪔 🧯 🛢️ 💸 💵 💴 💶 💷 🪙 💰 💳 💎 ⚖️ 🪜 🧰 🔧 🔨 ⚒️ 🛠️ ⛏️ 🔩 ⚙️ 🧱 ⛓️ 🧲 🔫 💣 🧨 🪓 🔪 🗡️ ⚔️ 🛡️ 🚬 ⚰️ 🪦 🏺 🔮 📿 🧿 💈 ⚗️ 🔭 🔬 🕳️ 🩹 🩺 💊 💉 🧬 🦠 🧫 🧪 🌡️ 🧹 🪠 🧺 🧻 🚽 🚰 🚿 🛁 🛀 🧼 🪥 🪒 🧽 🪣 🧴 🛎️ 🔑 🗝️ 🚪 🪑 🛋️ 🛏️ 🖼️ 🛍️ 🛒 🎁 🎈 🎏 🎀 🎊 🎉 🪄 🪅 🎎 🏮 🎐 🧧 ✉️ 📩 📨 📧 💌 📥 📤 📦 🏷️ 📪 📫 📬 📭 📮 📯 📜 📃 📄 📑 🧾 📊 📈 📉 🗒️ 🗓️ 📆 📅 🗑️ 📇 🗃️ 🗳️ 🗄️ 📋 📁 📂 🗂️ 🗞️ 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🧷 🔗 📎 🖇️ 📐 📏 🧮 📌 📍 ✂️ 🖊️ 🖋️ ✒️ 🖌️ 🖍️ 📝 ✏️ 🔍 🔎 🔏 🔐 🔒 🔓'),
  },
  {
    id: 'symbols', label: 'Symbols', emoji: ('❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉️ ☸️ ✡️ 🔯 🕎 ☯️ ☦️ 🛐 ⛎ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ 🆔 ⚛️ 🉑 ☢️ ☣️ 📴 📳 🈶 🈚 🈸 🈺 🈷️ ✴️ 🆚 💮 🉐 ㊙️ ㊗️ 🈴 🈵 🈹 🈲 🅰️ 🅱️ 🆎 🆑 🅾️ 🆘 ❌ ⭕ 🛑 ⛔ 📛 🚫 💯 💢 ♨️ 🚷 🚯 🚳 🚱 🔞 📵 🚭 〽️ ⚠️ 🚸 🔱 ⚜️ 🔰 ♻️ ✅ 🈯 💹 ❇️ ✳️ ❎ 🌐 💠 Ⓜ️ 🌀 💤 💬 🗯️ ♠️ ♣️ ♥️ ♦️ ♟️ 🃏 🎴 🀄 🕐 ⭐ 🌟 ✨ 🔥 ⚡ 💥 💫'),
  },
];

// Shortcodes, so the palette is usable without reading glyphs and so search
// works in English. Deliberately partial: it covers the common ones, and
// anything unlisted still gets a text-substring match on its label.
const EMOJI_NAMES = {
  grin: '😀', smile: '😄', joy: '😂', rofl: '🤣', blush: '😊', heart_eyes: '😍',
  thinking: '🤔', neutral: '😐', rolling_eyes: '🙄', sleep: '😴', scream: '😱',
  sob: '😭', rage: '😡', party: '🥳', fire: '🔥', tada: '🎉', sparkles: '✨',
  ok: '👌', thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎',
  clap: '👏', pray: '🙏', muscle: '💪', wave: '👋', heart: '❤️', broken_heart: '💔',
  hundred: '💯', star: '⭐', zap: '⚡', boom: '💥', eyes: '👀', see_no_evil: '🙈',
  skull: '💀', ghost: '👻', robot: '🤖', poop: '💩', clown: '🤡',
  pizza: '🍕', beer: '🍺', coffee: '☕', cake: '🎂', cookie: '🍪',
  rocket: '🚀', game: '🎮', guitar: '🎸', soccer: '⚽', basketball: '🏀',
  trophy: '🏆', bug: '🐛', cat: '🐱', dog: '🐶', fox: '🦊',
  white_check_mark: '✅', x: '❌', warning: '⚠️', question: '❓', exclamation: '❗',
  bulb: '💡', lock: '🔒', key: '🔑', hammer: '🔨', wrench: '🔧',
  bell: '🔔', link: '🔗', memo: '📝', book: '📚', calendar: '📅',
};

const NAME_OF = (() => {
  const byChar = new Map();
  for (const [name, ch] of Object.entries(EMOJI_NAMES)) byChar.set(ch, name.replace(/_/g, ' '));
  return (e) => byChar.get(e) || e;
})();

export function showEmojiPicker(anchor, onPick) {
  closeContextMenu();
  const root = qs('#popover-root') || document.body;
  const pop = el('div', { class: 'popover emoji-picker', role: 'dialog', 'aria-label': 'Choose an emoji' });

  const search = el('input', {
    class: 'emoji-search', type: 'search', placeholder: 'Search emoji…',
    'aria-label': 'Search emoji', autocomplete: 'off', spellcheck: 'false',
  });
  const results = el('div', { class: 'emoji-results' });
  pop.appendChild(search);
  pop.appendChild(results);

  const flat = [];
  for (const cat of EMOJI_CATEGORIES) {
    for (const e of new Set(cat.emoji.split(' '))) flat.push({ e, name: NAME_OF(e) });
  }

  const cell = (e, name) => {
    const b = el('button', { class: 'emoji-cell', type: 'button', title: name || e, 'aria-label': name || e }, e);
    b.addEventListener('click', () => {
      closeContextMenu();
      if (onPick) onPick(e);
    });
    return b;
  };

  // Grouped view: each category keeps its own heading so the palette stays
  // navigable as it grows.
  const paintGroups = () => {
    clear(results);
    for (const cat of EMOJI_CATEGORIES) {
      const list = [...new Set(cat.emoji.split(' '))];
      if (!list.length) continue;
      const sec = el('section', { class: 'emoji-group' });
      sec.appendChild(el('div', { class: 'emoji-group__label' }, cat.label));
      const grid = el('div', { class: 'emoji-grid' });
      for (const e of list) grid.appendChild(cell(e, NAME_OF(e)));
      sec.appendChild(grid);
      results.appendChild(sec);
    }
  };

  // Search view: a flat grid of matches. Matching the shortcode is what makes
  // this usable - a glyph has no text to search against.
  const paintSearch = (q) => {
    clear(results);
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) { paintGroups(); return; }
    const hits = flat.filter((x) => x.name.toLowerCase().includes(needle) || x.e === needle);
    if (!hits.length) {
      results.appendChild(el('div', { class: 'emoji-empty' }, 'No emoji match "' + String(q).trim() + '"'));
      return;
    }
    const grid = el('div', { class: 'emoji-grid' });
    for (const x of hits) grid.appendChild(cell(x.e, x.name));
    results.appendChild(grid);
  };

  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => paintSearch(search.value), 60);
  });

  // Arrow keys walk the visible grid; Enter picks. Without this the palette is
  // mouse-only, which is half the reason the old one felt thin.
  results.addEventListener('keydown', (e) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'];
    if (!keys.includes(e.key)) return;
    const cells = [...results.querySelectorAll('.emoji-cell')];
    if (!cells.length) return;
    const at = cells.indexOf(document.activeElement);
    e.preventDefault();
    const perRow = Math.max(1, Math.round(cells[0].parentElement.clientWidth / (cells[0].offsetWidth || 1)));
    let next = at;
    if (e.key === 'ArrowRight') next = at + 1;
    else if (e.key === 'ArrowLeft') next = at - 1;
    else if (e.key === 'ArrowDown') next = at + perRow;
    else next = at - perRow;
    if (next < 0) next = 0;
    if (next >= cells.length) next = cells.length - 1;
    cells[next].focus();
  });

  paintGroups();
  root.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let left = Math.min(Math.max(8, r.left), Math.max(8, innerWidth - pr.width - 8));
  let top = r.top - pr.height - 8;
  if (top < 8) top = Math.min(innerHeight - pr.height - 8, r.bottom + 8);
  pop.style.left = left + 'px';
  pop.style.top = Math.max(8, top) + 'px';
  const onKey = (e) => {
    if (e.key === 'Escape') { closeContextMenu(); return; }
    // Typing while the palette is open filters it, matching how every other
    // picker in the app behaves. Guarded so it does not fight the search field.
    if (e.target === search || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length === 1) {
      search.value += e.key;
      paintSearch(search.value);
      search.focus();
    }
  };
  const onDown = (e) => { if (!pop.contains(e.target)) closeContextMenu(); };
  const onScroll = () => closeContextMenu();
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
  }, 0);
  pop._ctxCleanup = () => {
    clearTimeout(timer);
    document.removeEventListener('pointerdown', onDown);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
  };
  return { pop, hide: closeContextMenu };
}

// Insert text at the cursor of a textarea/input, preserving undo + focus.
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
  try { field.focus(); } catch { /* ignore */ }
}

// ---- time -----------------------------------------------------------------

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

export function mentionify(text, meUsername, meId) {
  // Highlight @mentions and @me so the client can act on mentions.
  // Pure presentation; no markdown engine. Also linkify bare URLs.
  let out = esc(text);
  const fmtMention = (m0, name) => {
    const mine = name === meUsername || name === meId;
    return '<span class="msg-mention">' + esc(m0) + '</span>';
  };
  if (meUsername || meId) {
    out = out.replace(/@((?:[A-Za-z0-9_.]{2,32})|me|Me)/g, fmtMention);
  }
  out = out.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  out = out.replace(/\n/g, '<br>');
  return out;
}

// ---- api base for attachment src ----------------------------------

export function apiSrc(path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return TrycordConfig.apiUrl().replace(/\/+$/, '') + path;
}

export default { esc, el, clear, toast, openModal, confirmDialog, showPopover, relTime, fullTime, mentionify, apiSrc };

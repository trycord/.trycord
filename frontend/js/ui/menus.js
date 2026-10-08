// The one menu system. Callers list items; they do not build DOM, so a long-press
// and a right-click cannot drift apart.
//
// Split out of ui.js, which also held the primitives, the overlays and the emoji
// picker. It takes el(), icon() and qs() from ui/dom.js, so ui.js and this module do
// not import each other.

import { el, icon, qs, focusQuietly } from './dom.js';

// One menu system for every entity in the app. Callers do not build DOM; they
// list, so a long-press and a right-click can never drift apart.

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
    // Icon first, so the label and its description stay left-aligned with each
    // other whether or not an item has one.
    if (item.icon) {
      // Name or ready-made content; a name is drawn rather than printed.
      b.appendChild(el('span', { class: 'pop-item__icon', 'aria-hidden': 'true' },
        typeof item.icon === 'string' ? icon(item.icon) : item.icon));
    }
    b.appendChild(wrap);
    if (hasSub) b.appendChild(el('span', { class: 'pop-item__caret', 'aria-hidden': 'true' }, '›'));

    if (hasSub) {
      let sub = null;
      const openSub = () => {
        if (sub || b.disabled) return;
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
      // pulled the next ArrowDown into the submenu and the user could never
      b.addEventListener('click', (e) => { e.stopPropagation(); openSub(); });
      b.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); openSub(); } });
    } else {
      b.addEventListener('mouseenter', () => {
        if (ctx.depth < menuStack.length - 1) closeFrom(ctx.depth + 1);
      });
      b.addEventListener('click', () => {
        if (b.disabled) return;
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

  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const left = Math.min(Math.max(MENU_EDGE, x), Math.max(MENU_EDGE, innerWidth - w - MENU_EDGE));
  const top = Math.min(Math.max(MENU_EDGE, y), Math.max(MENU_EDGE, innerHeight - h - MENU_EDGE));
  const overflowsX = x + w > innerWidth - MENU_EDGE;
  const overflowsY = y + h > innerHeight - MENU_EDGE;
  if ((overflowsX && innerWidth - w - MENU_EDGE < MENU_EDGE) || (overflowsY && innerHeight - h - MENU_EDGE < MENU_EDGE)) {
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = MENU_EDGE + 'px';
    if (h > innerHeight - MENU_EDGE * 2) {
      pop.style.maxHeight = (innerHeight - MENU_EDGE * 2) + 'px';
      pop.style.overflowY = 'auto';
    }
  }
}

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

// Positions a menu under its trigger rather than at a point. The alignment
// rules match placeSub so a dropdown and a submenu opened from it line up.
function placeUnder(pop, anchor) {
  const a = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  // Clamped at both ends, the same way place() clamps a point. It only had the
  // far edge before, so a trigger near the left of the window put the menu flush
  // against the screen with no margin at all.
  let left = a.left;
  if (left + pr.width > innerWidth - MENU_EDGE) left = innerWidth - pr.width - MENU_EDGE;
  left = Math.max(MENU_EDGE, left);
  pop.style.left = Math.round(left) + 'px';
  let top = a.bottom + 4;
  // Flip above when there is no room below, so a menu near the bottom of the
  // window is still reachable.
  if (top + pr.height > innerHeight - MENU_EDGE) {
    const above = a.top - pr.height - 4;
    top = above >= MENU_EDGE ? above : Math.max(MENU_EDGE, innerHeight - pr.height - MENU_EDGE);
  }
  pop.style.top = Math.round(top) + 'px';
}

// A menu owned by a trigger button, opened by click and by Enter/Space.
//
// This is the same menu as right-click and long-press use - same items, same
// keyboard handling, same dismissal. It replaces a second, thinner dropdown
// implementation that knew nothing about submenus, disabled items, focus
// movement or Escape, and so behaved differently from every other menu in the
// app depending on which one a member happened to open.
export function attachMenu(anchor, factory, opts = {}) {
  if (!anchor) return () => {};
  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-expanded', 'false');

  const toggle = () => {
    if (menuStack.length) { closeContextMenu(); return; }
    const items = factory();
    if (!items || !items.length) return;
    const pop = showContextMenuAt(null, items, {
      x: 0, y: 0, depth: 0,
      target: opts.target ? opts.target(anchor) : null,
      node: anchor,
      sheet: sheetMode(opts.sheet),
      under: anchor,
    });
    if (!pop) return;
    anchor.setAttribute('aria-expanded', 'true');
    // First real item, so the keyboard does not have to hunt past the panel.
    const first = pop.querySelector('.pop-item:not([disabled])');
    if (first && opts.focusFirst !== false) first.focus();
  };

  anchor.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  });
  anchor.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    }
  });
  return () => closeContextMenu();
}

function showContextMenuAt(anchor, items, ctx) {
  const pop = buildMenu(items, ctx, ctx.depth);
  if (!pop.querySelector('.pop-item')) return null;
  const root = qs('#popover-root') || document.body;

  if (ctx.depth > 0) {
    pop.classList.add('ctx-menu--sheet');
    root.appendChild(pop);
    placeSub(pop, ctx.anchor);
  } else if (ctx.sheet) {
    pop.classList.add('ctx-menu--sheet');
    const scrim = el('div', { class: 'ctx-scrim' });
    root.appendChild(scrim);
    root.appendChild(pop);
    pop.style.left = '0px';
    pop.style.top = 'auto';
    pop.style.bottom = '0px';
    scrim.addEventListener('pointerdown', closeContextMenu);
  } else if (ctx.under) {
    // Owned by a trigger button rather than a pointer position.
    root.appendChild(pop);
    placeUnder(pop, ctx.under);
  } else {
    root.appendChild(pop);
    place(pop, ctx.x, ctx.y);
  }

  // closeFrom already resets aria-expanded on whatever it records as the
  // trigger, so anything reaching here as an anchor has to have had it set.
  // Without this the button was marked not-expanded on close having never been
  // marked expanded at all.
  const anchorBtn = ctx.anchorBtn || ctx.under || null;
  if (anchorBtn && anchorBtn.setAttribute) {
    anchorBtn.setAttribute('aria-haspopup', 'menu');
    anchorBtn.setAttribute('aria-expanded', 'true');
  }

  menuStack.push({ pop, depth: ctx.depth, anchorBtn });
  return pop;
}

export function showContextMenu(clientX, clientY, items, opts = {}) {
  closeContextMenu();
  const ctx = {
    x: clientX, y: clientY, depth: 0,
    target: opts.target || null,
    node: opts.node || null,
    sheet: sheetMode(opts.sheet),
    // The trigger, when the menu was opened from a button. Tracked so closing
    // the menu can put the button's aria-expanded back, whether it was closed by
    // Escape, an outside click, a selection, or a resize.
    under: opts.under || null,
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
  setTimeout(bind, 0);
  menuCleanup = () => {
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
  };

  const first = itemsOf(pop)[0];
  if (first) { focusQuietly(first, { preventScroll: true }) }
  return { pop, hide: closeContextMenu };
}

// rather than leaking listeners through repaints.
export function attachContextMenu(el, factory, opts = {}) {
  if (!el) return () => {};
  // A menu that cannot be reached from the keyboard is a mouse-only feature, and
  // the ContextMenu key and Shift+F10 handlers below are dead code without this.
  // A plain div is not focusable, so nothing in the interface could deliver those
  // keys to it: the handlers existed and were unreachable.
  if (opts.keyboard !== false && el.tagName !== 'BUTTON' && el.tagName !== 'A'
      && !el.hasAttribute('tabindex') && !el.matches('[tabindex]')) {
    el.setAttribute('tabindex', '0');
  }
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

  let timer = null; let sx = 0; let sy = 0; let fired = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  const onTouchStart = (e) => {
    if (e.touches.length !== 1) { cancel(); return; }
    fired = false;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    cancel();
    timer = setTimeout(() => {
      fired = true;
      if (opts.onLongPress) opts.onLongPress(el, sx, sy);
      else open(sx, sy);
    }, LONG_PRESS_MS);
  };
  const onTouchMove = (e) => {
    if (!timer) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - sx) > LONG_PRESS_SLOP || Math.abs(t.clientY - sy) > LONG_PRESS_SLOP) cancel();
  };
  const onTouchEnd = () => { cancel(); };
  // A long press that opened the menu must not also fire a click underneath it.
  const onClickCapture = (e) => { if (fired) { e.stopPropagation(); e.preventDefault(); fired = false; } };

  const onKeyDown = (e) => {
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      open(r.left + Math.min(24, r.width / 2), r.top + Math.min(24, r.height / 2));
    }
  };

  el.addEventListener('contextmenu', onContextMenu);
  // Long-press is the touch equivalent of a right-click and is kept on every
  // device. What it produces is not fixed here: a caller that wants the press to
  // do something other than open a menu - a message expanding its actions in
  // place, say - passes onLongPress and the gesture still fires, it just lands
  // somewhere else. Only the tap-suppression bookkeeping is shared.
  if (opts.touch !== false) {
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
  }
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
  // These two cleanups are guarded separately, and that is the point. A caller that
  // threw out of menuCleanup - only showContextMenu sets one - used to stop this
  // function before the loop below ran, which left the popovers in the document and
  // left Escape unable to close them: a menu that could be opened and not dismissed.
  // A cleanup that fails is a leak. It is not a reason to leak more.
  if (menuCleanup) {
    try {
      menuCleanup();
    } catch {
      // Dropped. The popovers still have to go.
    }
    menuCleanup = null;
  }

  for (const pop of Array.from(document.querySelectorAll('.popover.user-card, .popover.emoji-picker, .ctx-scrim'))) {
    try { if (pop._ctxCleanup) pop._ctxCleanup(); } catch { /* the node goes regardless */ }
    pop.remove();
  }
}

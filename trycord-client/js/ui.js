
import { TrycordConfig } from './config.js';

export function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const FORM_CONTROLS = ['input', 'select', 'textarea'];

let autoId = 0;

function associateLabels(node) {
  for (const label of node.querySelectorAll('label:not([for])')) {
    const siblings = label.parentElement ? Array.from(label.parentElement.children) : [];
    const at = siblings.indexOf(label);
    const control = siblings
      .slice(at + 1)
      .find((sib) => FORM_CONTROLS.includes(sib.tagName.toLowerCase()));
    if (!control) continue;
    if (!control.id) control.id = 'f-' + (++autoId);
    label.setAttribute('for', control.id);
  }
}

// One icon set, drawn rather than typed.
//
// The UI used to reach for Unicode pictographs - a smiling face for Friends, a
// club suit for Alerts, an envelope for DMs. They render differently on every
// platform, some are emoji and get the coloured treatment, and none of them line
// up with the stroke weight of the type beside them. That inconsistency is most
// of what makes an interface read as assembled rather than designed.
//
// These are inline SVG on a 24-grid with a 1.7 stroke, so they inherit
// currentColor, scale with font-size, and match each other. `icon()` returns an
// element rather than a string so it can be dropped straight into el().
export const ICON_PATHS = {
  home: 'M3 10.6 12 3.5l9 7.1V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  plus: 'M12 5v14M5 12h14',
  mail: 'M3 6.5h18v11H3zM3 7l9 6.5L21 7',
  users: 'M16 20v-1.6a3.4 3.4 0 0 0-3.4-3.4H6.4A3.4 3.4 0 0 0 3 18.4V20M9.5 11.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5M21 20v-1.6a3.4 3.4 0 0 0-2.6-3.3M15.5 5.2a3.25 3.25 0 0 1 0 6.1',
  bell: 'M18 8.5a6 6 0 1 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 14.5 18 8.5M13.7 20a2 2 0 0 1-3.4 0',
  search: 'M11 18.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15M20.5 20.5l-4.4-4.4',
  menu: 'M3.5 6.5h17M3.5 12h17M3.5 17.5h17',
  hash: 'M9 3.5 7 20.5M17 3.5l-2 17M3.5 8.5h17M3 15.5h17',
  gear: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1',
  pin: 'M9 3.5h6l-.7 5.2 3.2 3.3H6.5l3.2-3.3zM12 12v8.5',
  pencil: 'M16.5 4.5l3 3M4 20l.9-3.8L15.6 5.5a1.6 1.6 0 0 1 2.3 0l.6.6a1.6 1.6 0 0 1 0 2.3L7.8 19.1z',
  close: 'M6 6l12 12M18 6L6 18',
  more: 'M12 6.5h.01M12 12h.01M12 17.5h.01',
  chevronDown: 'M6 9.5l6 6 6-6',
  chevronRight: 'M9.5 6l6 6-6 6',
  flag: 'M5 21V4.5M5 5h11l-1.8 3.5L16 12H5',
  star: 'M12 3.5l2.7 5.5 6 .9-4.4 4.2 1 6-5.3-2.8-5.4 2.8 1-6L3.3 9.9l6-.9z',
  check: 'M4.5 12.5l5 5 10-11',
  warn: 'M12 4 2.8 20h18.4zM12 10v4.2M12 17.2h.01',
  shield: 'M12 3.2 19 6v6.2c0 4.3-2.9 7.4-7 8.6-4.1-1.2-7-4.3-7-8.6V6z',
  upload: 'M12 16V4.5M7.5 9 12 4.5 16.5 9M4 15.5v3A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-3',
  download: 'M12 4v11.5M7.5 11l4.5 4.5 4.5-4.5M4 16.5v2A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-2',
  trash: 'M4.5 6.5h15M9.5 6.5V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7M6.5 6.5 7.4 20a1.3 1.3 0 0 0 1.3 1.2h6.6a1.3 1.3 0 0 0 1.3-1.2l.9-13.5',
  ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M5.6 5.6l12.8 12.8',
  mute: 'M11 5.5 6.8 9H3.5v6h3.3L11 18.5zM15.5 9.5l5 5M20.5 9.5l-5 5',
  volume: 'M11 5.5 6.8 9H3.5v6h3.3L11 18.5zM15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12',
  layers: 'M12 3 3 7.5l9 4.5 9-4.5zM3 12.5l9 4.5 9-4.5M3 17l9 4.5 9-4.5',
  list: 'M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M3.2 9.5h17.6M3.2 14.5h17.6M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18',
  logout: 'M15 8V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20h8a1.5 1.5 0 0 0 1.5-1.5V16M10 12h10M17 8.5l3.5 3.5-3.5 3.5',
  compass: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M15.5 8.5l-2 5-5 2 2-5z',
  image: 'M4.5 4.5h15v15h-15zM8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M4.5 16.5l4.5-4.5 3.5 3.5 3-3 4 4',
  document: 'M6 3.5h7l5 5v12H6zM13 3.5v5h5M9 13h6M9 16.5h6',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5.2l3.2 2',
  inbox: 'M3.5 13.5h4l1.5 3h6l1.5-3h4M3.5 13.5 6 5h12l2.5 8.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19z',
};

export function icon(name, opts = {}) {
  const d = ICON_PATHS[name];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', opts.weight || '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (opts.size) { svg.setAttribute('width', opts.size); svg.setAttribute('height', opts.size); }
  if (opts.class) svg.setAttribute('class', opts.class);
  // SVGElement.className is read-only in WebKit.
  else svg.setAttribute('class', 'ui-icon');
  for (const seg of (d || ICON_PATHS.inbox).split(' M').map((p, i) => (i ? 'M' + p : p))) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', seg);
    svg.appendChild(path);
  }
  return svg;
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
  if (node.querySelector('label')) associateLabels(node);
  return node;
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function qs(sel, root = document) { return root.querySelector(sel); }
export function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }


export function toast(message, kind = 'info', timeout = 4200) {
  const root = qs('#toast-root');
  if (!root) return;
  const t = el('div', { class: 'toast ' + kind }, message);
  root.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity 240ms';
    setTimeout(() => t.remove(), 260);
  }, timeout);
}

export function announce(text) {
  const node = qs('#route-announcer');
  if (!node) return;
  node.textContent = '';
  requestAnimationFrame(() => { node.textContent = text; });
}


// The button factory. Not a style convenience - `type` defaults to 'button'
// because a <button> with no type is a submit button, and most of these live
// inside a <form>. Every call site that wrote `type: 'button'` by hand was
// re-deriving the same three lines and one omission submitted the surrounding
// form by accident. `submit: true` is the deliberate opt-in for the exception.
export function btn(label, opts = {}) {
  const { variant = '', size = '', icon: iconArg, onClick, type, title, ariaLabel, disabled, className = '' } = opts;
  const classes = ['btn', variant, size, className].filter(Boolean).join(' ');
  const node = el('button', {
    class: classes,
    type: type || (opts.submit ? 'submit' : 'button'),
    onClick,
    title: title || null,
    'aria-label': ariaLabel || null,
    disabled: !!disabled,
  });
  // A name draws the glyph; anything else is taken as ready-made content. Every
  // call site passes a name, and appending the string itself printed "mail" and
  // "bell" on the button instead of an icon.
  if (iconArg) {
    const content = typeof iconArg === 'string' ? icon(iconArg) : iconArg;
    node.appendChild(el('span', { class: 'btn__icon', 'aria-hidden': 'true' }, content));
  }
  node.appendChild(el('span', {}, label));
  return node;
}

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
  const cancelBtn = btn('Cancel', { variant: 'ghost' });
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
  let left = a.left;
  if (left + pr.width > innerWidth - MENU_EDGE) left = Math.max(MENU_EDGE, innerWidth - pr.width - MENU_EDGE);
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

  menuStack.push({ pop, depth: ctx.depth, anchorBtn: ctx.anchorBtn || ctx.under || null });
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
  if (first) { try { first.focus({ preventScroll: true }); } catch { /* ignore */ } }
  return { pop, hide: closeContextMenu };
}

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
  // this on menuCleanup - which only showContextMenu sets - left Escape unable
  for (const pop of Array.from(document.querySelectorAll('.popover.user-card, .popover.emoji-picker, .ctx-scrim'))) {
    try { if (pop._ctxCleanup) pop._ctxCleanup(); } catch { /* ignore */ }
    pop.remove();
  }
}

export function showUserCard(clientX, clientY, { avatarEl, title, sub, statusLine, actions, bannerUrl = null } = {}) {
  closeContextMenu();
  const root = qs('#popover-root') || document.body;
  const pop = el('div', { class: 'popover user-card', role: 'dialog', 'aria-label': title || 'User' });
  // Banner is optional and loads through the authenticated media route, so
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

// Trust & Safety entry point shared by message/user reports. Fixed
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
  // A report that is never sent must not be reported as sent. A missing target
  if (!targetType || !targetId || typeof onSubmit !== 'function') {
    toast('This report cannot be submitted.', 'error');
    return null;
  }
  const err = el('div', { class: 'form-error', hidden: true });
  const sel = el('select', { class: 'input', 'aria-label': 'Reason' });
  for (const c of REPORT_CATEGORIES) sel.appendChild(el('option', { value: c }, c));
  const details = el('textarea', { class: 'textarea', style: { minHeight: '80px' }, maxlength: 4000, placeholder: 'Additional information (optional)' });
  const cancel = btn('Cancel', { variant: 'ghost' });
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
      await onSubmit({ targetType, targetId, category, extra });
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
    id: 'objects', label: 'Objects', emoji: ('⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💽 💾 💿 📀 📼 📷 📸 📹 🎥 📽️ 📞 ☎️ 📟 📠 📺 📻 🎙️ ⏱ ⏲ ⏰ 🕰️ ⌛ ⏳ 📡 🔋 🔌 💡 🔦 🕯️ 🪔 🧯 🛢️ 💸 💵 💴 💶 💷 🪙 💰 💳 💎 ⚖️ 🪜 🧰 🔧 🔨 ⚒️ 🛠️ ⛏️ 🔩 ⚙️ 🧱 ⛓️ 🧲 🔫 💣 🧨 🪓 🔪 🗡️ ⚔️ 🛡️ 🚬 ⚰️ 🪦 🏺 🔮 📿 🧿 💈 ⚗️ 🔭 🔬 🕳️ 🩹 🩺 💊 💉 🧬 🦠 🧫 🧪 🌡️ 🧹 🪠 🧺 🧻 🚽 🚰 🚿 🛁 🛀 🧼 🪥 🪒 🧽 🪣 🧴 🛎️ 🔑 🗝️ 🚪 🪑 🛋️ 🛏️ 🖼️ 🛍️ 🛒 🎁 🎈 🎏 🎀 🎊 🎉 🪄 🪅 🎎 🏮 🎐 🧧 ✉️ 📩 📨 📧 💌 📥 📤 📦 🏷️ 📪 📫 📬 📭 📮 📯 📜 📃 📄 📑 🧾 📊 📈 📉 🗒️ 🗓️ 📆 📅 🗑️ 📇 🗃️ 🗳️ 🗄️ 📋 📁 📂 🗂️ 🗞️ 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🧷 🔗 📎 🖇️ 📐 📏 🧮 📌 📍 ✂️ 🖊️ 🖋️ ✒️ 🖌️ 🖍️ 📝 ✏️ 🔍 🔎 🔏 🔐 🔒 🔓'),
  },
  {
    id: 'symbols', label: 'Symbols', emoji: ('♥ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉️ ☸️ ✡️ 🔯 🕎 ☯️ ☦️ 🛐 ⛎ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ 🆔 ⚛️ 🉑 ☢️ ☣️ 📴 📳 🈶 🈚 🈸 🈺 🈷️ ✴️ 🆚 💮 🉐 ㊙️ ㊗️ 🈴 🈵 🈹 🈲 🅰️ 🅱️ 🆎 🆑 🅾️ 🆘 ❌ ⭕ 🛑 ⛔ 📛 🚫 💯 💢 ♨️ 🚷 🚯 🚳 🚱 🔞 📵 🚭 〽️ ⚠️ 🚸 🔱 ⚜️ 🔰 ♻️ ✅ 🈯 💹 ❇️ ✳️ ❎ 🌐 💠 Ⓜ️ 🌀 💤 💬 🗯️ ♠️ ♣️ ♥️ ♦️ ♟️ 🃏 🎴 🀄 🕐 ⭐ 🌟 ✨ 🔥 ⚡ 💥 💫'),
  },
];

// works in English. Deliberately partial: it covers the common ones, and
const EMOJI_NAMES = {
  grin: '😀', smile: '😄', joy: '😂', rofl: '🤣', blush: '😊', heart_eyes: '😍',
  thinking: '🤔', neutral: '😐', rolling_eyes: '🙄', sleep: '😴', scream: '😱',
  sob: '😭', rage: '😡', party: '🥳', fire: '🔥', tada: '🎉', sparkles: '✨',
  ok: '👌', thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎',
  clap: '👏', pray: '🙏', muscle: '💪', wave: '👋', heart: '♥', broken_heart: '💔',
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

export default { esc, el, clear, toast, openModal, confirmDialog, relTime, fullTime, apiSrc, announce };

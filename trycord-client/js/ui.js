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

export function openModal({ title, body, footer, closeText = 'Close' }) {
  let box;
  const backdrop = el('div', { class: 'backdrop' }, (box = el('div', {
    class: 'modal',
    role: 'dialog',
    'aria-modal': 'true',
  })));
  const titleId = 'modal-title-' + Math.random().toString(36).slice(2, 8);
  if (title) {
    box.setAttribute('aria-labelledby', titleId);
    box.appendChild(el('h2', { id: titleId }, title));
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

// ---- context menus + user cards -------------------------------------------
// Cursor-anchored menu for right-click / long-press. Items:
//   { label, desc?, danger?, disabled?, onSelect? } or { sep: true }.
// Works for mouse and touch (the `contextmenu` event fires on long-press
// in mobile browsers), so one wiring covers desktop and mobile.
export function showContextMenu(clientX, clientY, items) {
  closeContextMenu();
  const root = qs('#popover-root') || document.body;
  const pop = el('div', { class: 'popover ctx-menu', role: 'menu' });
  for (const item of items || []) {
    if (item.sep) { pop.appendChild(el('div', { class: 'pop-sep' })); continue; }
    const b = el('button', {
      class: 'pop-item' + (item.danger ? ' danger' : ''),
      type: 'button', role: 'menuitem', disabled: !!item.disabled,
    });
    const wrap = el('span', {});
    wrap.append(el('span', {}, item.label));
    if (item.desc) wrap.append(el('span', { class: 'pop-desc' }, item.desc));
    b.appendChild(wrap);
    b.addEventListener('click', () => {
      closeContextMenu();
      if (item.onSelect) item.onSelect();
    });
    pop.appendChild(b);
  }
  if (!pop.children.length) return { pop: null, hide: () => {} };
  root.appendChild(pop);
  const pr = pop.getBoundingClientRect();
  let left = clientX;
  let top = clientY;
  if (left + pr.width > innerWidth - 8) left = Math.max(8, innerWidth - pr.width - 8);
  if (top + pr.height > innerHeight - 8) top = Math.max(8, innerHeight - pr.height - 8);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  const onKey = (e) => { if (e.key === 'Escape') closeContextMenu(); };
  const onScroll = () => closeContextMenu();
  const onDown = (e) => { if (!pop.contains(e.target)) closeContextMenu(); };
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
  const first = pop.querySelector('.pop-item:not([disabled])');
  if (first) { try { first.focus({ preventScroll: true }); } catch { /* ignore */ } }
  return { pop, hide: closeContextMenu };
}

export function closeContextMenu() {
  for (const pop of Array.from(document.querySelectorAll('.popover.ctx-menu, .popover.user-card'))) {
    try { if (pop._ctxCleanup) pop._ctxCleanup(); } catch { /* ignore */ }
    pop.remove();
  }
}

// Mini profile card anchored at a cursor point. The caller supplies the
// rendered avatar node (avatar lives in components.js; ui.js stays
// dependency-free) plus plain action descriptors.
export function showUserCard(clientX, clientY, { avatarEl, title, sub, statusLine, actions } = {}) {
  closeContextMenu();
  const root = qs('#popover-root') || document.body;
  const pop = el('div', { class: 'popover user-card', role: 'dialog', 'aria-label': title || 'User' });
  pop.appendChild(el('div', { class: 'user-card__banner' }));
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

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
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
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
  if (title) box.appendChild(el('h2', {}, title));
  if (body) box.appendChild(el('div', {}, body));
  if (footer) box.appendChild(el('div', { class: 'row-line', style: { marginTop: 'var(--t-d-4)', justifyContent: 'flex-end' } }, footer));

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  (qs('#modal-root') || document.body).appendChild(backdrop);
  const first = box.querySelector('input, button, textarea, select, [tabindex]');
  if (first) setTimeout(() => first.focus(), 30);
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
  }
  function onKey(e) { if (e.key === 'Escape') hidePopover(); }
  setTimeout(() => {
    document.addEventListener('pointerdown', hide);
    document.addEventListener('keydown', onKey);
  }, 0);
  return { pop, hide: hidePopover };
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
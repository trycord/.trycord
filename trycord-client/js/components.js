// Shared render helpers. Build real DOM nodes from real state objects;
// never from mock data.

import { esc, el, relTime, apiSrc, qs } from './ui.js';
import { peerPresence, can } from './state.js';
import Api from './api.js';

const AVATAR_COLORS = [
  '#6ea8fe', '#8b5cf6', '#58c97a', '#e2b03c', '#e06a5e',
  '#59c2c9', '#ef7b54', '#9f8bef', '#66c87f', '#d6619d',
];

export function hashColor(str) {
  let h = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export function initialOf(name) {
  const s = String(name || '?').trim();
  return (s[0] || '?').toUpperCase();
}

// Load a Bearer-authenticated image (channel attachment or profile media)
// into an object URL. Resolves null on any failure so callers can keep a
// colored-initial fallback instead of a broken <img>.
export async function loadAuthedImage(path) {
  if (!path) return null;
  try {
    const res = await Api.fetchProfileImage(path);
    let mime = 'application/octet-stream';
    try {
      const h = res.headers && res.headers.get ? res.headers.get('content-type') : null;
      if (h) mime = h;
    } catch { /* keep declared mime */ }
    return URL.createObjectURL(new Blob([res.buffer], { type: mime }));
  } catch { return null; }
}

export function avatar(user, { size = 'sm', withPresence = true } = {}) {
  const name = (user && (user.displayName || user.username)) || '?';
  const a = el('span', {
    class: 'avatar ' + size,
    style: { background: hashColor(name) },
    title: name,
    'aria-hidden': 'true',
  }, initialOf(name));
  // Upgrade to the user's image when present. The bytes live behind the
  // Bearer-authenticated route, so a bare <img src> would 401; fetch with
  // the real session and swap in a blob URL.
  if (user && user.avatarUrl) {
    const path = user.avatarUrl;
    loadAuthedImage(path).then((url) => {
      if (!url || !a.isConnected) return;
      a.classList.add('has-img');
      a.textContent = '';
      a.appendChild(el('img', { class: 'avatar-img', src: url, alt: '', loading: 'lazy' }));
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
  }
  if (withPresence && user && user.id) {
    const dot = el('span', { class: 'presence-dot ' + (peerPresence(user.id) === 'online' ? 'online' : '') });
    a.appendChild(dot);
  }
  return a;
}

export function presenceDot(id) {
  return el('span', { class: 'presence-dot ' + (peerPresence(id) === 'online' ? 'online' : '') });
}

export function realmTitle(text) {
  return el('div', { class: 'realm-title' }, text);
}

// ---- navigation rows -----------------------------------------------------

export function navRow({ label, sub, icon, href, active, count, onClick }) {
  const row = el('button', {
    class: 'nav-row' + (active ? ' active' : ''),
    type: 'button',
    dataset: { nav: label.toLowerCase().replace(/\s+/g, '-') },
    onClick: onClick,
  });
  if (icon) row.appendChild(el('span', { class: 'nv-icon' }, icon));
  const labelWrap = el('span', { class: 'nv-label' }, label);
  if (sub) labelWrap.append(' ', el('small', { class: 'muted' }, sub));
  row.appendChild(labelWrap);
  if (count && count > 0) row.appendChild(el('span', { class: 'nv-count' }, count > 99 ? '99+' : count));
  if (href) row.setAttribute('data-href', href);
  return row;
}

export function serverChip(server, { active = false, onClick } = {}) {
  const chip = el('button', {
    class: 'server-chip' + (active ? ' active' : ''),
    type: 'button',
    onClick,
    dataset: { serverId: server.id },
  });
  chip.appendChild(el('span', { class: 'chip-badge' }, initialOf(server.name)));
  chip.appendChild(el('span', { class: 'chip-name' }, server.name));
  if (server.is_owner) chip.appendChild(el('span', { class: 'chip-live', title: 'You own this server' }, '★'));
  return chip;
}

export function channelRow(channel, { active = false, onClick } = {}) {
  const row = el('button', {
    class: 'channel-row' + (active ? ' active' : ''),
    type: 'button',
    onClick,
    dataset: { channelId: channel.id },
  });
  row.appendChild(el('span', { class: 'ch-prefix' }, '#'));
  row.appendChild(el('span', { class: 'ch-name' }, channel.name));
  return row;
}

export function emptyState(icon, title, sub) {
  const box = el('div', { class: 'empty-state' });
  if (icon) box.appendChild(el('div', { class: 'es-icon' }, icon));
  if (title) box.appendChild(el('div', { style: { color: 'var(--t-txt2)', fontWeight: '600' } }, title));
  if (sub) box.appendChild(el('div', { style: { maxWidth: '420px' } }, sub));
  return box;
}

// ---- message row -----------------------------------------------------------

export function messageRow(msg, opts = {}) {
  // msg follows the channel GET/POST shape: item per endpoint.
  const authorName = msg.user || msg.author_name || msg.author_display || 'Unknown';
  const disp = msg.author_display || msg.author_name || msg.user || 'Unknown';
  const authorId = msg.author_id;
  const isMine = opts.meId !== undefined && String(authorId) === String(opts.meId);

  const row = el('div', { class: 'msg', dataset: { messageId: msg.id } });
  const avatarBox = avatar({ id: authorId, username: msg.user || msg.author_name, displayName: disp }, { withPresence: false });
  row.appendChild(avatarBox);

  const body = el('div', { class: 'msg-body' });

  if (opts.system) {
    row.classList.add('system');
    body.appendChild(el('div', {}, msg.content || ''));
    row.appendChild(body);
    return row;
  }

  const head = el('div', { class: 'msg-head' });
  head.appendChild(el('span', { class: 'msg-author' }, disp));
  head.appendChild(el('span', { class: 'msg-time' }, relTime(msg.created_at)));
  if (msg.edited_at) head.appendChild(el('span', { class: 'msg-edited' }, 'edited'));
  const actions = el('span', { class: 'msg-actions' });
  if (can('MANAGE_MESSAGES') || isMine) {
    actions.appendChild(el('button', {
      type: 'button', title: 'Delete', 'aria-label': 'Delete message',
      onClick: opts.onDelete,
    }, '🗑'));
  }
  if (isMine) {
    actions.appendChild(el('button', {
      type: 'button', title: 'Edit', 'aria-label': 'Edit message',
      onClick: opts.onEdit,
    }, '✎'));
  }
  head.appendChild(actions);
  body.appendChild(head);

  const text = el('div', { class: 'msg-text', html: opts.renderText ? opts.renderText(msg.content) : esc(msg.content) });
  body.appendChild(text);

  if (msg.attachments && msg.attachments.length) {
    const files = el('div', { class: 'msg-files' });
    for (const att of msg.attachments) {
      const isImg = /^image\//.test(String(att.mime || ''));
      if (isImg) {
        // Image bytes live behind the Bearer-authenticated
        // GET /api/attachments/:id endpoint, which a plain <img src>
        // can never satisfy (no Authorization header -> 401 -> broken
        // image). Load the bytes with the real session and swap in a
        // blob URL; on failure fall back to the file row + authed
        // download instead of a broken tile.
        const holder = el('span', { class: 'msg-file image is-loading' }, 'Loading ' + (att.filename || 'image') + '…');
        files.appendChild(holder);
        const fallbackRow = () => {
          if (opts.onDownload) {
            return el('span', { class: 'msg-file' },
              el('a', { href: apiSrc(att.url), target: '_blank', rel: 'noopener', onClick: (e) => { opts.onDownload(e, att); } }, '⬇ ' + att.filename));
          }
          return el('span', { class: 'msg-file' }, att.filename || 'attachment');
        };
        Api.fetchAttachment(att.id).then((res) => {
          let mime = att.mime || 'application/octet-stream';
          try {
            const h = res.headers && res.headers.get ? res.headers.get('content-type') : null;
            if (h) mime = h;
          } catch { /* keep declared mime */ }
          const url = URL.createObjectURL(new Blob([res.buffer], { type: mime }));
          const link = el('a', { class: 'msg-file image', href: url, target: '_blank', rel: 'noopener', title: att.filename || 'Open image' });
          const img = el('img', { src: url, alt: att.filename || 'attached image', loading: 'lazy' });
          img.addEventListener('load', () => { setTimeout(() => URL.revokeObjectURL(url), 30000); });
          img.addEventListener('error', () => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } holder.replaceWith(fallbackRow()); });
          link.appendChild(img);
          holder.replaceWith(link);
        }).catch(() => { holder.replaceWith(fallbackRow()); });
      } else {
        files.appendChild(el('span', { class: 'msg-file' },
          el('a', { href: apiSrc(att.url), target: '_blank', rel: 'noopener', onClick: opts.onDownload ? (e) => { opts.onDownload(e, att); } : null }, '⬇ ' + att.filename)));
      }
    }
    body.appendChild(files);
  }

  row.appendChild(body);
  return row;
}

// ---- compose helpers --------------------------------------------------------

export function avatarUploadPreview(file) {
  if (!file) return null;
  return { name: file.name, size: file.size, url: URL.createObjectURL(file) };
}

export default { avatar, avatar: avatar, presenceDot, realmTitle, navRow, serverChip, channelRow, emptyState, messageRow, initialOf, hashColor };
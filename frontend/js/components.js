// Shared presentational pieces: avatars, community marks, message rows,
// reactions, empty states.
//
// These are used by more than one surface, which is the only reason they live
// here. Everything reads live API data - a component here never from mock
// data.

import { esc, el, clear, relTime, apiSrc, icon, openLightbox, ICON_PATHS } from './ui.js';
import { embedTray, paintEmbeds, wireEmbedImages } from './embeds.js';
import { peerPresence, can } from './state.js';
import Api from './api.js';

// Defined in ui.js, re-exported here because the higher-level modules that use
// icons already import from this file.
export { icon, ICON_PATHS };

// Fallback marks for accounts with no avatar. The hash still decides which one -
// the same person is always the same colour, which is the part that helps - but
// every entry is a dark, low-saturation warm tone, so a screen full of accounts
// without pictures reads as one product instead of as a bag of sweets.
//
// The previous ten were blue, violet, magenta and mint at full strength. On a
// near-black warm surface they were the loudest thing on the page, and Ember
// stopped being the only saturated colour in the interface, which is the one thing
// it cannot be if it is going to mean anything.
const AVATAR_COLORS = [
  '#4a3f36', '#3f463c', '#4d4438', '#453a3a', '#3a4046',
  '#524a3f', '#414839', '#4a3f42', '#3e4540', '#514535',
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

export function avatarUrlOf(user) {
  if (!user) return null;
  return user.avatarUrl || user.avatar_url || null;
}
export function bannerUrlOf(user) {
  if (!user) return null;
  return user.bannerUrl || user.banner_url || null;
}

// Object URLs for authenticated media, keyed by path and shared for the
// session. Previously every render fetched the bytes again and revoked the URL
const mediaUrls = new Map();   // path -> Promise<string|null>

// never release any of them. Oldest insertion is evicted first: an avatar is
// only cached so re-renders do not refetch it, and the least recently *added*
const MEDIA_CACHE_MAX = 300;

function cacheMedia(path, promise) {
  mediaUrls.set(path, promise);
  while (mediaUrls.size > MEDIA_CACHE_MAX) {
    const oldest = mediaUrls.keys().next().value;
    if (oldest === undefined) break;
    evictMedia(oldest);
  }
  return promise;
}

function evictMedia(path) {
  const p = mediaUrls.get(path);
  if (p === undefined) return;
  mediaUrls.delete(path);
  if (p) p.then((u) => { if (u) URL.revokeObjectURL(u); }).catch(() => {});
}

export function loadAuthedImage(path) {
  if (!path) return Promise.resolve(null);
  const hit = mediaUrls.get(path);
  if (hit) return hit;
  const p = (async () => {
    try {
      // authenticated path, get bytes". One loader and one cache for both,
      const res = await Api.fetchAuthedImage(path);
      let mime = 'application/octet-stream';
      try {
        const h = res.headers && res.headers.get ? res.headers.get('content-type') : null;
        if (h) mime = h;
      } catch { /* keep declared mime */ }
      return URL.createObjectURL(new Blob([res.buffer], { type: mime }));
    } catch { return null; }
  })();
  return cacheMedia(path, p);
}

export function invalidateAuthedImage(path) {
  if (!path) return;
  evictMedia(path);
}

export function avatar(user, { size = 'sm', withPresence = true } = {}) {
  const name = (user && (user.displayName || user.display_name || user.username)) || '?';
  const a = el('span', {
    class: 'avatar ' + size,
    style: { background: hashColor(name) },
    title: name,
    'aria-hidden': 'true',
  }, initialOf(name));
  // Bearer-authenticated route, so a bare <img src> would 401; fetch with
  // the real session and swap in a blob URL.
  const src = avatarUrlOf(user);
  if (src) {
    loadAuthedImage(src).then((url) => {
      if (!url || !a.isConnected) return;
      a.classList.add('has-img');
      a.textContent = '';
      a.appendChild(el('img', { class: 'avatar-img', src: url, alt: '', loading: 'lazy' }));
    });
  }
  if (withPresence && user && user.id) {
    const dot = el('span', { class: 'presence-dot ' + (peerPresence(user.id) === 'online' ? 'online' : '') });
    a.appendChild(dot);
  }
  return a;
}

// The bytes are behind the authenticated media route, so the upgrade path is
// the same fetch-with-session-then-blob-URL as an avatar.
export function communityIconUrl(server) {
  if (!server) return null;
  return server.iconUrl || server.icon_url || null;
}

export function communityBannerUrl(server) {
  if (!server) return null;
  return server.bannerUrl || server.banner_url || null;
}

export function communityMark(name, { size = '', server = null } = {}) {
  const mark = el('span', {
    class: 'community-mark' + (size ? ' ' + size : ''),
    style: { background: hashColor(name) },
    'aria-hidden': 'true',
  }, initialOf(name));
  const src = communityIconUrl(server || (name && typeof name === 'object' ? name : null));
  if (src) {
    loadAuthedImage(src).then((url) => {
      if (!url || !mark.isConnected) return;
      mark.classList.add('has-img');
      mark.textContent = '';
      mark.appendChild(el('img', { class: 'community-mark__img', src: url, alt: '', loading: 'lazy' }));
    });
  }
  return mark;
}

export function navGroup({ label, collapsible = false, collapsed = false, action = null, id = null }) {
  const group = el('section', { class: 'nav-group' + (collapsible ? ' nav-group--collapsible' : ''), dataset: id ? { group: id } : {} });
  if (label) {
    const head = el('div', {
      class: 'nav-group__head',
      role: collapsible ? 'button' : null,
      tabindex: collapsible ? '0' : null,
      'aria-expanded': collapsible ? (collapsed ? 'false' : 'true') : null,
    });
    if (collapsible) {
      head.appendChild(el('span', { class: 'nav-group__caret' }, icon('chevronDown')));
    }
    head.appendChild(el('span', { class: 'nav-group__label' }, label));
    if (action) head.appendChild(action);
    if (collapsible) {
      let onToggle = null;
      const toggle = () => {
        const next = !group.classList.contains('is-collapsed');
        group.classList.toggle('is-collapsed', next);
        head.setAttribute('aria-expanded', next ? 'false' : 'true');
        if (typeof onToggle === 'function') onToggle(next);
      };
      group.onToggleChange = (fn) => { onToggle = fn; };
      head.addEventListener('click', (e) => {
        if (action && e.target.closest('.nav-group__action')) return;
        toggle();
      });
      head.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
      if (collapsed) group.classList.add('is-collapsed');
    }
    group.appendChild(head);
  }
  const list = el('div', { class: 'nav-group__list' });
  group.appendChild(list);
  group.list = list;
  return group;
}


export function navRow({ label, sub, icon, href, active, count, onClick }) {
  const row = el('button', {
    class: 'row row--nav' + (active ? ' active' : ''),
    type: 'button',
    title: label,
    'aria-label': label,
    'aria-current': active ? 'page' : null,
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

// A community in the rail: the mark, and the community's name under it.
//
// The name is the point. The rail used to be glyphs only, which made it a
// column of shapes to be memorised - a first-time user could not tell which
// community they were looking at without hovering each one, and the hover
// tooltip is not a label. The mark carries the community's own colour and icon;
// the word beneath it says what it is, and it ellipsises rather than truncating
// mid-glyph.
export function serverChip(server, { active = false, onClick } = {}) {
  const name = server.name || 'Community';
  const chip = el('button', {
    class: 'rail-community' + (active ? ' is-active' : ''),
    type: 'button',
    title: name,
    'aria-label': name,
    'aria-current': active ? 'page' : null,
    onClick,
    dataset: { serverId: server.id },
  });
  const mark = el('span', { class: 'rail-mark' });
  mark.appendChild(communityMark(name, { server }));
  chip.appendChild(mark);
  chip.appendChild(el('span', { class: 'rail-community__name' }, name));
  if (server.is_owner) {
    chip.title = name + ' — you own this community';
  }
  return chip;
}

// `iconName` is a key of ICON_PATHS. A caller may still pass an element, which
// is appended as-is.
export function emptyState(iconName, title, sub) {
  const box = el('div', { class: 'empty-state' });
  if (iconName) {
    box.appendChild(typeof iconName === 'string'
      ? el('div', { class: 'es-icon' }, icon(iconName))
      : iconName);
  }
  if (title) box.appendChild(el('div', { style: { color: 'var(--t-txt2)', fontWeight: '600' } }, title));
  if (sub) box.appendChild(el('div', { style: { maxWidth: '420px' } }, sub));
  return box;
}


// Downloading a message attachment. Raw blob, because the bytes are behind an
// authenticated route and a plain link would only ever produce a login page.
// Shared by channels and direct messages, which have identical needs here.
export async function downloadAttachment(att) {
  const res = await Api.fetchAttachment(att.id);
  const blob = new Blob([res.buffer]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = att.filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// The affordance on a message that has replies. It lives beside messageRow
// rather than in thread.js so the badge and the row that carries it do not
// import each other.
export function replyBadge(count, onOpen) {
  if (!count) return null;
  const label = count === 1 ? '1 reply' : count + ' replies';
  return el('button', {
    class: 'msg-thread-badge', type: 'button', 'aria-expanded': 'false',
    onClick: (e) => { e.stopPropagation(); onOpen(); },
  }, [el('span', { class: 'msg-thread-badge__count' }, String(count)), el('span', {}, label)]);
}

export function messageRow(msg, opts = {}) {
  const authorName = msg.user || msg.author_name || msg.author_display || 'Unknown';
  const disp = msg.author_display || msg.author_name || msg.user || 'Unknown';
  const authorId = msg.author_id;
  const isMine = opts.meId !== undefined && String(authorId) === String(opts.meId);

  const row = el('div', { class: 'msg', dataset: { messageId: msg.id } });
  const avatarBox = avatar({
    id: authorId,
    username: msg.user || msg.author_name,
    displayName: disp,
    avatarUrl: msg.author_avatar,
  }, { withPresence: false });
  row.appendChild(avatarBox);

  const body = el('div', { class: 'msg-body' });

  if (opts.system) {
    row.classList.add('system');
    body.appendChild(el('div', {}, msg.content || ''));
    row.appendChild(body);
    return row;
  }

  const head = el('div', { class: 'msg-head' });
  const authorBtn = el('button', {
    class: 'msg-author',
    type: 'button',
    title: 'View ' + disp,
    'data-user-id': authorId ? String(authorId) : '',
  }, disp);
  if (authorId) {
    const openCard = (e) => {
      e.stopPropagation();
      const r = authorBtn.getBoundingClientRect();
      import('./user-actions.js').then(({ openUserCard }) => {
        openUserCard({
          user: {
            id: authorId,
            username: msg.user || msg.author_name,
            displayName: disp,
            avatarUrl: msg.author_avatar, bannerUrl: msg.author_banner,
          },
          x: r.left,
          y: r.bottom + 6,
          serverId: opts.serverId,
        });
      }).catch(() => { /* the card is an enhancement; never break the message */ });
    };
    const openMenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      import('./user-actions.js').then(({ openUserMenu }) => {
        openUserMenu({
          user: {
            id: authorId,
            username: msg.user || msg.author_name,
            displayName: disp,
            avatarUrl: msg.author_avatar, bannerUrl: msg.author_banner,
          },
          x: e.clientX,
          y: e.clientY,
          serverId: opts.serverId,
        });
      }).catch(() => { /* same */ });
    };
    authorBtn.addEventListener('click', openCard);
    authorBtn.addEventListener('contextmenu', openMenu);
  } else {
    authorBtn.disabled = true;
  }
  head.appendChild(authorBtn);
  head.appendChild(el('span', { class: 'msg-time' }, relTime(msg.created_at)));
  if (msg.edited_at) head.appendChild(el('span', { class: 'msg-edited' }, 'edited'));
  const actions = el('span', { class: 'msg-actions' });
  if (can('MANAGE_MESSAGES') || isMine) {
    actions.appendChild(el('button', {
      type: 'button', title: 'Delete', 'aria-label': 'Delete message',
      onClick: opts.onDelete,
    }, icon('close')));
  }
  if (isMine) {
    actions.appendChild(el('button', {
      type: 'button', title: 'Edit', 'aria-label': 'Edit message',
      onClick: opts.onEdit,
    }, icon('pencil')));
  }
  head.appendChild(actions);
  body.appendChild(head);

  const text = el('div', { class: 'msg-text', html: opts.renderText ? opts.renderText(msg.content) : esc(msg.content) });
  body.appendChild(text);

  if (msg.pinned) {
    const pin = el('span', { class: 'msg-pinned', title: 'Pinned message' }, icon('flag'));
    head.appendChild(pin);
  }
  if (opts.onHover) {
    const bar = el('div', { class: 'msg-hoverbar' });
    const react = el('button', { type: 'button', title: 'Add reaction', 'aria-label': 'Add reaction' }, icon('smile'));
    react.addEventListener('click', (e) => { e.stopPropagation(); opts.onHover('react', react); });
    const more = el('button', { type: 'button', title: 'More actions', 'aria-label': 'More actions' }, icon('more'));
    more.addEventListener('click', (e) => { e.stopPropagation(); opts.onHover('more', more); });
    bar.append(react, more);
    row.appendChild(bar);
  }

  if (msg.attachments && msg.attachments.length) {
    const files = el('div', { class: 'msg-files' });
    for (const att of msg.attachments) {
      const isImg = /^image\//.test(String(att.mime || ''));
      if (isImg) {
        // Image bytes live behind the Bearer-authenticated
        // can never satisfy (no Authorization header -> 401 -> broken
        // image). Load the bytes with the real session and swap in a
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
          const link = el('a', { class: 'msg-file image', href: url, title: att.filename || 'Open image' });
          const img = el('img', { src: url, alt: att.filename || 'attached image', loading: 'lazy' });
          img.addEventListener('load', () => { setTimeout(() => URL.revokeObjectURL(url), 30000); });
          img.addEventListener('error', () => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } holder.replaceWith(fallbackRow()); });
          // Middle-click and "open in new tab" still have to work, so this stays
          // an anchor; a plain left click opens the lightbox instead of throwing
          // the reader out of the conversation to a raw image URL.
          link.addEventListener('click', (e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            openLightbox({ url, alt: att.filename || 'attached image', name: att.filename || '' });
          });
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

  // Always created, even with no cards: the socket delivers previews after the
  // message itself, and the tray is where they land. A tray created only when
  // there are cards would mean the arriving card had nowhere to go.
  const tray = embedTray(msg.id);
  paintEmbeds(tray, msg.embeds);
  wireEmbedImages(tray);
  body.appendChild(tray);

  const reactBar = el('div', { class: 'msg-reactions' });
  paintReactions(reactBar, msg.reactions, opts.onReact);
  body.appendChild(reactBar);

  // Built here rather than by each caller so the badge reads the same in a
  // channel and in a direct message.
  if (typeof opts.onOpenThread === 'function' && msg.reply_count > 0) {
    body.appendChild(replyBadge(msg.reply_count, opts.onOpenThread));
  }

  row.appendChild(body);
  return row;
}

export function paintReactions(bar, list, onReact) {
  clear(bar);
  for (const r of list || []) {
    if (!r || !r.emoji) continue;
    const pill = el('button', {
      type: 'button',
      class: 'react-pill' + (r.mine ? ' mine' : ''),
      title: (r.count || 1) + ' reaction' + ((r.count || 1) === 1 ? '' : 's'),
      'aria-pressed': r.mine ? 'true' : 'false',
      onClick: onReact ? () => onReact(r.emoji, !!r.mine) : null,
      disabled: onReact ? false : true,
    }, r.emoji + ' ' + (r.count || 1));
    bar.appendChild(pill);
  }
  bar.hidden = !(list && list.length);
}

export default { avatar, navRow, serverChip, emptyState, messageRow, paintReactions, initialOf, hashColor };

// A status as a badge. Slugified so a status can style itself without every caller
// knowing the class name - OPEN and UNDER_REVIEW are both rendered here.
export function statusChip(status, text) {
  const cls = String(status).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return el('span', { class: 'status-chip ' + cls }, text || String(status).replace(/_/g, ' '));
}

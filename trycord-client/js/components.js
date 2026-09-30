// never from mock data.

import { esc, el, clear, relTime, apiSrc, qs } from './ui.js';
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

export function serverChip(server, { active = false, onClick } = {}) {
  const chip = el('button', {
    class: 'server-chip' + (active ? ' active' : ''),
    type: 'button',
    title: server.name || 'Community',
    'aria-label': server.name || 'Community',
    'aria-current': active ? 'page' : null,
    onClick,
    dataset: { serverId: server.id },
  });
  // discover but never here. communityMark already resolves icon_url through
  // the authenticated loader, so use it rather than a second implementation.
  chip.appendChild(communityMark(server.name || '?', { size: 'community-mark--chip', server }));
  chip.appendChild(el('span', { class: 'chip-name' }, server.name));
  if (server.is_owner) chip.appendChild(el('span', { class: 'chip-live', title: 'You own this community' }, icon('star')));
  return chip;
}

export function channelRow(channel, { active = false, muted = false, onClick } = {}) {
  const row = el('button', {
    class: 'row row--channel' + (active ? ' active' : '') + (muted ? ' muted' : ''),
    type: 'button',
    title: muted ? '#' + (channel.name || 'channel') + ' (muted)' : '#' + (channel.name || 'channel'),
    onClick,
    dataset: { channelId: channel.id },
  });
  row.appendChild(el('span', { class: 'ch-prefix' }, '#'));
  row.appendChild(el('span', { class: 'ch-name' }, channel.name));
  return row;
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
const ICON_PATHS = {
  home: 'M3 10.6 12 3.5l9 7.1V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
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
  // className on an SVGElement is read-only in WebKit, and el() assigns
  // className directly. setAttribute is the only safe route.
  else svg.setAttribute('class', 'ui-icon');
  for (const seg of (d || ICON_PATHS.inbox).split(' M').map((p, i) => (i ? 'M' + p : p))) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', seg);
    svg.appendChild(path);
  }
  return svg;
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

export { ICON_PATHS };


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
    const react = el('button', { type: 'button', title: 'Add reaction', 'aria-label': 'Add reaction' }, icon('users'));
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

  const reactBar = el('div', { class: 'msg-reactions' });
  paintReactions(reactBar, msg.reactions, opts.onReact);
  body.appendChild(reactBar);

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

export default { avatar, navRow, serverChip, channelRow, emptyState, messageRow, paintReactions, initialOf, hashColor };

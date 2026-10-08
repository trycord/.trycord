// Shared pieces: the message row, the empty state, and the chips.
//
//   components/media.js   the authenticated-image cache, and everything that draws an
//                         identity - avatars, community marks, banners
//   components/nav.js     the three navigation row shapes
//
// messageRow stays here on purpose. It is the message surface, and it is large enough
// that moving it would only be worth doing while being able to look at it.

import { esc, el, clear, relTime, apiSrc, openLightbox, icon, ICON_PATHS } from './ui.js';
import { embedTray, paintEmbeds, wireEmbedImages } from './embeds.js';
import { peerPresence, can } from './state.js';
import Api from './api.js';
import {
  hashColor, initialOf, avatarUrlOf, bannerUrlOf, loadAuthedImage, invalidateAuthedImage,
  avatar, communityIconUrl, communityBannerUrl, communityMark,
} from './components/media.js';
import { navGroup, navRow, serverChip } from './components/nav.js';

// Imported, then exported again, rather than exported directly. `export { x } from
// './y.js'` re-exports without creating a local binding, so emptyState below - which
// calls icon() - would be reading a name that does not exist in this scope.
export { icon, ICON_PATHS };
export {
  hashColor, initialOf, avatarUrlOf, bannerUrlOf, loadAuthedImage, invalidateAuthedImage,
  avatar, communityIconUrl, communityBannerUrl, communityMark,
};
export { navGroup, navRow, serverChip };

















// `iconName` is a key of ICON_PATHS. A caller may still pass an element, which
// is appended as-is.
export function emptyState(iconName, title, sub) {
  const box = el('div', { class: 'empty-state' });
  if (iconName) {
    box.appendChild(typeof iconName === 'string'
      ? el('div', { class: 'es-icon' }, icon(iconName))
      : iconName);
  }
  if (title) box.appendChild(el('div', { style: { color: 'var(--color-text-secondary)', fontWeight: '600' } }, title));
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

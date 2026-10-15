// The shared visual vocabulary the CSS expects.
//
// A component here is a function that returns an element, never a class, so a
// view composes them the same way it composes el(). Identity colour is derived
// from the id, so the same person is the same colour everywhere without the
// server storing one.

import { el } from './dom.js';
import { icon } from './icons.js';
import { initials, hueOf } from './format.js';
import { mediaUrl, isServerPath } from './media.js';
import { State } from './store.js';

export function avatar(user, options) {
  const opts = options || {};
  const size = opts.size || 'md';
  const name = opts.name || (user && (user.nickname || user.displayName || user.username)) || '';
  const url = user && user.avatarUrl ? user.avatarUrl : null;
  const hue = hueOf((user && user.id) || name);

  const node = el('span', {
    class: 'avatar avatar--' + size + (opts.rounded ? ' avatar--rounded' : ''),
    title: opts.title || name || null,
    'aria-hidden': opts.decorative === false ? null : 'true',
    style: {
      background: 'linear-gradient(160deg, hsl(' + hue + ' 46% 34%), hsl(' + ((hue + 40) % 360) + ' 46% 24%))',
      color: '#fff',
    },
  }, initials(name));

  if (url && isServerPath(url)) {
    mediaUrl(url).then((resolved) => {
      if (!resolved) return;
      node.textContent = '';
      const img = el('img', { src: resolved, alt: '', loading: 'lazy' });
      node.appendChild(img);
      node.style.background = 'transparent';
    });
  } else if (url) {
    node.textContent = '';
    node.appendChild(el('img', { src: url, alt: '', loading: 'lazy' }));
    node.style.background = 'transparent';
  }

  if (opts.presence) {
    node.appendChild(el('span', {
      class: 'avatar-dot',
      dataset: { presence: opts.presence },
      style: { borderColor: 'var(--panel)' },
    }));
  }

  return node;
}

export function presenceDot(userId) {
  return el('span', {
    class: 'avatar-dot',
    dataset: { presence: State.presence.get(String(userId)) || 'offline' },
  });
}

// A community's face: its icon when it has one, its initials otherwise. Rounded,
// because a community is a place rather than a person.
export function serverMark(server, options) {
  const opts = options || {};
  const name = (server && server.name) || '?';
  const url = server && server.icon_url ? server.icon_url : null;
  const hue = hueOf((server && server.id) || name);

  const node = el('span', {
    class: 'avatar avatar--rounded avatar--' + (opts.size || 'md'),
    style: {
      background: 'linear-gradient(160deg, hsl(' + hue + ' 44% 32%), hsl(' + ((hue + 30) % 360) + ' 44% 22%))',
      color: '#fff',
      fontSize: '0.8rem',
    },
    title: name,
  }, initials(name));

  if (url && isServerPath(url)) {
    mediaUrl(url).then((resolved) => {
      if (!resolved) return;
      node.textContent = '';
      node.appendChild(el('img', { src: resolved, alt: '', loading: 'lazy' }));
      node.style.background = 'transparent';
    });
  } else if (url) {
    node.textContent = '';
    node.appendChild(el('img', { src: url, alt: '', loading: 'lazy' }));
    node.style.background = 'transparent';
  }
  return node;
}

// A banner is a background, not an element with an image inside it.
export function bannerNode(url, className) {
  const node = el('div', { class: className ? className : 'banner' });
  if (url) {
    mediaUrl(url).then((resolved) => {
      if (resolved) node.style.backgroundImage = 'url(' + resolved + ')';
    });
  }
  return node;
}

export function channelIcon(channel, size) {
  const type = channel && channel.type;
  if (type === 'voice' || type === 'stage') return icon('volume', { size: size || 17 });
  if (type === 'announcement') return icon('bell', { size: size || 17 });
  if (type === 'forum') return icon('list', { size: size || 17 });
  return icon('hash', { size: size || 17 });
}

export function channelName(channel) {
  return (channel && (channel.name || channel.slug)) || 'channel';
}

export function field(label, control, hint) {
  return el('label', { class: 'field' },
    el('span', { class: 'field-label' }, label),
    control,
    hint ? el('span', { class: 'field-hint' }, hint) : null,
  );
}

export function listRow(options) {
  const opts = options || {};
  return el(opts.href ? 'a' : 'button', {
    class: 'list-row' + (opts.active ? ' list-row--active' : ''),
    href: opts.href || null,
    type: opts.href ? null : 'button',
    onClick: opts.onClick || null,
    'aria-current': opts.current ? 'page' : null,
  },
    opts.leading || null,
    el('span', { class: 'list-row-main' },
      el('span', { class: 'list-row-title truncate' }, opts.title),
      opts.sub ? el('span', { class: 'list-row-sub truncate' }, opts.sub) : null),
    opts.trailing || null,
  );
}

export function iconButton(name, options) {
  const opts = options || {};
  return el('button', {
    class: 'icon-btn' + (opts.class ? ' ' + opts.class : ''),
    type: 'button',
    title: opts.label || null,
    'aria-label': opts.label || name,
    'aria-pressed': opts.pressed === undefined ? null : String(!!opts.pressed),
    onClick: opts.onClick,
  }, icon(name, { size: opts.size || 18 }));
}

export function badge(text, kind) {
  return el('span', { class: 'badge' + (kind ? ' badge--' + kind : '') }, text);
}

export function countBadge(count) {
  if (!count) return null;
  return el('span', { class: 'count-badge' }, count > 99 ? '99+' : String(count));
}

export function switchControl(checked, onChange, label) {
  return el('button', {
    class: 'switch', type: 'button', role: 'switch',
    'aria-checked': String(!!checked),
    'aria-label': label || undefined,
    onClick: () => onChange(!checked),
  });
}

export function fieldRow(label, description, control) {
  return el('div', { class: 'settings-field' },
    el('div', {},
      el('div', { class: 'settings-field-label' }, label),
      description ? el('div', { class: 'settings-field-desc' }, description) : null),
    el('div', { class: 'settings-field-ctl' }, control),
  );
}

export function pageHeader(title, subtitle, actions) {
  return el('div', { class: 'page-head' },
    el('div', {},
      el('h1', { class: 'page-title' }, title),
      subtitle ? el('div', { class: 'page-sub' }, subtitle) : null),
    actions ? el('div', { class: 'page-actions' }, actions) : null,
  );
}

export function spinner() {
  return el('span', { class: 'spinner', role: 'status', 'aria-label': 'Loading' });
}

export function escapeText(value) {
  return String(value === undefined || value === null ? '' : value);
}

export default {
  avatar, presenceDot, serverMark, iconButton, badge, countBadge,
  switchControl, fieldRow, pageHeader, spinner,
};

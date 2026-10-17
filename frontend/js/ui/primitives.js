// The shared visual vocabulary.
//
// A primitive here is a function that returns an element, never a class, so a
// view composes them the way it composes el(). Identity colour is derived from
// the id, so the same person is the same colour everywhere without the server
// storing one.
//
// Everything in this module renders from semantic tokens only - no component
// names a hex, a shadow recipe or a pixel width the token layer has not agreed
// to first.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { initials, hueOf } from '../../packages/format.js';
import { mediaUrl, isServerPath } from '../../packages/media.js';

function identityGradient(hue) {
  const second = (hue + 38) % 360;
  return 'linear-gradient(155deg, hsl(' + hue + ' 30% 32%), hsl(' + second + ' 32% 22%))';
}

// Paint an image into a node once the media URL resolves; a path the server
// stores resolves through the media pack, a plain URL is used as given.
function paintImage(node, url) {
  if (!url) return;
  const apply = (src) => {
    node.textContent = '';
    node.appendChild(el('img', { src, alt: '', loading: 'lazy' }));
    node.style.background = 'transparent';
  };
  if (isServerPath(url)) mediaUrl(url).then((resolved) => { if (resolved) apply(resolved); });
  else apply(url);
}

export function avatar(user, options) {
  const opts = options || {};
  const name = opts.name || (user && (user.nickname || user.displayName || user.username)) || '';
  const hue = hueOf((user && user.id) || name);

  const node = el('span', {
    class: 'avatar avatar--' + (opts.size || 'md') + (opts.rounded ? ' avatar--rounded' : ''),
    title: opts.decorative === false ? null : (opts.title || name || null),
    'aria-hidden': opts.decorative === false ? null : 'true',
    role: opts.decorative === false ? 'img' : null,
    'aria-label': opts.decorative === false ? (opts.title || name || 'Avatar') : null,
    style: { background: identityGradient(hue) },
  }, initials(name));

  paintImage(node, user && user.avatarUrl ? user.avatarUrl : null);

  if (opts.presence) {
    node.appendChild(el('span', {
      class: 'avatar-dot',
      dataset: { presence: opts.presence },
    }));
  }

  return node;
}

// A community's face: its icon when it has one, its initials otherwise. Rounded,
// because a community is a place rather than a person.
export function serverMark(server, options) {
  const opts = options || {};
  const name = (server && server.name) || '?';
  const hue = hueOf((server && server.id) || name);

  const node = el('span', {
    class: 'avatar avatar--rounded avatar--' + (opts.size || 'md'),
    style: { background: identityGradient(hue) },
    title: name,
  }, initials(name));

  paintImage(node, server && server.icon_url ? server.icon_url : null);
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

export function iconButton(name, options) {
  const opts = options || {};
  return el('button', {
    class: 'icon-btn' + (opts.class ? ' ' + opts.class : ''),
    type: 'button',
    title: opts.label || null,
    'aria-label': opts.label || name,
    'aria-pressed': opts.pressed === undefined ? null : String(!!opts.pressed),
    'aria-haspopup': opts.haspopup || null,
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

// The label / description / control row every settings surface arranges itself
// with, so a switch sits identically on the account screen and in a community.
export function fieldRow(label, description, control) {
  return el('div', { class: 'settings-field' },
    el('div', { class: 'settings-field-text' },
      el('div', { class: 'settings-field-label' }, label),
      description ? el('div', { class: 'settings-field-desc' }, description) : null),
    el('div', { class: 'settings-field-ctl' }, control),
  );
}

export function spinner() {
  return el('span', { class: 'spinner', role: 'status', 'aria-label': 'Loading' });
}

export default {
  avatar, serverMark, bannerNode, channelIcon, channelName,
  iconButton, badge, countBadge, switchControl, fieldRow, spinner,
};

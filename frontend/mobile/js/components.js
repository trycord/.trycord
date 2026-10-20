// Small mobile furniture.
//
// Every mobile screen is a bar, a list and a set of sheets, so the pieces are
// defined once here. They import the platform only: nothing in this file reaches
// into another module's presentation.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { brandMark } from '../../packages/brand.js';
import { path } from '../../packages/nav.js';
import { mediaUrl } from '../../packages/media.js';
import { initials, hueOf } from '../../packages/format.js';
import { avatarUrlOf, serverIconOf } from '../../packages/identity.js';
import { presenceOf } from '../../packages/store.js';

// A round button carrying one icon. The label is required and becomes the
// accessible name; a phone has no hover, so the glyph alone is never enough.
export function iconButton(name, label, onClick, options) {
  const opts = options || {};
  return el('button', {
    class: 'm-iconbtn' + (opts.class ? ' ' + opts.class : ''),
    type: 'button',
    'aria-label': label,
    title: label,
    onClick: onClick || null,
  }, icon(name, { size: opts.size || 22 }));
}

export function brandLink() {
  // Where the monogram lives is packages/brand.js's business: the two entries sit
  // at different depths of the one tree, so the way up to the shared asset
  // library is derived there from its own file rather than guessed per entry.
  // What is drawn around it stays here, because this is a Mobile control.
  return el('a', { class: 'm-brandmark', href: path('/home'), 'aria-label': 'Trycord home' },
    brandMark({ size: 28 }));
}

// An identity face. The image is fetched with the session and shown from an object
// URL, because the media route is Bearer-authenticated and an <img src> to it would
// 401. Falls back to initials on a stable hue so the same person keeps the same
// colour everywhere.
export function avatar(user, options) {
  const opts = options || {};
  const name = (user && (user.nickname || user.displayName || user.username)) || '?';
  const node = el('span', {
    class: 'm-avatar' + (opts.size ? ' m-avatar--' + opts.size : ''),
    style: { background: 'hsl(' + hueOf(user && user.id || name) + ' 32% 26%)' },
    'aria-hidden': opts.decorative ? 'true' : null,
  }, initials(name));

  const url = avatarUrlOf(user);
  if (url) mediaUrl(url).then((src) => { if (src) paintFace(node, src); });

  if (opts.presence && user && user.id) {
    const wrap = el('span', { class: 'm-avatar-wrap' }, node);
    wrap.appendChild(el('span', { class: 'm-presence', dataset: { presence: presenceOf(user.id) } }));
    return wrap;
  }
  return node;
}

function paintFace(node, src) {
  if (!node.isConnected && node.parentNode === null) return;
  node.textContent = '';
  node.appendChild(el('img', { src, alt: '' }));
}

// A community mark: its image if it has one, its initials otherwise.
export function serverMark(server, options) {
  const opts = options || {};
  const name = (server && server.name) || '?';
  const node = el('span', {
    class: 'm-mark' + (opts.size ? ' m-mark--' + opts.size : ''),
    style: { background: 'hsl(' + hueOf(server && server.id || name) + ' 34% 24%)' },
    'aria-hidden': opts.decorative ? 'true' : null,
  }, initials(name));
  const url = serverIconOf(server);
  if (url) mediaUrl(url).then((src) => { if (src) { node.textContent = ''; node.appendChild(el('img', { src, alt: '' })); } });
  return node;
}

// One row of a list. An anchor when it navigates (so middle-click, copy-link and the
// keyboard all work), a button when it acts, a plain row when it does neither.
export function row(options) {
  const opts = options || {};
  const tag = opts.href ? 'a' : opts.onClick ? 'button' : 'div';
  const children = [
    opts.lead ? el('span', { class: 'm-row__lead' }, opts.lead) : null,
    el('span', { class: 'm-row__body' },
      el('span', { class: 'm-row__title truncate' }, opts.title),
      opts.sub ? el('span', { class: 'm-row__sub truncate' }, opts.sub) : null),
    opts.trailing || (opts.chevron ? el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 })) : null),
  ];
  return el(tag, {
    class: 'm-row' + (opts.active ? ' is-active' : '') + (opts.class ? ' ' + opts.class : ''),
    href: opts.href || null,
    type: tag === 'button' ? 'button' : null,
    onClick: opts.onClick || null,
    dataset: opts.dataset || null,
  }, children);
}

export function list(children) {
  return el('div', { class: 'm-list' }, children);
}

export function section(title, children, options) {
  const opts = options || {};
  return el('section', { class: 'm-section' },
    (title || opts.note) ? el('div', { class: 'm-section__head' },
      title ? el('h2', { class: 'm-section__title' }, title) : el('span', {}),
      opts.note ? el('span', { class: 'm-section__note' }, opts.note) : null) : null,
    children);
}

export function badge(count) {
  if (!count) return null;
  return el('span', { class: 'm-badge' }, count > 99 ? '99+' : String(count));
}

// The three non-content states, each named so a screen cannot invent a fourth look.
export function loading(label) {
  return el('div', { class: 'm-loading', 'aria-busy': 'true', role: 'status' },
    el('span', { class: 'm-spinner', 'aria-hidden': 'true' }), el('span', {}, label || 'Loading'));
}

export function empty(options) {
  const opts = options || {};
  return el('div', { class: 'm-state' },
    opts.icon ? el('span', { class: 'm-state__icon' }, icon(opts.icon, { size: 24 })) : null,
    el('div', { class: 'm-state__title' }, opts.title || 'Nothing here'),
    opts.text ? el('div', { class: 'm-state__text' }, opts.text) : null,
    opts.action || null);
}

export function failure(error, onRetry) {
  const message = error && error.message ? error.message : 'That did not load.';
  return el('div', { class: 'm-state', 'data-failed': 'true' },
    el('span', { class: 'm-state__icon' }, icon('alert', { size: 24 })),
    el('div', { class: 'm-state__title' }, 'That did not load'),
    el('div', { class: 'm-state__text' }, message),
    onRetry ? el('button', { class: 'm-btn m-btn--sm', type: 'button', onClick: onRetry }, 'Try again') : null);
}

export function chip(text) {
  return el('span', { class: 'm-chip' }, text);
}

export default { iconButton, brandLink, avatar, serverMark, row, list, section, badge, loading, empty, failure, chip };

// Small view furniture.
//
// Every non-conversation screen is a page with a heading and a stack of
// sections, so the shape is defined once here rather than re-derived - slightly
// differently - on each screen.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { spinner } from '../components.js';
import { relativeTime } from '../../packages/format.js';

export function page(children, options) {
  // Two call styles grew up side by side: page({ wide }, ...children) and
  // page(firstChild, moreChildrenOrOptions). The second argument is only an
  // options object when it looks like one; otherwise it is another child, so a
  // page that passes its body as the second argument does not silently lose it.
  let opts = {};
  let kids;
  if (isOptions(children)) {
    opts = children;
    kids = Array.prototype.slice.call(arguments, 1);
  } else {
    kids = Array.isArray(children) ? children.slice() : [children];
    if (options !== undefined && options !== null) {
      if (isOptions(options)) opts = options;
      else if (Array.isArray(options)) kids = kids.concat(options);
      else kids.push(options);
    }
  }
  const classes = ['page'];
  if (opts.wide) classes.push('page--wide');
  if (opts.narrow) classes.push('page--narrow');
  const node = el('div', { class: classes.join(' ') });
  for (const child of [].concat(kids)) if (child) node.appendChild(child);
  return node;
}

function isOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.nodeType) return false;
  return 'wide' in value || 'narrow' in value;
}

export function heading(title, subtitle, actions) {
  return el('div', { class: 'page-head' },
    el('div', {},
      el('h1', { class: 'page-title' }, title),
      subtitle ? el('div', { class: 'page-sub' }, subtitle) : null),
    actions ? el('div', { class: 'page-actions' }, actions) : null,
  );
}

export function section(title, body, subtitle) {
  return el('section', { class: 'page-section' },
    title ? el('h2', { class: 'section-title' }, title) : null,
    subtitle ? el('div', { class: 'section-sub' }, subtitle) : null,
    body,
  );
}

export function tile(options) {
  const opts = options || {};
  const tag = opts.onClick || opts.href ? (opts.href ? 'a' : 'button') : 'div';
  return el(tag, {
    class: 'tile',
    href: opts.href || null,
    type: tag === 'button' ? 'button' : null,
    onClick: opts.onClick || null,
  },
    el('div', { class: 'tile-head' },
      opts.media || (opts.icon ? el('span', { class: 'tile-icon' }, icon(opts.icon, { size: 20 })) : null),
      el('div', {},
        el('div', { class: 'tile-title' }, opts.title),
        opts.sub ? el('div', { class: 'tile-sub' }, opts.sub) : null)),
    opts.body ? el('div', { class: 'tile-body' }, opts.body) : null,
  );
}

export function stat(value, label) {
  return el('div', { class: 'stat' },
    el('div', { class: 'stat-value' }, value),
    el('div', { class: 'stat-sub' }, label),
  );
}

export function row(options) {
  const opts = options || {};
  return el('div', { class: 'row-item' },
    opts.leading || null,
    el('div', { class: 'row-item-main' },
      el('div', { class: 'row-item-title truncate' }, opts.title),
      opts.sub ? el('div', { class: 'row-item-sub truncate' }, opts.sub) : null),
    opts.actions ? el('div', { class: 'row-item-actions' }, opts.actions) : null,
  );
}

export function loading(label) {
  return el('div', { class: 'view-loading state-block state-block--loading', 'aria-busy': 'true' },
    spinner(), el('span', {}, label || 'Loading'));
}

export function failure(error, onRetry) {
  const message = error && error.message ? error.message : 'That did not load.';
  return el('div', { class: 'view-error state-block state-block--error', 'data-failed': 'true' },
    icon('alert', { size: 22 }),
    el('div', { class: 'view-error-text' }, message),
    onRetry ? el('button', { class: 'btn btn--default btn--sm', type: 'button', onClick: onRetry }, 'Try again') : null,
  );
}

export function empty(options) {
  const opts = options || {};
  return el('div', { class: 'view-empty' },
    opts.icon ? el('div', { class: 'view-empty-icon' }, icon(opts.icon, { size: 24 })) : null,
    el('div', { class: 'view-empty-title' }, opts.title),
    opts.text ? el('div', { class: 'view-empty-text' }, opts.text) : null,
    opts.action ? el('div', { class: 'view-empty-action' }, opts.action) : null,
  );
}

export function nothing(title, text, action) {
  return empty({ title, text, action });
}

export async function settle(host, work, onError) {
  host.replaceChildren(loading());
  try {
    const out = await work();
    return out;
  } catch (error) {
    host.replaceChildren(failure(error, onError));
    return null;
  }
}

export function relative(value) {
  return relativeTime(value);
}

/* -- the page system ---------------------------------------------------------
 *
 * Every in-app screen is a band, then panels. These five builders are the whole
 * vocabulary: a screen that composes them cannot drift from the queue of screens
 * beside it, which is the only way fifty pages read as one product.
 */

export function band(options) {
  const opts = options || {};
  return el('header', { class: 'band' + (opts.quiet ? ' band--quiet' : '') },
    el('div', { class: 'band-main' },
      opts.eyebrow ? el('div', { class: 'band-eyebrow' },
        opts.icon ? icon(opts.icon, { size: 13 }) : null,
        el('span', {}, opts.eyebrow),
        opts.meta ? el('span', { class: 'band-meta' }, opts.meta) : null) : null,
      opts.title ? el('h1', { class: 'band-title' }, opts.title) : null,
      opts.lede ? el('p', { class: 'band-lede' }, opts.lede) : null),
    opts.actions ? el('div', { class: 'band-actions' }, opts.actions) : null,
  );
}

export function panel(options) {
  const opts = options || {};
  const card = el('section', {
    class: 'panel' + (opts.plain ? ' panel--plain' : '') + (opts.dashed ? ' panel--dashed' : ''),
  });
  if (opts.title || opts.note || opts.actions) {
    card.appendChild(el('div', { class: 'panel-head' },
      opts.lead ? el('span', { class: 'prow-lead' }, opts.lead)
        : opts.icon ? el('span', { class: 'prow-lead' }, icon(opts.icon, { size: 16 })) : null,
      opts.title ? el('h2', { class: 'panel-title' }, opts.title) : null,
      opts.note ? el('span', { class: 'panel-note' }, opts.note) : null,
      opts.actions ? el('div', { class: 'panel-actions' }, opts.actions) : null,
    ));
  }
  if (opts.body) {
    card.appendChild(el('div', {
      class: 'panel-body' + (opts.tight ? ' panel-body--tight' : '') + (opts.flush ? ' panel-body--flush' : ''),
    }, opts.body));
  }
  for (const r of [].concat(opts.rows || [])) if (r) card.appendChild(r);
  if (opts.foot) {
    card.appendChild(el('div', { class: 'panel-foot' + (opts.footEnd ? ' panel-foot--end' : '') }, opts.foot));
  }
  return card;
}

export function prow(options) {
  const opts = options || {};
  const interactive = opts.href || opts.onClick;
  const tag = opts.href ? 'a' : opts.onClick ? 'button' : 'div';
  return el(tag, {
    class: 'prow' + (opts.top ? ' prow--top' : '') + (interactive ? ' prow--button' : '')
      + (opts.active ? ' prow--active' : '') + (opts.class ? ' ' + opts.class : ''),
    href: opts.href || null,
    type: tag === 'button' ? 'button' : null,
    onClick: opts.onClick || null,
  },
    opts.lead ? el('span', { class: 'prow-lead' }, opts.lead) : null,
    el('div', { class: 'prow-main' },
      opts.title ? el('div', { class: 'prow-title truncate' }, opts.title) : null,
      opts.sub ? el('div', { class: 'prow-sub' }, opts.sub) : null,
      opts.note || null),
    opts.control ? el('div', { class: 'prow-ctl' }, opts.control) : null,
    opts.actions ? el('div', { class: 'prow-actions' }, opts.actions) : null,
  );
}

export function notice(options) {
  const opts = options || {};
  const tone = opts.tone || 'neutral';
  const glyph = opts.icon
    || (tone === 'danger' || tone === 'warning' ? 'alert'
      : tone === 'success' ? 'check'
        : 'info');
  return el('div', { class: 'notice notice--' + tone, role: opts.role || (tone === 'info' ? 'status' : null) },
    el('span', { class: 'notice-icon' }, icon(glyph, { size: 18 })),
    el('div', { class: 'notice-main' },
      (opts.title || opts.meta) ? el('div', { class: 'notice-head' },
        opts.title ? el('div', { class: 'notice-title' }, opts.title) : null,
        opts.meta ? el('time', { class: 'notice-meta' }, opts.meta) : null) : null,
      opts.text ? el('div', { class: 'notice-text' }, opts.text) : null,
      opts.body || null,
      opts.actions ? el('div', { class: 'notice-actions' }, opts.actions) : null));
}

export function strip(items) {
  const node = el('div', { class: 'strip' });
  for (const item of items) {
    if (!item) continue;
    node.appendChild(el('div', { class: 'strip-item' },
      el('div', { class: 'strip-value' }, item.value),
      el('div', { class: 'strip-label' }, item.label)));
  }
  return node;
}

export function fact(label, value) {
  return el('div', { class: 'fact' },
    el('div', { class: 'fact-label' }, label),
    el('div', { class: 'fact-value' }, value));
}

export function stack(children, options) {
  const opts = options || {};
  return el('div', {
    class: 'stack' + (opts.tight ? ' stack--tight' : '') + (opts.airy ? ' stack--airy' : ''),
  }, children);
}

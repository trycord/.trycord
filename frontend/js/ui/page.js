// The working surface kit.
//
// Every in-app screen is built from this kit and only this kit: a header strip,
// cards that can hold rows or free bodies, a two-pane deck, memos for things
// worth standing out, and three honest states (working, faulted, empty).
// A screen composed from the kit cannot drift from the screens beside it, and
// the stylesheet has exactly one section per builder to keep honest.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { spinner } from './primitives.js';
import { relativeTime } from '../../packages/format.js';
import { attachContextMenu } from './overlays.js';

// -- head ---------------------------------------------------------------------
//
// The slim strip every screen opens with: kicker names the scope, title names
// the page, the lede says one useful sentence, actions sit right.

export function head(options) {
  const opts = options || {};
  return el('header', { class: 'pagehead' },
    el('div', { class: 'pagehead-main' },
      opts.kicker ? el('p', { class: 'pagehead-kicker' }, opts.kicker) : null,
      opts.title ? el('h1', { class: 'pagehead-title' }, opts.title) : null,
      opts.lede ? el('p', { class: 'pagehead-lede' }, opts.lede) : null),
    opts.actions ? el('div', { class: 'pagehead-actions' }, opts.actions) : null,
  );
}

// -- card ---------------------------------------------------------------------
//
// A bordered working area. `rows` are line items laid out by the card; `body`
// is free-form content; `foot` is a bottom strip, actions right by default.

export function card(options) {
  const opts = options || {};
  const node = el('section', {
    class: 'card' + (opts.flat ? ' card--flat' : '') + (opts.dashed ? ' card--dashed' : ''),
  });
  if (opts.label || opts.note || opts.actions) {
    node.appendChild(el('header', { class: 'cardhead' },
      opts.glyph ? el('span', { class: 'cardhead-glyph' }, icon(opts.glyph, { size: 15 })) : null,
      opts.lead ? el('span', { class: 'cardhead-glyph' }, opts.lead) : null,
      opts.label ? el('h2', { class: 'cardhead-label' }, opts.label) : null,
      opts.note ? el('span', { class: 'cardhead-note' }, opts.note) : null,
      opts.actions ? el('div', { class: 'cardhead-tools' }, opts.actions) : null));
  }
  if (opts.body) {
    node.appendChild(el('div', {
      class: 'cardbody' + (opts.tight ? ' cardbody--tight' : '') + (opts.flush ? ' cardbody--flush' : ''),
    }, opts.body));
  }
  for (const row of [].concat(opts.rows || [])) if (row) node.appendChild(row);
  if (opts.foot) {
    node.appendChild(el('div', { class: 'cardfoot' + (opts.footEnd ? ' cardfoot--end' : '') }, opts.foot));
  }
  return node;
}

// -- row ----------------------------------------------------------------------
//
// One line in a card: lead element, main title + optional second line, a side
// control and trailing meta. href or onClick makes the whole line the target.
//
// `menu` is a builder for the line's context menu: a right-click, or a long
// press on a phone, raises the actions that belong to this line. Every surface
// that can be acted on carries one, so the actions live with the thing they act
// on rather than in a menu somewhere else.

export function row(options) {
  const opts = options || {};
  const tag = opts.href ? 'a' : opts.onClick ? 'button' : 'div';
  const node = el(tag, {
    class: 'cardrow' + (opts.link ? ' cardrow--link' : '') + (opts.active ? ' cardrow--active' : '')
      + (opts.unread ? ' cardrow--unread' : '') + (opts.class ? ' ' + opts.class : ''),
    href: opts.href || null,
    type: tag === 'button' ? 'button' : null,
    onClick: opts.onClick || null,
  },
    opts.lead ? el('span', { class: 'cardrow-lead' }, opts.lead) : null,
    el('span', { class: 'cardrow-main' },
      opts.title ? el('span', { class: 'cardrow-title' }, opts.title) : null,
      opts.sub ? el('span', { class: 'cardrow-sub' }, opts.sub) : null),
    opts.side ? el('span', { class: 'cardrow-side' }, opts.side) : null,
    opts.meta ? el('span', { class: 'cardrow-meta' }, opts.meta) : null,
  );
  if (opts.menu) attachContextMenu(node, opts.menu);
  return node;
}

// -- memo ---------------------------------------------------------------------
//
// A statement that should stand out from rows: tone colours its rail, meta
// carries the stamp. Used for announcements, warnings, system facts.

export function memo(options) {
  const opts = options || {};
  const tone = opts.tone || 'info';
  const glyph = opts.glyph
    || (tone === 'danger' || tone === 'warning' ? 'alert' : tone === 'success' ? 'check' : 'info');
  return el('article', { class: 'memo memo--' + tone, role: opts.role || (tone === 'info' ? 'status' : null) },
    el('span', { class: 'memo-glyph' }, icon(glyph, { size: 16 })),
    el('div', { class: 'memo-main' },
      (opts.title || opts.stamp) ? el('div', { class: 'memo-top' },
        opts.title ? el('span', { class: 'memo-title' }, opts.title) : null,
        opts.stamp ? el('time', { class: 'memo-stamp' }, opts.stamp) : null) : null,
      opts.text ? el('p', { class: 'memo-text' }, opts.text) : null,
      opts.body || null,
      opts.actions ? el('div', { class: 'memo-actions' }, opts.actions) : null));
}

// -- facts --------------------------------------------------------------------
//
// A row of counted numbers: the value first, the label under it.

export function facts(items) {
  return el('div', { class: 'factline' },
    items.filter(Boolean).map((item) =>
      el('div', { class: 'factcell' },
        el('span', { class: 'factnum' }, item.value),
        el('span', { class: 'factlabel' }, item.label))));
}

// -- layout -------------------------------------------------------------------

export function fold(children, options) {
  const opts = options || {};
  return el('div', {
    class: 'fold' + (opts.tight ? ' fold--tight' : '') + (opts.airy ? ' fold--airy' : ''),
  }, children);
}

// Two working panes side by side, the first the wider. Collapses below 1100px.
export function deck(left, right) {
  return el('div', { class: 'deck' }, left, right);
}

// -- the three states ---------------------------------------------------------

export function hold(text) {
  return el('p', { class: 'holdline', 'aria-busy': 'true' }, spinner(), el('span', {}, text || 'Working'));
}

export function fault(error, onRetry) {
  const message = error && error.message ? error.message : 'That did not load.';
  return el('p', { class: 'faultline', 'data-failed': 'true' },
    icon('alert', { size: 20 }),
    el('span', { class: 'faultline-text' }, message),
    onRetry ? el('button', { class: 'btn btn--default btn--sm', type: 'button', onClick: onRetry }, 'Try again') : null,
  );
}

export function blank(options) {
  const opts = options || {};
  return el('div', { class: 'blank' },
    opts.glyph ? el('span', { class: 'blank-glyph' }, icon(opts.glyph, { size: 22 })) : null,
    el('p', { class: 'blank-title' }, opts.title),
    opts.text ? el('p', { class: 'blank-text' }, opts.text) : null,
    opts.action ? el('div', { class: 'blank-action' }, opts.action) : null);
}

// Fill a host with the working state, run the work, and turn a throw into the
// fault state wired to retry. Returns the work's answer, or null.
export async function settle(host, work, onRetry) {
  host.replaceChildren(hold());
  try {
    const out = await work();
    return out;
  } catch (error) {
    host.replaceChildren(fault(error, onRetry));
    return null;
  }
}

// A relative stamp, the only formatting the kit needs.
export function stamp(value) {
  return relativeTime(value);
}

export default {
  head, card, row, memo, facts, fold, deck, hold, fault, blank, settle, stamp,
};

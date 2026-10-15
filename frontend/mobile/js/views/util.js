// Small Mobile view furniture.
//
// Every phone screen is a bar, a scrolling column, and a stack of sections, so
// the pieces are defined once here rather than re-derived - slightly differently
// - on each screen. This is the mobile counterpart of the desktop view helper
// module and deliberately shares nothing with it: the two shapes are different
// on purpose, and one importing the other would flatten them back together.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { loading, failure } from '../components.js';
import { relativeTime } from '../../../packages/format.js';

// The scrolling body of a screen. Every renderer builds one and returns it.
export function screen(...children) {
  return el('div', { class: 'm-screen' }, ...children);
}

// Replace a host's contents with a spinner, run the work, and on failure show a
// retry. Returns whatever the work resolved to, or null after painting the error.
export async function settle(host, work, onError) {
  host.replaceChildren(loading());
  try {
    return await work();
  } catch (error) {
    host.replaceChildren(failure(error, onError));
    return null;
  }
}

export function heading(title, note) {
  return el('div', { class: 'm-heading' },
    el('h1', { class: 'm-heading__title' }, title),
    note ? el('div', { class: 'm-heading__note' }, note) : null);
}

export function stat(value, label) {
  return el('div', { class: 'm-stat' },
    el('div', { class: 'm-stat__value' }, value),
    el('div', { class: 'm-stat__label' }, label));
}

// A titled band of rows. Every list screen is one of these, so the heading and
// the note above it read the same from screen to screen.
export function section(title, body, options) {
  const opts = options || {};
  return el('section', { class: 'm-section' },
    el('div', { class: 'm-section__head' },
      el('div', { class: 'm-section__title' }, title),
      opts.note ? el('div', { class: 'm-section__note' }, opts.note) : null,
      opts.action || null),
    body);
}

export function actions(children) {
  return el('div', { class: 'm-actions' }, children);
}

// A labelled form control. The control is passed in so a text field, a select
// and a switch all read the same way down the page.
export function field(options) {
  const opts = options || {};
  return el('label', { class: 'm-field' },
    opts.label ? el('span', { class: 'm-field__label' }, opts.label) : null,
    opts.control || null,
    opts.note ? el('span', { class: 'm-field__note' }, opts.note) : null);
}

export function textInput(options) {
  const opts = options || {};
  return el('input', {
    class: 'm-input',
    type: opts.type || 'text',
    name: opts.name || null,
    value: opts.value === undefined || opts.value === null ? null : String(opts.value),
    placeholder: opts.placeholder || null,
    autocomplete: opts.autocomplete || null,
    inputmode: opts.inputmode || null,
    required: opts.required || null,
    disabled: opts.disabled || null,
    maxlength: opts.maxlength || null,
  });
}

export function textArea(options) {
  const opts = options || {};
  return el('textarea', {
    class: 'm-input m-input--area',
    name: opts.name || null,
    rows: opts.rows || 3,
    placeholder: opts.placeholder || null,
    maxlength: opts.maxlength || null,
  }, opts.value || '');
}

export function select(options) {
  const opts = options || {};
  const node = el('select', { class: 'm-input m-input--select', name: opts.name || null, disabled: opts.disabled || null });
  for (const choice of opts.choices || []) {
    node.appendChild(el('option', { value: choice.value, selected: String(choice.value) === String(opts.value) ? true : null }, choice.label));
  }
  return node;
}

export function notice(options) {
  const opts = options || {};
  const tone = opts.tone || 'neutral';
  const glyph = opts.icon
    || (tone === 'danger' || tone === 'warning' ? 'alert'
      : tone === 'success' ? 'check' : 'info');
  return el('div', { class: 'm-notice m-notice--' + tone, role: opts.role || (tone === 'info' ? 'status' : null) },
    el('span', { class: 'm-notice__icon' }, icon(glyph, { size: 18 })),
    el('div', { class: 'm-notice__main' },
      (opts.title || opts.meta) ? el('div', { class: 'm-notice__head' },
        opts.title ? el('div', { class: 'm-notice__title' }, opts.title) : null,
        opts.meta ? el('time', { class: 'm-notice__meta' }, opts.meta) : null) : null,
      opts.text ? el('div', { class: 'm-notice__text' }, opts.text) : null,
      opts.body || null,
      opts.actions ? el('div', { class: 'm-notice__actions' }, opts.actions) : null));
}

export function relative(value) {
  return relativeTime(value);
}

export function primaryButton(label, onClick, options) {
  const opts = options || {};
  return el('button', {
    class: 'm-btn m-btn--primary' + (opts.block ? ' m-btn--block' : '') + (opts.sm ? ' m-btn--sm' : ''),
    type: opts.type || 'button', disabled: opts.disabled || null, onClick: onClick || null,
  }, label);
}

export function ghostButton(label, onClick, options) {
  const opts = options || {};
  return el('button', {
    class: 'm-btn m-btn--ghost' + (opts.class ? ' ' + opts.class : ''),
    type: opts.type || 'button', disabled: opts.disabled || null,
    onClick: onClick || null,
  }, label);
}

export function relativeOrDash(value) {
  return value ? relativeTime(value) : '\u2014';
}

export default {
  screen, settle, heading, stat, section, actions, field, textInput, textArea, select,
  notice, relative, relativeTime,
};

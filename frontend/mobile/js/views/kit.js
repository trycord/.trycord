// The pieces the phone's consoles are drawn with.
//
// The instance console was drawn first, and its pieces proved out: a row that
// opens a screen, a card that names a group of them, a fact line, and the
// sheet that asks for words before an action records them. The other consoles
// the phone carries - the account studio, the community's settings, the
// developer portal, the finder - are drawn from the same pieces, so a reader
// meets one grammar everywhere.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import { sheet, closeSheet, confirm, toast, failed, hold, failure, field, emptyState } from '../ui.js';

export { el, clear, icon, Api, sheet, closeSheet, confirm, toast, failed, hold, failure, field, emptyState };

// A payload that may be a bare list, a page object, or nothing.
export function items(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  return [];
}

export function when(stamp) {
  if (!stamp) return '';
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const STATUS_WORDS = {
  OPEN: 'Open',
  INVESTIGATING: 'Being investigated',
  RESOLVED: 'Resolved',
  DISMISSED: 'Dismissed',
  UNDER_REVIEW: 'Under review',
  APPROVED: 'Approved',
  DENIED: 'Denied',
  PENDING: 'Waiting',
  SUSPENDED: 'Suspended',
  BANNED: 'Banned',
};

export function statusWord(status) {
  return STATUS_WORDS[String(status || '').toUpperCase()] || String(status || '—').replace(/_/g, ' ');
}

export function row(entry) {
  const node = el(entry.onClick ? 'button' : 'div', {
    class: 'm-row' + (entry.danger ? ' m-row--danger' : ''),
    type: entry.onClick ? 'button' : null,
    onClick: entry.onClick || null,
  });
  if (entry.lead) node.appendChild(entry.lead);
  node.appendChild(el('div', { class: 'm-row__body' },
    el('div', { class: 'm-row__name truncate' }, entry.title || ''),
    entry.sub ? el('div', { class: 'm-row__note truncate' }, entry.sub) : null));
  if (entry.side) node.appendChild(el('div', { class: 'm-row__meta' }, entry.side));
  if (entry.chevron && entry.onClick) node.appendChild(el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 16 })));
  return node;
}

export function cardOf(kicker, children) {
  const card = el('div', { class: 'm-card' });
  if (kicker) card.appendChild(el('div', { class: 'm-kicker' }, kicker));
  for (const child of children) if (child) card.appendChild(child);
  return card;
}

export function fact(label, value) {
  return el('div', { class: 'm-row' },
    el('div', { class: 'm-row__body' }, el('div', { class: 'm-row__name' }, label)),
    el('div', { class: 'm-row__meta' }, el('div', { class: 'm-row__note' }, value == null ? '—' : String(value))));
}

// A sheet that asks for words before an action that records them.
export function wordsSheet(options, run) {
  const words = el('textarea', {
    class: 'm-area', rows: '4', maxlength: options.maxlength || 2000,
    placeholder: options.placeholder || 'What happened, and what you did about it',
    'aria-label': options.fieldLabel || 'Reason',
  });
  const go = el('button', { class: 'm-go m-go--block' + (options.danger ? ' m-go--danger' : ''), type: 'button' }, options.confirmLabel || 'Save');
  go.addEventListener('click', async () => {
    const reason = words.value.trim();
    if (options.required !== false && !reason) {
      toast('Write something first — it is saved with the action.', { type: 'danger' });
      return;
    }
    go.disabled = true;
    try {
      await run(reason);
      closeSheet();
    } catch (error) {
      failed(error);
      go.disabled = false;
    }
  });
  const layer = sheet({ title: options.title || 'A reason', note: options.note || null });
  layer.body.appendChild(field(options.fieldLabel || 'Reason', words));
  layer.body.appendChild(go);
  return layer;
}

// A sheet built from named controls, with one action to commit them.
export function formSheet(options, controls, run) {
  const layer = sheet({ title: options.title || 'A form', note: options.note || null });
  for (const [label, control] of controls) layer.body.appendChild(field(label, control));
  const go = el('button', { class: 'm-go m-go--block' + (options.danger ? ' m-go--danger' : ''), type: 'button' }, options.confirmLabel || 'Save');
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      await run();
      closeSheet();
    } catch (error) {
      failed(error);
      go.disabled = false;
    }
  });
  layer.body.appendChild(go);
  return layer;
}

// A yes/no question over an action, then the words the decision carries.
export async function decide(title, text, run, options) {
  const opts = options || {};
  if (!(await confirm({ title, text, confirmLabel: opts.confirmLabel || title, danger: !!opts.danger }))) return false;
  await new Promise((done) => {
    wordsSheet({
      title: opts.reasonTitle || 'The reason',
      confirmLabel: opts.confirmLabel || title,
      danger: !!opts.danger,
      placeholder: opts.placeholder || 'Why, in the words a reviewer reads',
    }, done);
  });
  return true;
}

// The operator gate the instance console already proved: the server answers,
// and the phone believes the server.
let operator = null;
export async function isOperator() {
  if (operator !== null) return operator;
  try {
    await Api.adminMe();
    operator = true;
  } catch {
    operator = false;
  }
  return operator;
}

export function refusal() {
  return emptyState('shield', 'Not your console',
    'This instance does not answer to you. The pages exist for its operators.');
}

// The standard screen a console page returns: a stack the section fills on
// mount, with the fault box if the fill fails and a retry that works.
export function consoleScreen(pageId, sections) {
  const host = el('div', { class: 'm-stack' });
  const draw = sections[pageId] || sections[''];
  return {
    node: host,
    onMount: async () => {
      try {
        await draw(host);
      } catch (error) {
        host.replaceChildren(failure(error, () => {
          host.replaceChildren();
          return draw(host);
        }));
      }
    },
  };
}

export function describeValue(value) {
  if (value === true) return 'on';
  if (value === false) return 'off';
  if (value == null || value === '') return '—';
  return String(value);
}

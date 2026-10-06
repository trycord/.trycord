// Shared settings composition.
//
// Every surface used to grow its own markup: a heading here, a hand-rolled
// two-column label-and-control row there, and a danger block that looked like a
// different component on each page. They lined up visually by luck.
//
// These are the parts, so a new settings section is assembled rather than
// restyled. Everything here is a plain builder returning a node - no state, no
// framework - so a section can use one part, all of them, or none.
import { el } from './ui.js';
import { icon } from './components.js';

// A section header. The blurb is optional and is what tells you whether you are
// in the right place before reading the controls.
export function sectionHead(title, blurb, actions) {
  const head = el('div', { class: 'set-head' });
  const text = el('div', { class: 'set-head__text' });
  text.appendChild(el('h2', { class: 'set-head__title' }, title));
  if (blurb) text.appendChild(el('p', { class: 'set-head__blurb' }, blurb));
  head.appendChild(text);
  if (actions && actions.length) {
    const row = el('div', { class: 'set-head__actions' });
    for (const a of actions) row.appendChild(a);
    head.appendChild(row);
  }
  return head;
}

// The bordered container a group of rows lives in.
export function sectionCard(...children) {
  const card = el('div', { class: 'set-card' });
  for (const c of children.flat(Infinity)) if (c) card.appendChild(c);
  return card;
}

// Row ids are generated so a caller only has to supply one when it needs to point at
// this row from somewhere else.
let rowSeq = 0;

// One setting: a label with an optional hint on the left, a control on the
// right. Below 620px the control drops under the label, because a 130px-wide
// select beside a sentence is unusable on a phone.
export function settingRow({ label, hint, control, danger = false, id }) {
  const row = el('div', { class: 'set-row' + (danger ? ' is-danger' : '') });
  const text = el('div', { class: 'set-row__text' });

  // The visible text is the control's name, not decoration beside it.
  //
  // This row used to render the text as a div and then, when the caller passed an id,
  // put that same id on the first control inside it - which associates nothing, because
  // association needs a <label for>. So every toggle in Settings reached a screen reader
  // as an unlabelled checkbox: a list of switches with nothing saying what any of them
  // switches. The hint below carried the explanation and was not part of the name.
  const field = control
    ? (control.matches && control.matches('input, select, textarea')
        ? control
        : control.querySelector && control.querySelector('input, select, textarea'))
    : null;
  const fieldId = id || (field ? 'set-row-' + (++rowSeq) : null);

  const l = fieldId
    ? el('label', { class: 'set-row__label', for: fieldId }, label)
    : el('div', { class: 'set-row__label' }, label);
  if (id && !fieldId) l.id = id;
  text.appendChild(l);
  if (hint) text.appendChild(el('div', { class: 'set-row__hint' }, hint));
  row.appendChild(text);

  if (control) {
    const c = el('div', { class: 'set-row__control' });
    for (const n of [control].flat(Infinity)) if (n) c.appendChild(n);
    row.appendChild(c);
  }
  if (field && fieldId && !field.id) field.id = fieldId;
  return row;
}

export function toggleRow({ label, hint, checked, onChange, disabled, name }) {
  const input = el('input', { type: 'checkbox', class: 'switch__input', name: name || null });
  input.checked = !!checked;
  input.disabled = !!disabled;
  const sw = el('label', { class: 'switch' }, input, el('span', { class: 'switch__track' }, el('span', { class: 'switch__thumb' })));
  if (onChange) input.addEventListener('change', () => onChange(input.checked));
  return settingRow({ label, hint, control: sw });
}

export function selectRow({ label, hint, value, options, onChange, disabled }) {
  const sel = el('select', { class: 'input' });
  if (disabled) sel.disabled = true;
  for (const o of options) {
    const opt = el('option', { value: o.value }, o.label);
    if (String(o.value) === String(value)) opt.selected = true;
    sel.appendChild(opt);
  }
  if (onChange) sel.addEventListener('change', () => onChange(sel.value));
  return settingRow({ label, hint, control: sel });
}

export function textRow({ label, hint, value, placeholder, onSave, type = 'text', disabled, inputmode, maxlength, autocomplete }) {
  const input = el('input', {
    class: 'input', type, value: value == null ? '' : String(value),
    placeholder: placeholder || '', disabled: disabled || null,
    inputmode: inputmode || null, maxlength: maxlength || null,
    autocomplete: autocomplete || null,
  });
  if (!onSave) return settingRow({ label, hint, control: input });
  // Save on blur rather than on every keystroke: a profile field is submitted
  // once, not per character.
  const save = el('button', { class: 'btn primary sm', type: 'button' }, 'Save');
  const run = async () => {
    save.disabled = true;
    const prev = save.textContent;
    save.textContent = 'Saving…';
    try { await onSave(input.value); }
    finally { save.textContent = prev; save.disabled = false; }
  };
  save.addEventListener('click', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  return settingRow({ label, hint, control: [input, save] });
}

// Irreversible things live here, visually separated from everything above so a
// stray click next to "Save changes" cannot delete an account.
export function dangerZone(title, blurb, children) {
  const zone = el('section', { class: 'set-danger' });
  const head = el('div', { class: 'set-danger__head' });
  const text = el('div', {});
  text.appendChild(el('h3', { class: 'set-danger__title' }, title || 'Danger zone'));
  if (blurb) text.appendChild(el('p', { class: 'set-danger__blurb' }, blurb));
  head.appendChild(text);
  zone.appendChild(head);
  const body = el('div', { class: 'set-danger__body' });
  for (const c of [children].flat(Infinity)) if (c) body.appendChild(c);
  zone.appendChild(body);
  return zone;
}

export function dangerRow({ label, hint, control }) {
  return settingRow({ label, hint, control, danger: true });
}

// The state between "nothing to do" and "there is something to do". Shown when a
// section legitimately has nothing in it yet.
export function setEmpty(message, action) {
  const box = el('div', { class: 'set-empty' });
  box.appendChild(el('p', { class: 'muted' }, message));
  if (action) box.appendChild(action);
  return box;
}

// A note that follows the user as they read a section - how overrides stack,
// what a role actually grants. Kept distinct from a hint on a row, which
// describes that row only.
export function setNote(text, kind = 'info') {
  return el('p', { class: 'set-note set-note--' + kind }, text);
}

export function dangerButton(label, onClick, opts = {}) {
  const b = el('button', {
    class: 'btn ' + (opts.variant || 'danger') + ' ' + (opts.size || 'sm'),
    type: 'button',
  }, label);
  if (opts.title) b.title = opts.title;
  b.addEventListener('click', onClick);
  return b;
}

export function setActionRow(...children) {
  const row = el('div', { class: 'set-actions' });
  for (const c of children.flat(Infinity)) if (c) row.appendChild(c);
  return row;
}

export { icon };
export default {
  sectionHead, sectionCard, settingRow, toggleRow, selectRow, textRow,
  dangerZone, dangerRow, setEmpty, setNote, dangerButton, setActionRow,
};
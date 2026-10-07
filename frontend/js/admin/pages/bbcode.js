import { el } from '../../ui.js';

// A toolbar bound to one input, so a click can act on that field's selection.
// Returned as a node rather than inserted inline at every call site, because the
// point is that every text field gets one and a missed field is a formatting
// feature that silently does not exist there.
export function bbcodeBar(input, onChange) {
  const bar = el('div', { class: 'bbcode-bar', role: 'toolbar', 'aria-label': 'Formatting' });
  for (const spec of BBCODE_TOOLS) {
    bar.appendChild(el('button', {
      class: 'bbcode-bar__btn', type: 'button', title: spec.title, 'aria-label': spec.title,
      onClick: (e) => {
        e.preventDefault();
        applyBBCode(input, spec);
        onChange();
      },
    }, spec.label));
  }
  return bar;
}

// A text field plus its toolbar. Every editable string in a block goes through
// this, so formatting behaves the same everywhere and cannot be added to some
// fields and forgotten on others.
export function bbcodeField(label, input, onChange, hint) {
  return el('div', { class: 'field' },
    el('label', {}, label),
    input,
    hint ? el('span', { class: 'hint' }, hint) : null,
    bbcodeBar(input, onChange));
}

// The BBCode an operator can insert, and what each one is for. Shown in the
// editor rather than only documented, because the alternative is an operator
// discovering the syntax by reading the raw brackets off someone else's page.
export const BBCODE_TOOLS = [
  { tag: 'b', label: 'B', title: 'Bold' },
  { tag: 'i', label: 'I', title: 'Italic' },
  { tag: 'u', label: 'U', title: 'Underline' },
  { tag: 's', label: 'S', title: 'Strikethrough' },
  { tag: 'url', label: 'Link', title: 'Link', arg: 'https://', body: 'link text' },
  { tag: 'quote', label: 'Quote', title: 'Quotation' },
  { tag: 'code', label: 'Code', title: 'Preformatted, contents shown literally' },
  { tag: 'spoiler', label: 'Spoiler', title: 'Hidden until focused' },
  { tag: 'color', label: 'Colour', title: 'Named colour or #hex', arg: 'red' },
  { tag: 'size', label: 'Size', title: '1 (small) to 7 (large)', arg: '5' },
  { tag: 'center', label: 'Centre', title: 'Centred' },
];

// Wraps the current selection, or inserts an empty pair and places the caret
// between the tags. Operates on the textarea the block is built from, which is
// why the block editor passes the input in rather than the block: the caret and
// selection only exist on the element.
export function applyBBCode(input, spec) {
  const start = input.selectionStart == null ? input.value.length : input.selectionStart;
  const end = input.selectionEnd == null ? start : input.selectionEnd;
  const sel = input.value.slice(start, end);
  const open = spec.arg ? '[' + spec.tag + '=' + spec.arg + ']' : '[' + spec.tag + ']';
  const close = '[/' + spec.tag + ']';
  const body = sel || spec.body || '';
  const next = input.value.slice(0, start) + open + body + close + input.value.slice(end);
  input.value = next;
  // Put the caret on the text the operator is meant to edit: inside the pair
  // when they had no selection, over their own text when they did.
  const caret = sel ? start + open.length + sel.length : start + open.length;
  input.focus();
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

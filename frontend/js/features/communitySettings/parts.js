// The parts the studio's sections are built from.
//
// Two of them, and both are about saying things honestly rather than about
// looking like anything in particular:
//
//   - the reporter, which is where a section says what the server answered;
//   - the managed secret, which is how a credential that can never be read
//     again is shown.
//
// A secret is never shown twice. The server hands one out once - the
// plaintext of a webhook's secret, the token of a bot - and cannot recover
// it afterwards. So the interface shows it when it arrives, offers it for
// copying, and afterwards shows only the fact that there is one and the
// actions that change it.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { openDialog } from '../../ui/overlays.js';
import { copyText } from '../../ui/clipboard.js';
import { maskSecret } from '../../../packages/communitySettings.js';

// Where a section says what happened.
//
// Two lines rather than one: what worked is a note, what failed is an error,
// and only one of them is ever written at a time. Both are announced, so a
// reader who cannot see the section is still told.
export function reporter() {
  const note = el('p', { class: 'form-note', role: 'status' });
  const problem = el('p', { class: 'form-error', role: 'alert' });
  return {
    node: el('div', {}, note, problem),
    ok(message) { note.textContent = message; problem.textContent = ''; },
    fail(error) {
      problem.textContent = (error && error.message) ? error.message : 'That did not work.';
      note.textContent = '';
    },
    // What the server said, in the words it used.
    answered(message) { note.textContent = message; problem.textContent = ''; },
  };
}

// A credential that is managed rather than typed.
//
// `state` is 'set' when the server holds one and 'unset' when it does not.
// The value is never typed into this field: it is replaced by the server, or
// not at all. The actions are the ones the server offers - a replacement and
// a clearing - and each of them says what it does before it does it.
export function managedSecret(options) {
  const opts = options || {};
  const isSet = opts.state === 'set';
  const value = el('code', { class: 'mono' }, isSet ? maskSecret() : 'not set');
  const note = el('p', { class: 'settings-note' }, opts.note || '');

  const actions = el('span', { class: 'rowtools' });
  if (opts.onReplace) {
    actions.appendChild(el('button', {
      class: 'btn btn--ghost btn--sm', type: 'button',
      'aria-label': (opts.replaceLabel || 'Replace') + (opts.label ? ' the ' + opts.label : ''),
      onClick: opts.onReplace,
    }, icon('refresh', { size: 14 }), opts.replaceLabel || 'Replace'));
  }
  if (opts.onClear) {
    actions.appendChild(el('button', {
      class: 'btn btn--danger btn--sm', type: 'button',
      'aria-label': (opts.clearLabel || 'Clear') + (opts.label ? ' the ' + opts.label : ''),
      onClick: opts.onClear,
    }, opts.clearLabel || 'Clear'));
  }

  return el('div', { class: 'settings-item' },
    el('div', { class: 'settings-item-main' },
      el('p', { class: 'settings-item-label' }, opts.label || 'Secret'),
      note),
    el('div', { class: 'settings-item-control' }, value),
    actions);
}

// The one copy of a secret, shown once.
//
// It arrives with the answer that created or replaced it, and it is shown in
// a dialog with a way to copy it and a way to close it. Nothing keeps it:
// the console does not write it down, and the next time the section is drawn
// there is a mask where it was.
export function secretDialog(options) {
  const opts = options || {};
  const value = String(opts.value || '');
  const code = el('code', { class: 'mono' }, value);
  const copy = el('button', {
    class: 'btn btn--default btn--sm', type: 'button',
    onClick: () => copyText(value, 'Copied. The clipboard holds it, not this page.'),
  }, icon('copy', { size: 14 }), 'Copy');

  return openDialog({
    title: opts.title || 'Shown once',
    body: el('div', { class: 'fold' },
      el('p', { class: 'lede' },
        opts.text || 'This is shown once. Copy it now: the server cannot show it again.'),
      el('div', { class: 'keyblock' }, code),
      el('p', { class: 'form-note' },
        'Nothing keeps a copy of this. The client does not store it and the section will not show it again.'),
      el('div', { class: 'rowtools' }, copy)),
  });
}

export default { reporter, managedSecret, secretDialog };

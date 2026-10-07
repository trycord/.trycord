import { btn, openModal } from './overlay.js';

import { el, focusQuietly } from './dom.js';

// Dialogs that ask a question and expect an answer: a password, a confirmation.
// 
// Separate from the overlay module because a dismissed dialog is a different
// outcome from a sheet that is scrolled away.

// Asks for a password, which confirmDialog cannot: it is a yes/no question and this
// needs a typed answer. The two places that wanted one were calling window.prompt(),
// which is the only native dialog left in the client - an OS-styled prompt in the
// middle of an otherwise consistent UI, and one the desktop build may not show at
// all.
//
// Resolves null when cancelled, so a caller can tell that apart from an empty string.
// An empty password is a legitimate thing to send and the server decides.
export function passwordDialog({ title, message, confirmText = 'Continue' }) {
  return new Promise((resolve) => {
    const input = el('input', {
      class: 'input', type: 'password',
      autocomplete: 'current-password', required: true,
    });
    const err = el('div', { class: 'form-error', hidden: true });
    const form = el('form', { class: 'auth-form' },
      el('div', { class: 'field' }, el('label', {}, 'Password'), input),
      err);
    const cancel = btn('Cancel', { variant: 'ghost' });
    const ok = el('button', { class: 'btn primary', type: 'button' }, confirmText);
    const modal = openModal({
      title,
      body: el('div', {}, message ? el('p', {}, message) : null, form),
      footer: [cancel, ok],
    });

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      modal.close();
      resolve(value);
    };

    cancel.addEventListener('click', () => finish(null));
    ok.addEventListener('click', () => {
      const value = input.value;
      if (!value) {
        err.hidden = false;
        err.textContent = 'Enter your password.';
        focusQuietly(input);
        return;
      }
      finish(value);
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); ok.click(); });

    // Close without resolving: the backdrop, Escape and the close button all land
    // here, and all of them mean the same thing.
    modal.onClose = () => finish(null);
    // No explicit focus: openModal already focuses the first field in the dialog on
    // a timer, and that is the password input here.
  });
}

export function confirmDialog({ title, message, confirmText = 'Confirm', danger = false, onConfirm }) {
  let doClose = () => {};
  const cancelBtn = btn('Cancel', { variant: 'ghost' });
  const okBtn = el('button', { class: danger ? 'btn danger' : 'btn primary', type: 'button' }, confirmText);
  const modal = openModal({
    title, body: el('p', {}, message),
    footer: [cancelBtn, okBtn],
  });
  doClose = modal.close;
  cancelBtn.addEventListener('click', doClose);
  okBtn.addEventListener('click', async () => {
    try { await onConfirm(); } finally { doClose(); }
  });
  return modal;
}

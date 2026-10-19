// Settings: security.
// Prove it is you, keep the door shut, know who is inside.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { head, card, row, blank, fault, fold } from '../ui/page.js';
import { errorToast, toast, openDialog, confirmDialog } from '../ui/overlays.js';

export function securityView() {
  const sessionsList = el('div', { class: 'rowlist' });
  const twofaStatus = el('p', { class: 'form-error', role: 'status' }, 'Reading the second factor…');
  const codesBody = el('div', { class: 'anticipation-line' });
  let recoveryCodes = null;

  // -- sessions ---------------------------------------------------------------

  const paintSessions = async () => {
    try {
      const rows = await Api.sessions();
      const items = Array.isArray(rows) ? rows : (rows && rows.items) || [];
      sessionsList.replaceChildren(...(items.length ? items.map((s) => row({
        lead: el('span', { class: 'role-dot' }, icon('monitor', { size: 15 })),
        title: s.userAgent || s.ua || 'A signed-in device',
        sub: s.createdAt ? new Date(s.createdAt).toLocaleString() : '',
        side: s.jti ? el('button', {
          class: 'btn btn--danger btn--sm', type: 'button',
          'aria-label': 'Revoke this session',
          onClick: async () => {
            try {
              await Api.revokeSession(s.jti);
              toast('That session is out');
              paintSessions();
            } catch (e) { errorToast(e); }
          },
        }, 'Revoke') : null,
      })) : [blank({
        glyph: 'monitor', title: 'This device only',
        text: 'Nothing else is signed in as you.',
      })]));
    } catch (e) {
      sessionsList.replaceChildren(fold([fault(e, null)]));
    }
  };

  // -- recovery codes -----------------------------------------------------------

  const paintCodes = () => {
    if (!recoveryCodes || !recoveryCodes.length) {
      codesBody.replaceChildren();
      return;
    }
    codesBody.replaceChildren(
      el('pre', { class: 'recovery-codes', 'aria-label': 'Recovery codes' },
        recoveryCodes.join('\n')),
      el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        onClick: async () => {
          try {
            const out = await Api.twoFactorRecoveryCodes();
            recoveryCodes = (out && (out.codes || out.recoveryCodes)) || [];
            paintCodes();
          } catch (e) { errorToast(e); }
        },
      }, 'New codes'));
  };

  // -- enrolment ----------------------------------------------------------------

  const enrol = async () => {
    try {
      const out = await Api.twoFactorSetup({});
      const status = el('p', { class: 'form-error', role: 'status' }, out && out.qr
        ? 'Scan it, then type the six-digit code from your app.'
        : 'Type the six-digit code from your second factor.');
      const setup = el('input', {
        class: 'input', type: 'text', inputmode: 'numeric', maxlength: '6',
        'aria-label': 'Type a six-digit code from your TOTP app',
        placeholder: '123456',
      });
      const dialog = openDialog({
        title: 'Enrol a second factor',
        body: el('form', {
          class: 'fold', onSubmit: async (event) => {
            event.preventDefault();
            try {
              const done = await Api.twoFactorEnable({ code: setup.value.trim() });
              if (done && done.ok !== false) {
                twofaStatus.textContent = 'The second factor is active.';
                recoveryCodes = done.recoveryCodes || done.codes || [];
                paintCodes();
                toast('Two-step is on');
                dialog.close();
              } else {
                status.textContent = 'The code was not accepted.';
              }
            } catch (e) {
              status.textContent = (e && e.message) || 'The code was not accepted.';
            }
          },
        },
          status,
          out && out.qr ? el('img', { src: out.qr, alt: 'The QR code to scan', class: 'auth-qr' }) : null,
          setup,
          el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Confirm')),
      });
      setup.focus();
    } catch (e) { errorToast(e); }
  };

  return {
    node: fold([
      head({
        kicker: 'Safety',
        title: 'Security',
        lede: 'Prove it is you, keep the door shut, know who is inside.',
      }),
      card({
        label: 'Password', glyph: 'lock',
        body: el('form', {
          class: 'fold', onSubmit: async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const inputs = form.querySelectorAll('input');
            if (inputs[1].value !== inputs[2].value) {
              form.appendChild(el('p', { class: 'form-error' }, 'The two new passwords differ.'));
              return;
            }
            try {
              await Api.changePassword({
                password: inputs[0].value, newPassword: inputs[1].value,
              });
              toast('The password is changed');
              form.reset();
            } catch (e) {
              form.appendChild(el('p', { class: 'form-error' },
                (e && e.message) || 'The change did not go through.'));
            }
          },
        },
          el('input', {
            class: 'input', type: 'password', placeholder: 'Current password',
            'aria-label': 'Current password',
          }),
          el('input', {
            class: 'input', type: 'password', placeholder: 'New password',
            'aria-label': 'New password',
          }),
          el('input', {
            class: 'input', type: 'password', placeholder: 'New password again',
            'aria-label': 'New password again',
          }),
          el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Change password')),
      }),
      card({
        label: 'Two-step sign-in', glyph: 'shield',
        body: fold([twofaStatus, codesBody, el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          onClick: enrol,
        }, 'Set up a second factor')]),
      }),
      card({ label: 'Signed-in devices', glyph: 'monitor', body: sessionsList, flush: true }),
      card({
        label: 'Close account', glyph: 'user-minus',
        body: fold([
          el('p', { class: 'lede' }, 'Request deletion of this account and everything held for it.'),
          el('button', {
            class: 'btn btn--danger btn--sm', type: 'button',
            onClick: async () => {
              const yes = await confirmDialog({
                title: 'Close this account?',
                body: 'This asks the instance to delete the account. It cannot be undone once processed.',
                confirmLabel: 'Request deletion',
                danger: true,
              });
              if (!yes) return;
              try {
                await Api.requestDeletion({ confirm: true });
                toast('Deletion requested');
              } catch (e) { errorToast(e); }
            },
          }, 'Request deletion'),
        ]),
      }),
    ]),
    onMount: async () => {
      try {
        const st = await Api.twoFactorStatus();
        twofaStatus.textContent = st && st.enabled
          ? 'A second factor is guarding this account.'
          : 'A second factor is not on yet - set one up below.';
      } catch (e) {
        twofaStatus.textContent = (e && e.message) || 'The second factor could not be read.';
      }
      paintCodes();
      await paintSessions();
    },
    cleanup() {},
  };
}

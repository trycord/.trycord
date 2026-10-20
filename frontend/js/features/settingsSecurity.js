// Settings: security.
// Prove it is you, keep the door shut, know who is inside.
//
// Every change to the second factor is confirmed with the password, because
// the server asks for it: a stolen session is not enough to take an account
// over. The client sends what the endpoint reads, so a change that the server
// would refuse is never attempted.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { applyToken } from '../../packages/store.js';
import { head, card, row, blank, fault, fold } from '../ui/page.js';
import { errorToast, toast, openDialog, confirmDialog } from '../ui/overlays.js';

export function securityView() {
  const sessionsList = el('div', { class: 'rowlist' });
  const twofaStatus = el('p', { class: 'form-error', role: 'status' }, 'Reading the second factor…');
  const codesBody = el('div', { class: 'anticipation-line' });
  const twofaTools = el('div', { class: 'rowtools' });
  let recoveryCodes = null;
  let twofaEnabled = false;

  // -- sessions ---------------------------------------------------------------

  const paintSessions = async () => {
    try {
      const rows = await Api.sessions();
      const items = Array.isArray(rows) ? rows : (rows && rows.items) || [];
      const revoke = async (session) => {
        try {
          await Api.revokeSession(session.jti);
          toast('That session is out');
          paintSessions();
        } catch (e) { errorToast(e); }
      };
      sessionsList.replaceChildren(...(items.length ? items.map((s) => row({
        lead: el('span', { class: 'role-dot' }, icon('monitor', { size: 15 })),
        title: s.userAgent || s.ua || 'A signed-in device',
        sub: s.createdAt ? new Date(s.createdAt).toLocaleString() : '',
        side: s.jti ? el('button', {
          class: 'btn btn--danger btn--sm', type: 'button',
          'aria-label': 'Revoke this session',
          onClick: () => revoke(s),
        }, 'Revoke') : null,
        // The same thing, raised by a right-click on the row.
        menu: () => (s.jti ? [
          { label: 'Revoke this session', icon: 'logout', danger: true, onSelect: () => revoke(s) },
        ] : []),
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
        onClick: () => newRecoveryCodes(),
      }, 'New codes'));
  };

  // The server issues a fresh set of recovery codes against the password. The
  // codes themselves are shown once, so the dialog that mints them is also
  // where they are read.
  const newRecoveryCodes = () => {
    const password = el('input', {
      class: 'input', type: 'password', autocomplete: 'current-password',
      'aria-label': 'Your password',
    });
    const dialog = openDialog({
      title: 'New recovery codes',
      sub: 'Each code signs you in once if you lose your authenticator. The old set stops working.',
      body: el('form', {
        class: 'fold',
        onSubmit: async (event) => {
          event.preventDefault();
          try {
            const out = await Api.twoFactorRecoveryCodes({ password: password.value });
            recoveryCodes = (out && (out.codes || out.recoveryCodes)) || [];
            paintCodes();
            dialog.close();
            toast('New recovery codes issued');
          } catch (error) {
            errorToast(error);
          }
        },
      }, password, el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Issue codes')),
    });
    password.focus();
  };

  // -- enrolment ----------------------------------------------------------------

  // Two steps in one dialog: the password, then the six digits. The secret is
  // shown as text rather than a picture, because the server hands over a
  // secret and a URI and no image.
  const enrol = () => {
    const password = el('input', {
      class: 'input', type: 'password', autocomplete: 'current-password',
      'aria-label': 'Your password',
    });
    const code = el('input', {
      class: 'input', type: 'text', inputmode: 'numeric', maxlength: '6',
      'aria-label': 'Six digits from your authenticator', placeholder: '123456',
    });
    const secret = el('code', { class: 'keyblock' });
    const status = el('p', { class: 'form-error', role: 'status' });
    let savedPassword = '';

    const body = el('div', { class: 'fold' }, password, secret, code, status);
    const submit = el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Continue');
    const dialog = openDialog({
      title: 'Enrol a second factor',
      sub: 'Scan the secret in your authenticator app, then type the six digits it shows.',
      body: el('form', {
        class: 'fold',
        onSubmit: async (event) => {
          event.preventDefault();
          submit.disabled = true;
          try {
            if (!savedPassword) {
              const out = await Api.twoFactorSetup({ password: password.value });
              savedPassword = password.value;
              secret.textContent = (out && out.secret) || '';
              submit.textContent = 'Turn on';
              status.textContent = 'Type the six digits the app shows.';
              code.focus();
              return;
            }
            const done = await Api.twoFactorEnable({ password: savedPassword, code: code.value.trim() });
            recoveryCodes = (done && (done.recoveryCodes || done.codes)) || [];
            paintCodes();
            twofaEnabled = true;
            paintTwoFactor();
            dialog.close();
            toast('Two-step is on');
          } catch (error) {
            status.textContent = (error && error.message) || 'That did not work.';
          } finally {
            submit.disabled = false;
          }
        },
      }, body, submit),
    });
    password.focus();
  };

  // Turning the factor off is confirmed with the password and a current code:
  // the server wants both before it lets go of the secret.
  const turnOff = () => {
    const password = el('input', {
      class: 'input', type: 'password', autocomplete: 'current-password',
      'aria-label': 'Your password',
    });
    const code = el('input', {
      class: 'input', type: 'text', inputmode: 'numeric', maxlength: '6',
      'aria-label': 'Six digits from your authenticator', placeholder: '123456',
    });
    const status = el('p', { class: 'form-error', role: 'status' });
    const dialog = openDialog({
      title: 'Turn off two-step sign-in',
      sub: 'Your password is the only key again. Every signed-in device is signed out.',
      body: el('form', {
        class: 'fold',
        onSubmit: async (event) => {
          event.preventDefault();
          try {
            await Api.twoFactorDisable({ password: password.value, code: code.value.trim() });
            recoveryCodes = null;
            twofaEnabled = false;
            paintCodes();
            paintTwoFactor();
            dialog.close();
            toast('Two-step sign-in is off');
          } catch (error) {
            status.textContent = (error && error.message) || 'That did not work.';
          }
        },
      }, password, code, status,
      el('button', { class: 'btn btn--danger btn--sm', type: 'submit' }, 'Turn off')),
    });
    password.focus();
  };

  // The controls the second factor offers depend on whether it is on.
  const paintTwoFactor = () => {
    twofaTools.replaceChildren(...(twofaEnabled
      ? [
        el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          onClick: newRecoveryCodes,
        }, 'New recovery codes'),
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onClick: turnOff,
        }, 'Turn off two-step sign-in'),
      ]
      : [
        el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          onClick: enrol,
        }, 'Set up a second factor'),
      ]));
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
              const out = await Api.changePassword({
                currentPassword: inputs[0].value, newPassword: inputs[1].value,
              });
              // The server ends every session when the password changes and
              // hands back a session for this one. Without taking it, the next
              // request would be refused and the reader would be signed out by
              // their own password change.
              if (out && out.token) applyToken(out.token, out.user);
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
            autocomplete: 'current-password',
            'aria-label': 'Current password',
          }),
          el('input', {
            class: 'input', type: 'password', placeholder: 'New password',
            autocomplete: 'new-password',
            'aria-label': 'New password',
          }),
          el('input', {
            class: 'input', type: 'password', placeholder: 'New password again',
            autocomplete: 'new-password',
            'aria-label': 'New password again',
          }),
          el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Change password')),
      }),
      card({
        label: 'Two-step sign-in', glyph: 'shield',
        body: fold([twofaStatus, codesBody, twofaTools]),
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
        twofaEnabled = !!(st && st.enabled);
        twofaStatus.textContent = twofaEnabled
          ? 'A second factor is guarding this account.'
          : 'A second factor is not on yet - set one up below.';
      } catch (e) {
        twofaStatus.textContent = (e && e.message) || 'The second factor could not be read.';
      }
      paintTwoFactor();
      paintCodes();
      await paintSessions();
    },
    cleanup() {},
  };
}

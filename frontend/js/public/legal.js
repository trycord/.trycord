import Api from '../api.js';
import { esc, el, clear, btn } from '../ui.js';
import { isAuthed } from '../state.js';
import { navigate } from '../nav.js';
import State from '../state.js';
import { mountAuthPage, authShell } from './auth.js';
// The published terms and privacy versions. The register form checks the
// reader accepted the versions that are live now, so it asks this module
// rather than fetching its own copy.
let versions = { termsVersion: '1.0', privacyVersion: '1.0' };

export function legalVersions() {
  return versions;
}

Api.legal().then((l) => { if (l) versions = l; }).catch(() => {});

export const AUTH_BG = '/assets/trycord-login-bg.png';
export const AUTH_LOGO = '/assets/trycord-logo.png';

export function legalPage(container, kind) {
  clear(container);
  const titles = { terms: 'Terms of Service', privacy: 'Privacy Policy' };
  const isTerms = kind === 'terms';
  const docPath = isTerms ? '/terms' : '/privacy';
  const wrap = el('div', { class: 'pub-page pub-page--narrow' });
  wrap.appendChild(el('h1', { class: 'pub-title' }, titles[kind] || 'Legal'));
  const body = el('div', { class: 'pub-prose' });
  body.appendChild(el('p', {},
    'This instance manages its own legal documents. Signing in or registering records your acceptance of the versions this server exposes (v'
    + esc(versions.termsVersion) + ' terms, v' + esc(versions.privacyVersion) + ' privacy).'));
  const cta = el('div', { class: 'pub-links' });
  cta.appendChild(el('a', { class: 'pub-link', href: docPath, 'data-document': '' },
    el('div', { class: 'pub-link__title' }, 'Read the full ' + (titles[kind] || 'document')),
    el('div', { class: 'pub-link__desc' }, 'Opens the complete ' + (isTerms ? 'terms' : 'privacy policy') + ' published by this instance.')));
  body.appendChild(cta);
  wrap.appendChild(body);
  container.appendChild(wrap);
}

// verification happens with or without a session and never reveals whether a
export function verifyEmailPage(container, token) {
  clear(container);
  const { page, main } = authShell({
    title: 'Confirm your email',
    lede: 'Confirming your recovery address…',
    contextTitle: 'Verify email',
  });
  const msg = el('div', { class: 'muted small', 'aria-live': 'polite' });
  const err = el('div', { class: 'form-error', hidden: true });
  const actions = el('div', { class: 'row-line', style: { marginTop: 'var(--t-d-4)' } });
  main.appendChild(err);
  main.appendChild(msg);
  main.appendChild(actions);
  mountAuthPage(page);

  (async () => {
    try {
      await Api.verifyEmail({ token });
      let me = null;
      if (isAuthed()) {
        try { me = await Api.me(); State.me = me; } catch { /* keep local session state */ }
      }
      msg.textContent = me
        ? 'Your email ' + esc(me.email) + ' is verified.'
        : 'Your email is verified and saved to your account.';
      actions.appendChild(el('button', {
        class: 'btn primary', type: 'button',
        onClick: () => { navigate(me ? '/settings' : '/login'); },
      }, me ? 'Open your account' : 'Sign in'));
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message || 'This verification link is no longer valid. Request a new one from your settings.';
      actions.appendChild(el('button', {
        class: 'btn primary', type: 'button',
        onClick: () => { navigate(isAuthed() ? '/settings' : '/login'); },
      }, isAuthed() ? 'Open your account' : 'Sign in'));
    }
  })();
}

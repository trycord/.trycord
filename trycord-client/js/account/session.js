// session — part of the account settings tree.
//
// Split out of the single 1,288-line module that held all eight tabs. Each tab
// is its own page; keeping them in one file meant opening the whole settings
// surface to change the appearance picker.

import { clearSession } from '../state.js';
import { el, confirmDialog } from '../ui.js';
import { clearAnnouncements } from '../shell.js';
import { navigate } from '../nav.js';

export function signOutButton() {
  const b = el('button', { class: 'settings-nav__signout', type: 'button' }, 'Sign out');
  b.addEventListener('click', () => {
    confirmDialog({
      title: 'Sign out?',
      message: 'You will need to sign in again on this device.',
      danger: true, confirmText: 'Sign out',
      onConfirm: async () => {
        try { await Api.logout(); } catch { /* server may be down; still sign out locally */ }
        try { Realtime.disconnect(); } catch { /* ignore */ }
        clearAnnouncements();
        clearSession();
        navigate('/login');
      },
    });
  });
  return b;
}

export default { signOutButton };

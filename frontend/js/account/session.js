// session — part of the account settings tree.
//
// Split out of the single 1,288-line module that held all eight tabs. Each tab
// is its own page; keeping them in one file meant opening the whole settings
// surface to change the appearance picker.

import { el } from '../ui.js';
import { confirmSignOut } from '../shell/sign-out.js';

export function signOutButton() {
  const b = el('button', { class: 'settings-nav__signout', type: 'button' }, 'Sign out');
  b.addEventListener('click', confirmSignOut);
  return b;
}

export default { signOutButton };

// Signing out, in one place.
//
// It was written twice - the settings navigation's button and the rail's account menu
// each carried a copy - and only one of them stopped the announcement timer or dropped
// the socket. Extracting it means the second caller cannot forget either step.

import Api from '../api.js';
import { clearAnnouncements } from './banners.js';
import { clearSession } from '../state.js';
import { confirmDialog } from '../ui.js';
import { navigate } from '../nav.js';

/**
 * Sign out, without asking. Used where the reader has already said yes
 * (an expired session), and by confirmSignOut().
 */
export async function doSignOut() {
  try { await Api.logout(); } catch {
    // The server may be unreachable or the session already gone. Signing out
    // locally is still the right thing to do, and saying nothing is right too:
    // the reader asked to leave, and they are leaving.
  }
  // Imported dynamically rather than statically: realtime.js imports shell.js, and
  // the rail is part of the shell, so a static import here would close that loop.
  try {
    const realtime = await import('../realtime.js');
    realtime.default.disconnect();
  } catch { /* no socket to drop */ }
  clearAnnouncements();
  clearSession();
  navigate('/login');
}

/** Sign out, after asking. */
export function confirmSignOut() {
  confirmDialog({
    title: 'Sign out?',
    message: 'You will need to sign in again on this device.',
    danger: true, confirmText: 'Sign out',
    onConfirm: doSignOut,
  });
}

export default { doSignOut, confirmSignOut };

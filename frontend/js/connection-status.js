// The connection indicator.
//
// Its own module because it is the one piece of chrome that is not about a route: it
// answers "is this device talking to the server", it has to survive every route, and it
// has to be right before the socket exists - which is why it is wired during boot rather
// than by any page.
//
// It used to live inside boot(), which meant the only way to read the online/offline
// logic was to read the boot sequence. Splitting it out also removed the one thing boot()
// was doing that nothing else in the file cared about.

import { qs } from './ui.js';
import { route } from './nav.js';
import { TrycordConfig } from './config.js';
import { resetFailoverAnnouncement } from './api.js';

// The one element. Built by shell/tree.js, addressed here by id because that is the
// contract between them.
function statusElement() {
  return qs('#connection-status');
}

// A failover outlives the connection blip that triggered it: the socket reconnects fine
// to the backup, so the offline path would hide the fact that this session is now talking
// to a different instance entirely. Said plainly, with the way back, because accounts,
// communities and messages live on one instance's database - someone who lands on the
// backup without being told sees an empty community list and concludes their account is
// gone.
function paintFailover(el, moved) {
  el.classList.add('show');
  el.classList.add('connection-status--notice');
  el.textContent = '';

  const text = document.createElement('span');
  text.textContent = 'Switched to backup instance ' + (moved.name || moved.to)
    + ' — ' + moved.from + ' is unreachable. Your account may not exist there.';
  el.appendChild(text);

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'connection-status__action';
  back.textContent = 'Use original';
  back.addEventListener('click', () => {
    const url = TrycordConfig.clearFailover();
    resetFailoverAnnouncement();
    el.classList.remove('show');
    el.classList.remove('connection-status--notice');
    // The backend URL is resolved per request, so a reload is what makes the original
    // take effect everywhere, including the WebSocket ticket. A real reload is the point.
    //
    // It asks for the app root rather than the current path: a reload is a request to the
    // server, and a deep path only comes back as the app if the instance has the SPA
    // fallback mounted. route() so that root is the app's root - a bare '/' is the
    // origin's, and on a deployment mounted under /app/ that is the public website.
    if (url) el.setAttribute('data-restored', url);
    location.assign(route('/'));
  });
  el.appendChild(text);
  el.appendChild(back);
}

/** Show or hide the indicator. `online` is the truth; the failover notice outranks it. */
export function setConnectionOnline(online) {
  const el = statusElement();
  if (!el) return;

  if (!online) {
    el.classList.add('show');
    el.textContent = 'Offline — reconnecting…';
    return;
  }
  const moved = TrycordConfig.failover();
  if (moved) { paintFailover(el, moved); return; }
  el.classList.remove('show');
  el.classList.remove('connection-status--notice');
}

/**
 * Wire the two browser events that say whether the network is there at all.
 *
 * Both call setOnline, so the rest of the client stops asking the server and the shell
 * can say why a list is empty.
 */
export function initConnectionStatus(setOnline) {
  setConnectionOnline(true);
  window.addEventListener('online', () => { setOnline(true); setConnectionOnline(true); });
  window.addEventListener('offline', () => { setOnline(false); setConnectionOnline(false); });
}

export default { init: initConnectionStatus, paint: setConnectionOnline };

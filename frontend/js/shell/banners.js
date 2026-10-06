// The two banners that sit above the application's own content: what an operator has
// published for the instance, and the reminder to verify an email address.
//
// Split out of shell.js. Both are session-scoped chrome rather than part of any one
// surface, and the announcement refresh timer is the only interval in the client that
// outlives a route change - which makes it worth being able to find it.

import Api from '../api.js';
import State, { isAuthed, mustVerifyToPost } from '../state.js';
import { clear, el, qs, toast } from '../ui.js';
import { navigate } from '../nav.js';

let annState = { items: [], loaded: false, timer: null };

export function loadAnnouncements({ force = false } = {}) {
  if (!isAuthed()) return Promise.resolve([]);
  if (annState.loaded && !force) return Promise.resolve(annState.items);
  return Api.announcements()
    .then((list) => {
      annState = { items: Array.isArray(list) ? list : [], loaded: true, timer: annState.timer };
      renderAnnouncementBanner();
      return annState.items;
    })
    .catch(() => { annState = { items: [], loaded: true, timer: annState.timer }; return []; });
}

function scheduleAnnouncementRefresh() {
  if (annState.timer) return;
  // Deliberately slow: this is instance chrome, not live data.
  annState.timer = setInterval(() => { loadAnnouncements({ force: true }); }, 120000);
}

// Announcements are session-scoped chrome. Without this the refresh timer
// outlives sign-out, keeps firing against a dead session, and carries the
// previous user's banners into the next session.
// This only tears down. It must not go back through renderAnnouncementBanner(),
// which reschedules whenever a session still looks live: sign-out clears the
// token *after* calling this, so the old token is still present here and the
export function clearAnnouncements() {
  if (annState.timer) { clearInterval(annState.timer); }
  annState = { items: [], loaded: false, timer: null };
  paintAnnouncementBanners();
}

export function renderAnnouncementBanner() {
  if (isAuthed()) scheduleAnnouncementRefresh();
  paintAnnouncementBanners();
}

function paintAnnouncementBanners() {
  const items = annState.items || [];
  for (const shell of [qs('#trycord-main')]) {
    if (!shell) continue;
    for (const old of Array.from(shell.querySelectorAll(':scope > .announce-banner'))) old.remove();
    for (const a of items.slice(0, 2)) {
      const level = ['info', 'warning', 'critical'].includes(a.level) ? a.level : 'info';
      const bar = el('div', {
        class: 'announce-banner announce-banner--' + level,
        role: level === 'critical' ? 'alert' : 'status',
      });
      if (a.linkHref) {
        bar.appendChild(el('a', { class: 'announce-banner__link', href: a.linkHref }, a.linkLabel || 'Open'));
      }
      bar.appendChild(el('span', { class: 'announce-banner__text' }, a.body));
      shell.prepend(bar);
    }
  }
}

// Shown while the session is unverified, with resend or
export function renderVerifyBanner() {
  const me = State.me;
  const show = !!(isAuthed() && mustVerifyToPost());
  for (const shell of [qs('#trycord-main')]) {
    if (!shell) continue;
    let bar = shell.querySelector(':scope > .verify-banner');
    if (!show) {
      if (bar) bar.remove();
      continue;
    }
    if (!bar) {
      bar = el('div', { class: 'verify-banner', role: 'status' });
      shell.prepend(bar);
    } else {
      clear(bar);
    }
    const hasEmail = !!(me && me.email);
    bar.appendChild(el('span', { class: 'verify-banner__text' }, hasEmail
      ? 'Verify your email to unlock messaging.'
      : 'Add an email address to verify your account.'));
    if (hasEmail) {
      const resend = el('button', { class: 'btn sm', type: 'button' }, 'Resend email');
      resend.addEventListener('click', async () => {
        resend.disabled = true;
        try {
          await Api.verifyEmailResend({ email: me.email });
          toast('Verification email sent.', 'ok');
        } catch (ex) { toast(ex.message || 'Could not resend.', 'error'); }
        finally { resend.disabled = false; }
      });
      bar.appendChild(resend);
    }
    const go = el('button', { class: 'btn ghost sm', type: 'button' }, hasEmail ? 'Settings' : 'Add email');
    go.addEventListener('click', () => { navigate('/settings'); });
    bar.appendChild(go);
  }
}

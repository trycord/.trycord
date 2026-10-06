// The account settings tree: the eight tabs under /settings, plus the pane beside
// them that explains what you are looking at.
//
// This file is the dispatcher. Each tab is its own module next door - profile,
// security, privacy, notifications, appearance, backend, updates - so changing the
// theme picker does not mean opening the deletion-request panel.

import Api from '../api.js';
import State, { refreshFriends, refreshMutes } from '../state.js';
import { el, clear } from '../ui.js';
import { renderContextHeader } from '../shell.js';
import { renderBackendSelector } from '../public/public.js';
import { TrycordConfig } from '../config.js';
import { settingsFrame, blurbFor, findItem } from '../settings-shell.js';
import { onCleanup } from '../pages/teardown.js';
import {
  privacyContext, securityContext, notificationsContext,
  appearanceContext, backendContext, guideContext, profileContext,
} from '../context-column.js';
import {
  watchForRemoteChanges,
  renderPrivacySection, renderNotificationPrefsSection,
} from '../privacy-ui.js';
import { sectionHead, sectionCard, setNote } from '../settings-ui.js';
import { signOutButton } from './session.js';
import { renderPrivacySocial } from './privacy.js';
import { renderNotificationsSettings } from './notifications.js';
import { renderAppearance } from './appearance.js';
import { renderProfileEditor, renderExportSection, renderDeletionSection } from './profile.js';
import { renderPasswordSection, renderTwoFactorSection, renderSessionsSection } from './security.js';
import { renderUpdates } from './updates.js';

let updatesUnsub = null;
const DELETION_STATUS_TEXT = {
  DELETION_REQUESTED: 'Requested. An administrator will review it.',
  UNDER_REVIEW: 'Approved and queued for processing.',
  DELETION_PROCESSING: 'Being processed now.',
  DELETED: 'Completed. This account can no longer sign in.',
  CANCELLED: 'Withdrawn.',
  REJECTED: 'Declined. You can submit a new request.',
};
const remoteWatchers = [];

export async function renderAccount(container, { tab = 'profile' } = {}) {
  clear(container);
  const item = findItem('account', tab);
  renderContextHeader({ title: 'Settings', sub: blurbFor('account', tab) });

  // The nav footer carries sign-out; the frame puts it in the nav column rather
  // than in the content, which is where a destructive control belongs.
  const footer = el('div', { class: 'settings-nav__footer' }, signOutButton());
  const { frame, pane, context } = settingsFrame({
    scope: 'account',
    active: tab,
    footer,
    contentClass: 'settings-body',
  });
  const wrap = el('div', { class: 'page' }, frame);

  // The pane's heading, from the same registry entry the nav and the context header
  // read. Two tabs were carrying a hand-typed sectionHead instead, and one of them
  // described the tab differently from the nav above it - "Channels that will not
  // raise an alert" against "Muted channels and alerts" - which is the drift this
  // arrangement exists to prevent.
  //
  // In its own element rather than at the head of the pane, because the tabs re-render
  // themselves in place: the security tab clears the pane body to swap its two-factor
  // state, and a heading appended above that would be taken with it.
  if (item) pane.appendChild(sectionHead(item.label, item.blurb || ''));
  const body = el('div', { class: 'settings-tab' });
  pane.appendChild(body);

  // In the document before anything is awaited. Appending at the end meant every
  // loading state below was built into a detached tree, so it was never painted:
  // the pane simply appeared some time later, with nothing in between. That is
  // indistinguishable from a hung request, which is the one thing a loading
  // state exists to prevent.
  container.appendChild(wrap);

  // Friends and mutes are needed by the two new sections. They are already
  // loaded on sign-in, so this only covers a deep link straight into them.
  if (tab === 'privacy' || tab === 'notifications') {
    await Promise.all([
      State.friendsLoaded ? Promise.resolve() : refreshFriends(),
      State.mutesLoaded ? Promise.resolve() : refreshMutes(),
    ]).catch(() => {
      // Not fatal, and deliberately not silent either: the sections below check
      // friendsLoaded/mutesLoaded and say the list could not be loaded rather than
      // that there is nothing in it.
    });
  }

  if (tab === 'appearance') {
    renderAppearance(body);
  } else if (tab === 'updates') {
    renderUpdates(body);
  } else if (tab === 'security' || tab === 'password' || tab === 'sessions') {
    // Legacy password/sessions routes render the unified Security page.
    renderPasswordSection(body, () => renderAccount(container, { tab }));
    renderTwoFactorSection(body);
    renderSessionsSection(body);
  } else if (tab === 'backend') {
    body.appendChild(setNote('Switching instances signs you out here first.'));
    const backendBox = sectionCard();
    renderBackendSelector(backendBox);
    body.appendChild(backendBox);
  } else if (tab === 'privacy') {
    // The gates the server enforces, then the social lists that sit under them.
    // Order matters: a reader arriving here because someone asked them to should
    // see the control that decides whether that is allowed before the list of
    // people who already have.
    await renderPrivacySection(body);
    renderPrivacySocial(body);
    // A block or unblock made on another device has to repaint this list.
    // Refreshing the cache alone left the section showing an empty list and a
    // "People blocked: 0" that was no longer true, which is worse than not
    // syncing at all because it looks like an answer rather than a lag.
    registerRemote('blocks', body, () => {
      renderPrivacySection(body);
      renderPrivacySocial(body);
    });
  } else if (tab === 'notifications') {
    // Per-category preferences and wellbeing first, then the muted channels that
    // were the only notification control this page had.
    await renderNotificationPrefsSection(body);
    renderNotificationsSettings(body);
    registerRemote('notifications', body, () => { renderNotificationPrefsSection(body); });
    registerRemote('wellbeing', body, () => { renderNotificationPrefsSection(body); });
  } else {
    renderProfileEditor(body);
    renderExportSection(body);
    renderDeletionSection(body);
  }

  await fillContext(frame, context, tab);
  onCleanup(releaseRemote);
}

function registerRemote(kind, host, repaint) {
  remoteWatchers.push(watchForRemoteChanges(kind, host, repaint));
}

function releaseRemote() {
  while (remoteWatchers.length) {
    const off = remoteWatchers.pop();
    try { off(); } catch { /* ignore */ }
  }
}

async function fillContext(frame, host, tab) {
  if (!host) return;
  let nodes = [];
  try {
    if (tab === 'privacy') {
      const [privacy, blocks] = await Promise.all([Api.privacy(), Api.blocks()]);
      nodes = privacyContext(privacy, blocks);
    } else if (tab === 'security' || tab === 'password' || tab === 'sessions') {
      const res = await Api.sessions();
      nodes = securityContext(res.sessions || []);
    } else if (tab === 'notifications') {
      const [prefs, wellbeing] = await Promise.all([
        Api.notificationPrefs().catch(() => null),
        Api.wellbeing().catch(() => null),
      ]);
      nodes = notificationsContext(
        (prefs && prefs.global) || {},
        wellbeing,
        State.mutedChannels ? State.mutedChannels.size : 0,
      );
    } else if (tab === 'appearance') {
      nodes = appearanceContext(
        localStorage.getItem('trycord.theme'),
        localStorage.getItem('trycord.density'),
        document.documentElement.classList.contains('reduce-motion'),
      );
    } else if (tab === 'backend') {
      const moved = TrycordConfig.failover();
      nodes = backendContext({
        url: TrycordConfig.backendUrl(),
        backupUrl: (TrycordConfig.backendFallbacks() || [])[0] || null,
        failedOver: !!moved,
      });
    } else if (tab === 'updates') {
      nodes = guideContext('About this build',
        el('p', { class: 'muted small' }, 'Version and build information for the instance this device is talking to. Trycord does not update itself: a new build appears here when the instance you are connected to is running one.'));
    } else if (tab === 'profile') {
      nodes = profileContext(State.me, State.serverDetail);
    }
  } catch {
    // A summary is a convenience. Failing to build one must not take the section
    // it summarises down with it.
    return;
  }
  if (!nodes.length) return;
  for (const n of nodes) host.appendChild(n);
  frame.dataset.hasContext = 'yes';
}

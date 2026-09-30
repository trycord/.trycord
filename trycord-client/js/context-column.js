// The contextual column beside a settings pane.
//
// A settings form has a natural width: read across a 1600px pane and its label
// and its control end up at opposite ends of the screen with nothing between
// them. The answer was a max-width, and a max-width on the pane leaves the rest
// of the window empty. So the width that is not worth spending on a form is
// spent on the part of the same decision that is not a form: what is currently
// stored, what it means, what else this section governs, and what a change here
// costs.
//
// Every column is built from state the API returned for the section it sits
// beside. Nothing here is a restatement of the controls in the pane, because a
// summary that repeats the controls tells a reader nothing and takes space that
// was supposed to be worth something. The column either says something the pane
// does not, or it is not rendered at all.

import Api from './api.js';
import State from './state.js';
import { el } from './ui.js';
import { sectionCard, settingRow } from './settings-ui.js';
import { serverPath } from './links.js';
import { route } from './nav.js';

// The server's vocabulary, verbatim. Presence uses 'everyone' where the request
// gates use 'anyone', and the two are different words for the same answer - the
// first is about who can see you, the second about who can reach you. An
// earlier version of this table knew only 'anyone', so a default presence read
// as "visible to ." in this column while the pane beside it said anyone. The
// fallback below exists so an unrecognised value shows itself rather than
// rendering empty.
const SCOPE_HELP = {
  anyone: 'Anyone on this instance',
  everyone: 'Anyone on this instance',
  friends: 'People you have accepted',
  nobody: 'Nobody',
};

const scopeText = (v) => SCOPE_HELP[v] || ('unrecognised value: ' + v);

const lower = (v) => String(v == null ? '' : v).toLowerCase();

function block(title, ...children) {
  const box = el('div', { class: 'ctx-card' });
  box.appendChild(el('h3', { class: 'settings-context__title' }, title));
  const inner = el('div', { class: 'ctx-card__body' });
  for (const c of children.flat(Infinity)) if (c) inner.appendChild(c);
  box.appendChild(inner);
  return box;
}

function fact(key, value) {
  const row = el('div', { class: 'kv-row' });
  row.appendChild(el('dt', { class: 'kv-key' }, key));
  row.appendChild(el('dd', { class: 'kv-val' }, value));
  return row;
}

function list(...children) {
  return el('dl', { class: 'kv-list' }, ...children.flat(Infinity).filter(Boolean));
}

function para(text, kind) {
  return el('p', { class: 'set-note' + (kind ? ' set-note--' + kind : '') }, text);
}

/**
 * Privacy: what is actually stored, and the consequence of each value.
 *
 * The pane holds the controls. This holds the answers, phrased as sentences
 * rather than as field values, because "friends" means different things to
 * someone who has just blocked three people than the word itself does.
 */
export function privacyContext(privacy, blocks) {
  const out = [];
  if (!privacy) return out;

  const nobody = privacy.dms === 'nobody' && privacy.friendRequests === 'nobody';
  out.push(block('What this means',
    para(nobody
      ? 'Nobody can reach you directly. Only people already in a community with you can, and only where that community allows it.'
      : privacy.dms === 'nobody'
        ? 'No one can open a conversation with you. Friend requests still arrive from ' + scopeText(privacy.friendRequests) + '.'
        : privacy.dms === 'friends'
          ? 'Only people you have accepted can message you. Anyone else has to send a friend request first.'
          : 'Anyone on this instance can open a conversation with you. Turning this off is the single biggest thing you can do to stop unsolicited messages.'),
    para(privacy.presence === 'nobody'
      ? 'Your online status is hidden. You will still appear offline rather than away.'
      : 'Your online status is visible to ' + scopeText(privacy.presence) + '.'),
    para(privacy.discoverable
      ? 'Your username can be found by searching. Turning this off hides you from search without affecting direct messages.'
      : 'You are hidden from search. People can still reach you through a community you share.'),
  ));

  const requests = State.friendRequests || [];
  if (requests.length) {
    out.push(block('Waiting on you (' + requests.length + ')',
      para('These are answered on the Privacy page, under Friend requests.'),
      list(...requests.slice(0, 6).map((r) => fact(
        r.displayName || r.username || 'Someone',
        r.username ? '@' + r.username : '',
      ))),
    ));
  }

  if (blocks && blocks.length) {
    out.push(block('Blocked (' + blocks.length + ')',
      para('Blocked people cannot message you or send a friend request. Any friendship ended when you blocked them, and they are not told why.'),
    ));
  }
  return out;
}

/**
 * Security: the session list, which is the thing a reader opens this section to
 * find and which is currently below the fold of a long form.
 */
export function securityContext(sessions) {
  const out = [];
  if (!sessions || !sessions.length) return [];
  // The server already names each session and marks the current one; deciding
  // that again here would be a second, worse answer to a question already
  // answered, and the two would disagree.
  const here = sessions.filter((s) => s.current);
  const others = sessions.filter((s) => !s.current);
  const when = (s) => (s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : 'Unknown');
  out.push(block('Signed in here',
    list(...here.map((s) => fact(s.label || 'This device', 'Current session'))),
    para('A session you do not recognise is not an emergency: sign it out, then change your password. Changing the password does not sign other devices out on its own.'),
  ));
  if (others.length) {
    out.push(block('Other sessions (' + others.length + ')',
      list(...others.slice(0, 8).map((s) => fact(s.label || 'Unknown device', when(s)))),
      para(others.length > 8 ? (others.length - 8) + ' more are not listed here.' : null),
    ));
  }
  return out;
}

/**
 * Notifications: the categories that are actually off, which is the question
 * somebody comes here with. A list of five enabled toggles tells them nothing.
 */
export function notificationsContext(prefs, wellbeing, mutedCount) {
  const out = [];
  const off = Object.keys(prefs || {}).filter((k) => prefs[k] === false);
  out.push(block('Delivery',
    para(wellbeing && wellbeing.dndEnabled
      ? 'Do not disturb is on. Nothing notifies you until you turn it off, whatever the categories below say.'
      : wellbeing && wellbeing.quietHoursOn
        ? 'Quiet hours are on. Nothing notifies you between the hours set in the pane.'
        : 'Every category is on. Turn off the ones you do not want to be interrupted for.'),
    list(
      fact('Categories off', String(off.length)),
      fact('Muted channels', String(mutedCount || 0)),
      fact('Quiet hours', wellbeing && wellbeing.quietHoursOn ? 'On' : 'Off'),
      fact('Do not disturb', wellbeing && wellbeing.dndEnabled ? 'On' : 'Off'),
    ),
  ));
  if (off.length) {
    out.push(block('Turned off',
      para('These are not being delivered at all, which is different from muted: muted still counts, these do not reach you.'),
      list(...off.map((k) => fact(k, 'Off'))),
    ));
  }
  return out;
}

/**
 * Appearance: what the current settings add up to, since every control here is
 * relative to a baseline the reader may not know.
 */
export function appearanceContext(theme, density, motion) {
  return [
    block('Your settings',
      list(
        fact('Theme', theme || 'System'),
        fact('Density', density || 'Default'),
        fact('Motion', motion ? 'Reduced' : 'Full'),
      ),
      para(motion
        ? 'Reduced motion removes transitions and animated movement. Your operating system may also ask for this independently of your choice here.'
        : 'Your operating system setting for reduced motion still applies even with this off.'),
    ),
  ];
}

/**
 * Backend: which instance this device is talking to, and what that means if it
 * changes. The most consequential invisible fact in the application.
 */
export function backendContext(config) {
  if (!config) return [];
  const rows = [
    fact('Active', config.url || 'Unknown'),
    fact('Backup', config.backupUrl || 'None configured'),
    fact('Status', config.failedOver ? 'Failed over to backup' : 'Primary'),
  ];
  return [
    block('This device',
      list(...rows),
      para('Your account lives on one instance. If this device reaches a different one, you will see an empty community list rather than an error, because a different instance does not know your account. Trycord tells you when that happens rather than letting you conclude your account was deleted.'),
    ),
  ];
}

/**
 * A generic column for a section that has no state of its own: what the section
 * governs and where else it applies. Better than an empty third of the window.
 */
export function guideContext(title, ...children) {
  return [block(title, ...children)];
}

export function profileContext(user, server) {
  const out = [];
  if (!user) return out;
  const rows = [
    fact('Username', user.username ? '@' + user.username : ''),
    fact('Display name', user.displayName || 'Not set'),
    fact('Status', user.status || 'Not set'),
  ];
  if (user.createdAt) rows.push(fact('Joined', new Date(user.createdAt).toLocaleDateString()));
  out.push(block('Your profile', list(...rows)));
  if (server) {
    out.push(block('Preview',
      para('This is what someone sees when they open your profile.'),
      el('a', { class: 'btn ghost sm', href: serverPath(server.id, '/profile/' + user.id) }, 'Open your profile'),
    ));
  }
  return out;
}

/**
 * A viewed profile.
 *
 * Everything here is a fact about the profile that the card beside it does not
 * already say in the same place: the fields that exist but are not worth a row
 * in the header, the role this person holds here, and where to go to change any
 * of it. Nothing is derived from their activity - a profile is not a dashboard,
 * and a stranger's message count is not context for a profile.
 */
export function profileViewContext(profile, { membership, isSelf } = {}) {
  const out = [];
  if (!profile) return out;

  const facts = [
    fact('Username', '@' + (profile.username || '')),
    fact('Joined', profile.createdAt ? new Date(profile.createdAt).toLocaleDateString() : 'Unknown'),
  ];
  if (profile.statusText) facts.push(fact('Status', profile.statusText));
  facts.push(fact('Presence', profile.presence === 'online' ? 'Online now' : 'Offline'));
  if (isSelf) facts.push(fact('Email', profile.email || 'Not set'));
  out.push(block(isSelf ? 'Your account' : 'Details', list(...facts)));

  if (membership && (membership.roles || []).length) {
    out.push(block('Roles here',
      list(...membership.roles.map((r) => fact(r.name || 'Role', r.color ? 'Coloured' : 'Default'))),
    ));
  }

  const actions = [];
  if (isSelf) {
    actions.push(el('a', { class: 'btn ghost sm', href: route('/settings') }, 'Edit your profile'));
  }
  if (actions.length) out.push(block('Actions', ...actions));

  return out;
}

export default {
  privacyContext,
  securityContext,
  notificationsContext,
  appearanceContext,
  backendContext,
  guideContext,
  profileContext,
  profileViewContext,
};
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

export function contextBlock(title, ...children) {
  const box = el('div', { class: 'ctx-card' });
  box.appendChild(el('h3', { class: 'settings-context__title' }, title));
  const inner = el('div', { class: 'ctx-card__body' });
  for (const c of children.flat(Infinity)) if (c) inner.appendChild(c);
  box.appendChild(inner);
  return box;
}

export function contextFact(key, value) {
  const row = el('div', { class: 'kv-row' });
  row.appendChild(el('dt', { class: 'kv-key' }, key));
  row.appendChild(el('dd', { class: 'kv-val' }, value));
  return row;
}

export function contextList(...children) {
  return el('dl', { class: 'kv-list' }, ...children.flat(Infinity).filter(Boolean));
}

export function contextPara(text, kind) {
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
  out.push(contextBlock('What this means',
    contextPara(nobody
      ? 'Nobody can reach you directly. Only people already in a community with you can, and only where that community allows it.'
      : privacy.dms === 'nobody'
        ? 'No one can open a conversation with you. Friend requests still arrive from ' + scopeText(privacy.friendRequests) + '.'
        : privacy.dms === 'friends'
          ? 'Only people you have accepted can message you. Anyone else has to send a friend request first.'
          : 'Anyone on this instance can open a conversation with you. Turning this off is the single biggest thing you can do to stop unsolicited messages.'),
    contextPara(privacy.presence === 'nobody'
      ? 'Your online status is hidden. You will still appear offline rather than away.'
      : 'Your online status is visible to ' + scopeText(privacy.presence) + '.'),
    contextPara(privacy.discoverable
      ? 'Your username can be found by searching. Turning this off hides you from search without affecting direct messages.'
      : 'You are hidden from search. People can still reach you through a community you share.'),
  ));

  const requests = State.friendRequests || [];
  if (requests.length) {
    out.push(contextBlock('Waiting on you (' + requests.length + ')',
      contextPara('These are answered on the Privacy page, under Friend requests.'),
      contextList(...requests.slice(0, 6).map((r) => contextFact(
        r.displayName || r.username || 'Someone',
        r.username ? '@' + r.username : '',
      ))),
    ));
  }

  if (blocks && blocks.length) {
    out.push(contextBlock('Blocked (' + blocks.length + ')',
      contextPara('Blocked people cannot message you or send a friend request. Any friendship ended when you blocked them, and they are not told why.'),
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
  out.push(contextBlock('Signed in here',
    contextList(...here.map((s) => contextFact(s.label || 'This device', 'Current session'))),
    contextPara('A session you do not recognise is not an emergency: sign it out, then change your password. Changing the password does not sign other devices out on its own.'),
  ));
  if (others.length) {
    out.push(contextBlock('Other sessions (' + others.length + ')',
      contextList(...others.slice(0, 8).map((s) => contextFact(s.label || 'Unknown device', when(s)))),
      contextPara(others.length > 8 ? (others.length - 8) + ' more are not listed here.' : null),
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
  out.push(contextBlock('Delivery',
    contextPara(wellbeing && wellbeing.dndEnabled
      ? 'Do not disturb is on. Nothing notifies you until you turn it off, whatever the categories below say.'
      : wellbeing && wellbeing.quietHoursOn
        ? 'Quiet hours are on. Nothing notifies you between the hours set in the pane.'
        : 'Every category is on. Turn off the ones you do not want to be interrupted for.'),
    contextList(
      contextFact('Categories off', String(off.length)),
      contextFact('Muted channels', String(mutedCount || 0)),
      contextFact('Quiet hours', wellbeing && wellbeing.quietHoursOn ? 'On' : 'Off'),
      contextFact('Do not disturb', wellbeing && wellbeing.dndEnabled ? 'On' : 'Off'),
    ),
  ));
  if (off.length) {
    out.push(contextBlock('Turned off',
      contextPara('These are not being delivered at all, which is different from muted: muted still counts, these do not reach you.'),
      contextList(...off.map((k) => contextFact(k, 'Off'))),
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
    contextBlock('Your settings',
      contextList(
        contextFact('Theme', theme || 'System'),
        contextFact('Density', density || 'Default'),
        contextFact('Motion', motion ? 'Reduced' : 'Full'),
      ),
      contextPara(motion
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
    contextFact('Active', config.url || 'Unknown'),
    contextFact('Backup', config.backupUrl || 'None configured'),
    contextFact('Status', config.failedOver ? 'Failed over to backup' : 'Primary'),
  ];
  return [
    contextBlock('This device',
      contextList(...rows),
      contextPara('Your account lives on one instance. If this device reaches a different one, you will see an empty community list rather than an error, because a different instance does not know your account. Trycord tells you when that happens rather than letting you conclude your account was deleted.'),
    ),
  ];
}

/**
 * A generic column for a section that has no state of its own: what the section
 * governs and where else it applies. Better than an empty third of the window.
 */
export function guideContext(title, ...children) {
  return [contextBlock(title, ...children)];
}

export function profileContext(user, server) {
  const out = [];
  if (!user) return out;
  const rows = [
    contextFact('Username', user.username ? '@' + user.username : ''),
    contextFact('Display name', user.displayName || 'Not set'),
    contextFact('Status', user.status || 'Not set'),
  ];
  if (user.createdAt) rows.push(contextFact('Joined', new Date(user.createdAt).toLocaleDateString()));
  out.push(contextBlock('Your profile', contextList(...rows)));
  if (server) {
    out.push(contextBlock('Preview',
      contextPara('This is what someone sees when they open your profile.'),
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
    contextFact('Username', '@' + (profile.username || '')),
    contextFact('Joined', profile.createdAt ? new Date(profile.createdAt).toLocaleDateString() : 'Unknown'),
  ];
  if (profile.statusText) facts.push(contextFact('Status', profile.statusText));
  facts.push(contextFact('Presence', profile.presence === 'online' ? 'Online now' : 'Offline'));
  if (isSelf) facts.push(contextFact('Email', profile.email || 'Not set'));
  out.push(contextBlock(isSelf ? 'Your account' : 'Details', contextList(...facts)));

  if (membership && (membership.roles || []).length) {
    out.push(contextBlock('Roles here',
      contextList(...membership.roles.map((r) => contextFact(r.name || 'Role', r.color ? 'Coloured' : 'Default'))),
    ));
  }

  const actions = [];
  if (isSelf) {
    actions.push(el('a', { class: 'btn ghost sm', href: route('/settings') }, 'Edit your profile'));
  }
  if (actions.length) out.push(contextBlock('Actions', ...actions));

  return out;
}

/**
 * The admin console's contextual column.
 *
 * The admin surfaces are lists: reports, appeals, users, audit rows. A list fills
 * a narrow measure and leaves the rest of the window empty, and the questions a
 * moderator actually asks are not in the list at all - what is waiting, what is
 * old, what this instance is currently enforcing. Those are the counts and the
 * rules, read from the same endpoints the section itself uses, so they cannot
 * disagree with it.
 *
 * Nothing here invents a statistic. If a count cannot be read it is omitted
 * rather than shown as zero, because a zero that means "failed to load" is worse
 * than no number.
 */
export async function adminContext(section) {
  const out = [];
  const card = (title, ...children) => contextBlock(title, ...children);

  const totals = [];
  const add = async (label, read) => {
    try {
      const n = countOf(await read());
      if (n !== null) totals.push(contextFact(label, String(n)));
    } catch {
      // Omitted rather than shown as zero: a moderator reading "0 open reports"
      // when the request failed has been told something false, and the number is
      // the whole reason this column exists.
    }
  };
  await add('Open reports', () => Api.adminReports({ status: 'open', limit: 200 }));
  await add('Pending appeals', () => Api.adminAppeals({ status: 'pending', limit: 200 }));
  await add('Deletion requests', () => Api.adminGdprRequests({ status: 'pending', limit: 200 }));

  if (totals.length) {
    out.push(card('Waiting on you', contextList(...totals),
      contextPara('Counts read from the same endpoints as the section beside them.')));
  }

  if (section === 'reports' || section === 'appeals' || section === 'audit') {
    out.push(card('How this list works',
      contextPara(section === 'audit'
        ? 'Every action an operator takes is recorded here before it is visible anywhere else, with the actor and the reason.'
        : 'Entries stay in the queue until an administrator resolves them. Resolving records the decision against your account, so it can be reviewed later.')));
  }

  if (section === 'gdpr') {
    out.push(card('What deletion covers',
      contextPara('A processed request erases the account and its content. Some records are retained by law or for integrity: moderation actions and audit entries, so that a decision made against a person remains defensible after they are gone.')));
  }

  if (section === 'users' || section === 'communities') {
    out.push(card('Before you act',
      contextPara('These lists show what an instance knows about people. Everything you do here is attributed to your account and written to the audit log.')));
  }

  return out;
}

// Every one of these endpoints answers with a different envelope. Normalising
// here means the column does not have to know which is which, and a shape that
// changes to something unrecognised returns null instead of a misleading number.
function countOf(res) {
  if (Array.isArray(res)) return res.length;
  if (!res || typeof res !== 'object') return null;
  for (const key of ['items', 'rows', 'reports', 'appeals', 'requests', 'users', 'servers', 'data']) {
    if (Array.isArray(res[key])) return res[key].length;
  }
  if (typeof res.total === 'number') return res.total;
  return null;
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
  adminContext,
  contextBlock,
  contextFact,
  contextList,
  contextPara,
};
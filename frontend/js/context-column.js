// The column beside a settings pane.
//
// A form has a natural width. The space either side of it is spent on what is stored,
// what it means and what else the section governs - never a restatement of the controls
// beside it.

import Api from './api.js';
import State from './state.js';
import { el } from './ui.js';
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
      ? 'Nobody can message you. People in a community you share can, where it allows.'
      : privacy.dms === 'nobody'
        ? 'No one can start a chat with you. Friend requests still arrive from ' + scopeText(privacy.friendRequests) + '.'
        : privacy.dms === 'friends'
          ? 'Only your friends can message you. Everyone else must send a friend request first.'
          : 'Anyone here can message you. Restricting this is the best way to stop unwanted messages.'),
    contextPara(privacy.presence === 'nobody'
      ? 'Your online status is hidden — you appear offline.'
      : 'Your online status is visible to ' + scopeText(privacy.presence) + '.'),
    contextPara(privacy.discoverable
      ? 'You can be found in search. Turn this off to hide; direct messages are unaffected.'
      : 'You are hidden from search. People in a shared community can still reach you.'),
  ));

  const requests = State.friendRequests || [];
  if (requests.length) {
    out.push(contextBlock('Waiting on you (' + requests.length + ')',
      contextPara('Answer these under Friend requests on the Privacy page.'),
      contextList(...requests.slice(0, 6).map((r) => contextFact(
        r.displayName || r.username || 'Someone',
        r.username ? '@' + r.username : '',
      ))),
    ));
  }

  if (blocks && blocks.length) {
    out.push(contextBlock('Blocked (' + blocks.length + ')',
      contextPara('Blocked people cannot message you or add you. Blocking ends any friendship, and they are not told.'),
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
    contextPara('Do not recognise a session? Sign it out, then change your password. Changing it does not sign other devices out.'),
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
      ? 'Do not disturb is on — nothing notifies you.'
      : wellbeing && wellbeing.quietHoursOn
        ? 'Quiet hours are on — nothing notifies you during them.'
        : 'All categories are on.'),
    contextList(
      contextFact('Categories off', String(off.length)),
      contextFact('Muted channels', String(mutedCount || 0)),
      contextFact('Quiet hours', wellbeing && wellbeing.quietHoursOn ? 'On' : 'Off'),
      contextFact('Do not disturb', wellbeing && wellbeing.dndEnabled ? 'On' : 'Off'),
    ),
  ));
  if (off.length) {
    out.push(contextBlock('Turned off',
      contextPara('These do not reach you at all. Muted channels still count; these do not.'),
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
        ? 'Transitions and animation are off. Your OS can ask for this too.'
        : 'Your OS reduced-motion setting still applies.'),
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
      contextPara('Your account is on one instance. If this device connects to another, it will look empty — that is why, not a deleted account.'),
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

// The admin console's contextual column.
//
// Admin surfaces are lists, and a list leaves most of the window empty. The
// things a moderator actually asks aren't in the list - what's waiting, what's
// old, what this instance is currently enforcing. Those counts come from the
// same endpoints the section itself uses, so they can't disagree with it.
//
// Nothing here invents a statistic: a count that can't be read is omitted rather
// than shown as zero, because a zero meaning "failed to load" is worse than no
// number.
export async function adminContext(section, fetched) {
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

  // The section beside this column already asked /admin/overview. Using its
  // response is the difference between the number beside the list and the number
  // in the list coming from two different moments, and between one request and two.
  const overview = (fetched && fetched.overview) || await Api.adminOverview().catch(() => null);
  if (overview) {
    totals.push(contextFact('Open reports', String(overview.openReports)));
    totals.push(contextFact('Appeals to review', String(overview.openAppeals)));
  }

  // Same for the deletion count the GDPR section has already read.
  const pending = fetched && fetched.pendingDeletions;
  if (pending !== undefined && pending !== null) {
    totals.push(contextFact('Deletion requests', String(pending)));
  } else {
    await add('Deletion requests', () => Api.adminGdprRequests({ status: 'DELETION_REQUESTED', limit: 100 }));
  }

  if (totals.length) {
    out.push(card('Waiting on you', contextList(...totals),
      contextPara('Counted from the same data as the section beside it.')));
  }

  if (section === 'reports' || section === 'appeals' || section === 'audit') {
    out.push(card('How this list works',
      contextPara(section === 'audit'
        ? 'Every operator action is recorded here, with who did it and why.'
        : 'Entries stay queued until an admin resolves them; the decision is recorded on your account.')));
  }

  if (section === 'gdpr') {
    out.push(card('What deletion covers',
      contextPara('Processing erases the account and its content. Moderation and audit records are kept, as required.')));
  }

  if (section === 'users' || section === 'communities') {
    out.push(card('Before you act',
      contextPara('These lists show what the instance knows about people. Every action here is written to the audit log against your account.')));
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
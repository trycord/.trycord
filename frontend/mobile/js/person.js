// One sheet for a person, wherever their name is drawn.
//
// The same set of questions a person can be asked on a desk is asked on a
// phone: who they are, whether you are friends, and what you want to do about
// it. The phone's answer is a bottom sheet rather than a menu, because a sheet
// is reachable with a thumb.
//
// Every entry performs. A relation the server never reported is not offered,
// and the block entry reads the viewer's own list before it decides whether it
// is blocking or unblocking.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { State, nameOf, friendshipWith, normalizeUser } from '../../packages/store.js';
import { navigate } from '../../packages/nav.js';
import Api from '../../packages/api.js';
import { sheet, confirm, toast } from './ui.js';
import { copyText } from './clipboard.js';

export function isSelf(user) {
  return !!(user && State.user && String(user.id) === String(State.user.id));
}

async function openChat(user) {
  try {
    const dm = await Api.createDm(user.id);
    navigate('/dms/' + (dm.id || dm.conversationId));
  } catch (error) {
    toast((error && error.message) || 'That conversation did not open.', { type: 'danger' });
  }
}

async function offerFriendship(user, changed) {
  try {
    await Api.sendFriendRequest(user.id);
    toast('Friend request sent.', { type: 'success' });
    if (changed) changed();
  } catch (error) {
    toast((error && error.message) || 'That request did not send.', { type: 'danger' });
  }
}

// The request id is never on the user, so it is read out of the lists the
// client holds; if it cannot be found the honest answer is that it is gone.
async function pendingRequest(user) {
  const page = await Api.friendRequests();
  const all = [].concat(page.incoming || page.incomingRequests || [], page.outgoing || page.outgoingRequests || []);
  return all.find((request) =>
    String(request.userId || request.user_id || (request.user && request.user.id)) === String(user.id)) || null;
}

async function acceptRequest(user, changed) {
  try {
    const request = await pendingRequest(user);
    if (!request) { toast('That request is already gone.'); return; }
    await Api.acceptFriendRequest(request.id);
    toast('You are friends now.', { type: 'success' });
    if (changed) changed();
  } catch (error) {
    toast((error && error.message) || 'That request did not go through.', { type: 'danger' });
  }
}

async function withdrawRequest(user, changed) {
  try {
    const request = await pendingRequest(user);
    if (!request) { toast('That request is already gone.'); return; }
    await Api.cancelFriendRequest(request.id);
    toast('Request withdrawn.', { type: 'success' });
    if (changed) changed();
  } catch (error) {
    toast((error && error.message) || 'That request did not go through.', { type: 'danger' });
  }
}

async function endFriendship(user, changed) {
  const sure = await confirm({
    title: 'Remove ' + nameOf(user) + '?',
    text: 'You can send a new request later.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!sure) return;
  try {
    await Api.removeFriend(user.id);
    toast('Removed.', { type: 'success' });
    if (changed) changed();
  } catch (error) {
    toast((error && error.message) || 'That did not go through.', { type: 'danger' });
  }
}

async function blockPerson(user, changed) {
  const sure = await confirm({
    title: 'Block ' + nameOf(user) + '?',
    text: 'They cannot message you or send requests, and you stop seeing their messages.',
    confirmLabel: 'Block',
    danger: true,
  });
  if (!sure) return;
  try {
    await Api.blockUser(user.id, '');
    toast('Blocked.', { type: 'success' });
    if (changed) changed();
  } catch (error) {
    toast((error && error.message) || 'That did not go through.', { type: 'danger' });
  }
}

async function unblockPerson(user, changed) {
  try {
    await Api.unblockUser(user.id);
    toast('Unblocked.', { type: 'success' });
    if (changed) changed();
  } catch (error) {
    toast((error && error.message) || 'That did not go through.', { type: 'danger' });
  }
}

// Blocking is a property of the viewer's own list, so it is read before the
// entry is drawn rather than inferred from whatever happened to be on screen.
async function isBlocked(user) {
  try {
    const list = await Api.blocks();
    return (list || []).some((entry) =>
      String(entry.userId || entry.user_id || entry.id || (entry.user && entry.user.id)) === String(user.id));
  } catch {
    return false;
  }
}

function raiseReport(user) {
  const reason = el('select', { class: 'm-input m-input--select', 'aria-label': 'Reason' }, ...[
    ['harassment', 'Harassment or abuse'],
    ['spam', 'Spam or a scam'],
    ['impersonation', 'Pretending to be someone else'],
    ['other', 'Something else'],
  ].map(([value, label]) => el('option', { value }, label)));
  const detail = el('textarea', {
    class: 'm-input m-input--area', rows: '4', maxlength: '2000',
    placeholder: 'What happened? Anything you add helps whoever reads this.',
    'aria-label': 'What happened',
  });
  const layer = sheet({
    title: 'Report ' + nameOf(user),
    body: el('div', { class: 'm-stack' },
      el('p', { class: 'm-lede' }, 'This goes to whoever moderates this instance. ' + nameOf(user) + ' is not told who filed it.'),
      el('label', { class: 'm-field' }, el('span', { class: 'm-field__label' }, 'Reason'), reason),
      el('label', { class: 'm-field' }, el('span', { class: 'm-field__label' }, 'What happened'), detail)),
    footer: el('button', {
      class: 'm-btn m-btn--block m-btn--primary', type: 'button',
      onClick: async (event) => {
        event.currentTarget.disabled = true;
        try {
          await Api.reports({ targetType: 'user', targetId: user.id, reason: reason.value, description: detail.value.trim() });
          layer.close();
          toast('Report sent. Thank you.', { type: 'success' });
        } catch (error) {
          toast((error && error.message) || 'The report did not send.', { type: 'danger' });
          event.currentTarget.disabled = false;
        }
      },
    }, 'Send report'),
  });
}

/**
 * The actions on a person.
 *
 * `options.extra` carries what the caller knows that this module does not:
 * for a roster line, the moderation the community's permission list allows.
 */
// The relationship as the profile screen reports it, and as the store holds
// it, are the same vocabulary in two spellings.
const RELATION = {
  friend: 'friend',
  'pending-in': 'incoming',
  'pending-out': 'outgoing',
  none: 'none',
};

export async function personActions(raw, options) {
  const opts = options || {};
  const user = normalizeUser(raw) || raw;
  const items = [];
  if (!user || user.id === undefined || user.id === null) return items;

  const self = opts.relation === 'self' || isSelf(user);
  items.push({ header: nameOf(user) + (self ? ' (you)' : '') });

  if (self) {
    items.push({ label: 'Your profile', icon: 'user', onSelect: () => navigate('/users/' + user.id) });
    items.push({ label: 'Account settings', icon: 'settings', onSelect: () => navigate('/settings') });
    items.push({ label: 'Extensions', icon: 'grid', onSelect: () => navigate('/extensions') });
    items.push({ label: 'Developer', icon: 'code', onSelect: () => navigate('/developer') });
  } else {
    items.push({ label: 'View profile', icon: 'user', onSelect: () => navigate('/users/' + user.id) });
    items.push({ label: 'Open a chat', icon: 'message', onSelect: () => openChat(user) });

    const relation = opts.relation ? (RELATION[opts.relation] || 'none') : friendshipWith(user.id);
    if (relation === 'friend') {
      items.push({ label: 'Remove friend', icon: 'user-minus', onSelect: () => endFriendship(user, opts.onChanged) });
    } else if (relation === 'outgoing') {
      items.push({ label: 'Withdraw request', icon: 'x', onSelect: () => withdrawRequest(user, opts.onChanged) });
    } else if (relation === 'incoming') {
      items.push({ label: 'Accept request', icon: 'check', onSelect: () => acceptRequest(user, opts.onChanged) });
    } else {
      items.push({ label: 'Offer friendship', icon: 'user-plus', onSelect: () => offerFriendship(user, opts.onChanged) });
    }
  }

  items.push({ separator: true });
  items.push({ label: 'Copy handle', icon: 'copy', onSelect: () => copyText('@' + (user.username || nameOf(user)), 'Handle') });

  if (!isSelf(user)) {
    items.push({ label: 'Report', icon: 'flag', onSelect: () => raiseReport(user) });
    const blocked = opts.blocked === undefined ? (await isBlocked(user)) : !!opts.blocked;
    items.push(blocked
      ? { label: 'Unblock', icon: 'check', onSelect: () => unblockPerson(user, opts.onChanged) }
      : { label: 'Block', icon: 'x', danger: true, onSelect: () => blockPerson(user, opts.onChanged) });
  }

  if (opts.extra && opts.extra.length) {
    items.push({ separator: true });
    for (const entry of opts.extra) items.push(entry);
  }

  return items;
}

// The person's profile, in full: the sheet with their face, their name and the
// actions that belong to them.
export function openPerson(user, options) {
  const body = el('div', { class: 'm-person' },
    el('div', { class: 'm-person__name' }, nameOf(user)),
    el('div', { class: 'm-person__handle' }, '@' + (user.username || '')),
    user.statusText ? el('div', { class: 'm-person__status' }, user.statusText) : null);
  const layer = sheet({ title: nameOf(user) || 'Person', body });
  personActions(user, options).then((items) => {
    if (!items.length) return;
    const list = el('div', { class: 'm-list' });
    for (const item of items) {
      if (item.separator) { list.appendChild(el('div', { class: 'm-menu__sep' })); continue; }
      if (item.header) continue;
      list.appendChild(el('button', {
        class: 'm-row' + (item.danger ? ' is-danger' : ''), type: 'button',
        onClick: () => { layer.close(); if (item.onSelect) item.onSelect(); },
      },
        el('span', { class: 'm-row__lead' }, item.icon ? icon(item.icon, { size: 18 }) : null),
        el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, item.label))));
    }
    body.appendChild(list);
  });
  return layer;
}

export default { personActions, openPerson, isSelf };

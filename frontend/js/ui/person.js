// One sheet for a person, wherever their name is drawn.
//
// A message author, a roster line and an avatar all raise the same sheet,
// because what you can do about someone is a property of the two of you, not of
// the surface they happened to be drawn on. A caller may append community
// entries - the one side that knows the permission list of the community in
// question.
//
// Every entry performs. A relation the server never reported is not offered,
// and the block entry reads the viewer's own block list before it decides
// whether it is blocking or unblocking.

import { el } from '../../packages/dom.js';
import { openMenu, openDialog, attachContextMenu, toast, errorToast, confirmDialog } from './overlays.js';
import { avatar } from './primitives.js';
import { State, nameOf, friendshipWith, normalizeUser } from '../../packages/store.js';
import { navigate } from '../../packages/nav.js';
import Api from '../../packages/api.js';

export function isSelf(user) {
  return !!(user && State.user && String(user.id) === String(State.user.id));
}

// -- the actions --------------------------------------------------------------

async function openChannel(user) {
  try {
    const dm = await Api.createDm(user.id);
    navigate('/dms/' + dm.id);
  } catch (error) { errorToast(error); }
}

async function offerFriendship(user) {
  try {
    await Api.sendFriendRequest(user.id);
    toast('Friend request sent.', { type: 'success' });
  } catch (error) { errorToast(error); }
}

// The request id is never on the user, so it is read out of the lists the client
// holds; if it cannot be found the honest answer is that it is already gone.
async function pendingRequest(user) {
  const page = await Api.friendRequests();
  const all = [].concat(page.incoming || page.incomingRequests || [], page.outgoing || page.outgoingRequests || []);
  return all.find((request) =>
    String(request.userId || request.user_id || (request.user && request.user.id)) === String(user.id)) || null;
}

async function acceptRequest(user) {
  try {
    const request = await pendingRequest(user);
    if (!request) { toast('That request is already gone.', { type: 'info' }); return; }
    await Api.acceptFriendRequest(request.id);
    toast('You are friends now.', { type: 'success' });
  } catch (error) { errorToast(error); }
}

async function withdrawRequest(user) {
  try {
    const request = await pendingRequest(user);
    if (!request) { toast('That request is already gone.', { type: 'info' }); return; }
    await Api.cancelFriendRequest(request.id);
    toast('Request withdrawn.', { type: 'success' });
  } catch (error) { errorToast(error); }
}

async function endFriendship(user) {
  const sure = await confirmDialog({
    title: 'Remove ' + nameOf(user) + '?',
    body: 'You can send a new request later.',
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!sure) return;
  try {
    await Api.removeFriend(user.id);
    toast('Removed.', { type: 'success' });
  } catch (error) { errorToast(error); }
}

async function blockPerson(user) {
  const sure = await confirmDialog({
    title: 'Block ' + nameOf(user) + '?',
    body: 'They cannot message you or send requests, and you stop seeing their messages.',
    confirmLabel: 'Block',
    danger: true,
  });
  if (!sure) return;
  try {
    await Api.blockUser(user.id, '');
    toast('Blocked.', { type: 'success' });
  } catch (error) { errorToast(error); }
}

async function unblockPerson(user) {
  try {
    await Api.unblockUser(user.id);
    toast('Unblocked.', { type: 'success' });
  } catch (error) { errorToast(error); }
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

async function copyHandle(user) {
  const handle = user.username ? '@' + user.username : nameOf(user);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(handle);
    toast('Handle copied.', { type: 'success' });
  } catch {
    toast(handle, { type: 'info' });
  }
}

// A report needs a reason and the words a moderator reads first. The person
// reported is never told who filed it.
function raiseReport(user) {
  const reason = el('select', { class: 'input', 'aria-label': 'Reason' }, ...[
    ['harassment', 'Harassment or abuse'],
    ['spam', 'Spam or a scam'],
    ['impersonation', 'Pretending to be someone else'],
    ['other', 'Something else'],
  ].map(([value, label]) => el('option', { value }, label)));

  const detail = el('textarea', {
    class: 'input', rows: '4', maxlength: '2000',
    placeholder: 'What happened? Anything you add helps whoever reads this.',
  });

  const cancel = el('button', { class: 'btn btn--ghost', type: 'button' }, 'Cancel');
  const send = el('button', { class: 'btn btn--primary', type: 'button' }, 'Send report');

  const body = el('div', { class: 'form-stack' },
    el('p', { class: 'form-note' }, 'This goes to whoever moderates this instance. ' + nameOf(user) + ' is not told who filed it.'),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Reason'), reason),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'What happened'), detail));

  const dialog = openDialog({ title: 'Report ' + nameOf(user), foot: [cancel, send] });
  dialog.element.insertBefore(body, dialog.element.querySelector('.dialog-foot'));
  cancel.addEventListener('click', () => dialog.close());
  send.addEventListener('click', async () => {
    send.disabled = true;
    try {
      await Api.reports({ targetType: 'user', targetId: user.id, reason: reason.value, description: detail.value.trim() });
      dialog.close();
      toast('Report sent. Thank you.', { type: 'success' });
    } catch (error) {
      errorToast(error);
      send.disabled = false;
    }
  });
}

// -- the sheet ----------------------------------------------------------------
//
// Async: the block entry asks the viewer's list before it is drawn.

export async function personSheetEntries(raw, options) {
  const opts = options || {};
  const user = normalizeUser(raw) || raw;
  const items = [];
  if (!user || user.id === undefined || user.id === null) return items;

  items.push({
    header: nameOf(user) + (isSelf(user) ? ' (you)' : ''),
    lead: avatar(user, { size: 'sm' }),
  });

  if (isSelf(user)) {
    items.push({ label: 'Your profile', icon: 'user', onSelect: () => navigate('/users/' + user.id) });
    items.push({ label: 'Account settings', icon: 'settings', onSelect: () => navigate('/settings') });
    items.push({ label: 'Extensions', icon: 'grid', onSelect: () => navigate('/extensions') });
    items.push({ label: 'Developer', icon: 'code', onSelect: () => navigate('/developer') });
  } else {
    items.push({ label: 'View profile', icon: 'user', onSelect: () => navigate('/users/' + user.id) });
    items.push({ label: 'Open a channel', icon: 'message', onSelect: () => openChannel(user) });

    const relation = friendshipWith(user.id);
    if (relation === 'friend') {
      items.push({ label: 'Remove friend', icon: 'user-minus', onSelect: () => endFriendship(user) });
    } else if (relation === 'outgoing') {
      items.push({ label: 'Withdraw request', icon: 'x', onSelect: () => withdrawRequest(user) });
    } else if (relation === 'incoming') {
      items.push({ label: 'Accept request', icon: 'check', onSelect: () => acceptRequest(user) });
    } else {
      items.push({ label: 'Offer friendship', icon: 'user-plus', onSelect: () => offerFriendship(user) });
    }
  }

  items.push({ separator: true });
  items.push({ label: 'Copy handle', icon: 'copy', onSelect: () => copyHandle(user) });

  if (!isSelf(user)) {
    items.push({ label: 'Report', icon: 'flag', onSelect: () => raiseReport(user) });
    items.push((await isBlocked(user))
      ? { label: 'Unblock', icon: 'check', onSelect: () => unblockPerson(user) }
      : { label: 'Block', icon: 'x', danger: true, onSelect: () => blockPerson(user) });
  }

  // Whatever the caller knows that this module does not: for a roster line, the
  // moderation entries the community's permission list allows.
  if (opts.extra && opts.extra.length) {
    items.push({ separator: true });
    for (const entry of opts.extra) items.push(entry);
  }

  return items;
}

// Raise it under a control, the way a "more" control does.
export async function personSheet(anchor, raw, options) {
  const items = await personSheetEntries(raw, options);
  if (items.length) openMenu({ anchor, items, align: (options && options.align) || 'right' });
}

// Raise it at a point: right-click on a desk, long press on a phone.
export function personContextMenu(node, raw, options) {
  attachContextMenu(node, () => personSheetEntries(raw, options), options);
}

export default { personSheetEntries, personSheet, personContextMenu, isSelf };

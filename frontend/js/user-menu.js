// One menu for a person, wherever their name is drawn.
//
// A message author, a roster row and an avatar all open the same list, because
// what you can do about someone is a property of the two of you rather than of
// the surface they happen to be drawn on. A caller may append moderation entries,
// the only side that knows the permission list for the community in question.
//
// Every entry does something: it opens a profile, starts a conversation, sends or
// answers a request, files a report, or blocks. A relation the server did not
// report is never offered, and the block entry reads the viewer's own block list
// before it decides which of the two it is.

import { el } from '../packages/dom.js';
import { openMenu, openDialog, attachContextMenu, toast, errorToast, confirmDialog } from './ui.js';
import { State, nameOf, friendshipWith, normalizeUser } from '../packages/store.js';
import { navigate } from '../packages/nav.js';
import Api from '../packages/api.js';

export function isSelf(user) {
  return !!(user && State.user && String(user.id) === String(State.user.id));
}

// -- the actions -------------------------------------------------------------

async function message(user) {
  try {
    const dm = await Api.createDm(user.id);
    navigate('/dms/' + dm.id);
  } catch (error) { errorToast(error); }
}

async function addFriend(user) {
  try {
    await Api.sendFriendRequest(user.id);
    toast('Friend request sent.', { type: 'success' });
  } catch (error) { errorToast(error); }
}

// The request id is not on the user, so it is read from the list the client
// already holds before acting; a request that cannot be found is reported rather
// than guessed at.
async function findRequest(user) {
  const page = await Api.friendRequests();
  const all = [].concat(page.incoming || page.incomingRequests || [], page.outgoing || page.outgoingRequests || []);
  return all.find((r) => String(r.userId || r.user_id || (r.user && r.user.id)) === String(user.id))
    || all.find((r) => r.user && String(r.user.id) === String(user.id))
    || null;
}

async function acceptFriend(user) {
  try {
    const request = await findRequest(user);
    if (!request) { toast('That request is already gone.', { type: 'info' }); return; }
    await Api.acceptFriendRequest(request.id);
    toast('You are friends now.', { type: 'success' });
  } catch (error) { errorToast(error); }
}

async function cancelFriend(user) {
  try {
    const request = await findRequest(user);
    if (!request) { toast('That request is already gone.', { type: 'info' }); return; }
    await Api.cancelFriendRequest(request.id);
    toast('Request cancelled.', { type: 'success' });
  } catch (error) { errorToast(error); }
}

async function removeFriend(user) {
  const sure = await confirmDialog({ title: 'Remove ' + nameOf(user) + '?', body: 'You can add them again later.', confirmLabel: 'Remove', danger: true });
  if (!sure) return;
  try {
    await Api.removeFriend(user.id);
    toast('Removed.', { type: 'success' });
  } catch (error) { errorToast(error); }
}

async function block(user) {
  const sure = await confirmDialog({
    title: 'Block ' + nameOf(user) + '?',
    body: 'They cannot message you or add you as a friend, and you will not see their messages.',
    confirmLabel: 'Block',
    danger: true,
  });
  if (!sure) return;
  try {
    await Api.blockUser(user.id, '');
    toast('Blocked.', { type: 'success' });
  } catch (error) { errorToast(error); }
}

async function unblock(user) {
  try {
    await Api.unblockUser(user.id);
    toast('Unblocked.', { type: 'success' });
  } catch (error) { errorToast(error); }
}

// Blocking is the viewer's own list, not a property of the user, so it is read
// before the entry is drawn rather than assumed from whatever was on screen.
async function isBlocked(user) {
  try {
    const list = await Api.blocks();
    return (list || []).some((entry) => String(entry.userId || entry.user_id || entry.id || (entry.user && entry.user.id)) === String(user.id));
  } catch {
    return false;
  }
}

async function copyUsername(user) {
  const handle = user.username ? '@' + user.username : nameOf(user);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(handle);
    toast('Username copied.', { type: 'success' });
  } catch {
    toast(handle, { type: 'info' });
  }
}

// A report needs a reason; the words are what a moderator reads first, and the
// person reported is never told who filed it.
function openReportDialog(user) {
  const reason = el('select', { class: 'input', 'aria-label': 'Reason' }, ...[
    ['harassment', 'Harassment or abuse'],
    ['spam', 'Spam or a scam'],
    ['impersonation', 'Pretending to be someone else'],
    ['other', 'Something else'],
  ].map(([value, label]) => el('option', { value }, label)));

  const detail = el('textarea', {
    class: 'input', rows: '4', maxlength: '2000',
    placeholder: 'What happened? Anything you add helps the person reading this.',
  });

  const cancel = el('button', { class: 'btn btn--ghost', type: 'button' }, 'Cancel');
  const send = el('button', { class: 'btn btn--primary', type: 'button' }, 'Send report');

  const body = el('div', { class: 'settings-section' },
    el('p', { class: 'page-sub' }, 'This goes to the people who moderate this instance. ' + nameOf(user) + ' is not told who filed it.'),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Reason'), reason),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'What happened'), detail));

  const dialog = openDialog({ title: 'Report ' + nameOf(user), foot: [cancel, send] });
  dialog.element.insertBefore(body, dialog.element.querySelector('.dialog-foot'));
  cancel.addEventListener('click', () => dialog.close());
  send.addEventListener('click', async () => {
    send.disabled = true;
    try {
      await Api.reports({
        targetType: 'user',
        targetId: user.id,
        reason: reason.value,
        description: detail.value.trim(),
      });
      dialog.close();
      toast('Report sent. Thank you.', { type: 'success' });
    } catch (error) {
      errorToast(error);
      send.disabled = false;
    }
  });
}

// -- the list ----------------------------------------------------------------
//
// Async because the block entry reads the viewer's block list before it is drawn.

export async function userMenuItems(raw, options) {
  const opts = options || {};
  const user = normalizeUser(raw) || raw;
  const items = [];
  if (!user || user.id === undefined || user.id === null) return items;

  const name = nameOf(user);

  if (isSelf(user)) {
    items.push({ header: name + ' (you)' });
    items.push({ label: 'Your profile', icon: 'user', onSelect: () => navigate('/users/' + user.id) });
    items.push({ label: 'Account settings', icon: 'settings', onSelect: () => navigate('/settings') });
  } else {
    items.push({ header: name });
    items.push({ label: 'View profile', icon: 'user', onSelect: () => navigate('/users/' + user.id) });
    items.push({ label: 'Send a message', icon: 'message', onSelect: () => message(user) });

    const relation = friendshipWith(user.id);
    if (relation === 'friend') {
      items.push({ label: 'Remove friend', icon: 'user-minus', onSelect: () => removeFriend(user) });
    } else if (relation === 'outgoing') {
      items.push({ label: 'Cancel friend request', icon: 'x', onSelect: () => cancelFriend(user) });
    } else if (relation === 'incoming') {
      items.push({ label: 'Accept friend request', icon: 'check', onSelect: () => acceptFriend(user) });
    } else {
      items.push({ label: 'Add friend', icon: 'user-plus', onSelect: () => addFriend(user) });
    }
  }

  items.push({ separator: true });
  items.push({ label: 'Copy username', icon: 'copy', onSelect: () => copyUsername(user) });

  if (!isSelf(user)) {
    items.push({ label: 'Report', icon: 'flag', onSelect: () => openReportDialog(user) });
    items.push((await isBlocked(user))
      ? { label: 'Unblock', icon: 'check', onSelect: () => unblock(user) }
      : { label: 'Block', icon: 'x', danger: true, onSelect: () => block(user) });
  }

  // Whatever the caller knows that this module does not - for a member row, the
  // moderation actions the community's permission list allows.
  if (opts.extra && opts.extra.length) {
    items.push({ separator: true });
    for (const entry of opts.extra) items.push(entry);
  }

  return items;
}

// Open the menu under a control, the way a "More" button does.
export async function openUserMenu(anchor, raw, options) {
  const items = await userMenuItems(raw, options);
  if (items.length) openMenu({ anchor, items, align: (options && options.align) || 'right' });
}

// Open it at a point: right-click on a desk, long press on a phone.
export function attachUserMenu(node, raw, options) {
  attachContextMenu(node, () => userMenuItems(raw, options), options);
}

export default { userMenuItems, openUserMenu, attachUserMenu, isSelf };

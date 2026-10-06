// Entry point for the direct-messages pages: the conversation list, and the
// routing between it and a thread. The thread itself and the friends page are
// separate modules - see dm-thread.js and friends.js.


import { errorState } from '../view-states.js';
import State, { refreshDms } from '../state.js';
import { el, clear, plural } from '../ui.js';
import { emptyState } from '../components.js';
import { renderContextHeader } from '../shell.js';
import { renderDmThread, leaveDm } from './dm-thread.js';
import { renderFriends } from './friends.js';




async function renderDmList(container) {
  clear(container);
  renderContextHeader({ title: 'Direct messages', sub: 'People you talk to' });
  // The sidebar beside this already carries the filter, the New message action and
  // the list of conversations. Repeating all three in the workspace put the same
  // words on screen twice - the sidebar head said 'Direct messages / Your
  // conversations', the context header said it again, and 'No conversations yet'
  // appeared in both places at once.
  //
  // So the workspace carries the thread, and when there is nothing yet it says how
  // to start one. Picking a conversation is the sidebar's job and stays there.
  const wrap = el('div', { class: 'page page--quiet' });
  // State.dms is the last known list, so a failed refresh can still fall back to
  // it. What it cannot do is fall back to the empty state below and claim there
  // are no conversations: on a cold load that cache is empty too, and the
  // reader is told to go and start a conversation they may already have nine of.
  let dms = State.dms;
  let loadFailed = false;
  try {
    dms = await refreshDms();
  } catch {
    loadFailed = !(dms && dms.length);
  }
  dms = dms || [];

  if (!dms.length && loadFailed) {
    wrap.appendChild(errorState('Could not load your conversations.', () => renderDmList(container)));
  } else if (!dms.length) {
    wrap.appendChild(emptyState('mail', 'Nobody to talk to yet',
      'Open someone\'s profile in a community and send them a message, or add a friend and start from there.'));
  } else {
    // The list is beside this. Saying so beats leaving an empty pane that reads as
    // a page that failed to load.
    wrap.appendChild(el('div', { class: 'page-hint' },
      plural(dms.length, 'conversation') + ' - pick one from the list beside this.'));
  }
  container.appendChild(wrap);
}

// The router hands /dms here with or without an id.
export async function renderDms(container, { id } = {}) {
  // Named rather than blank: an empty header falls back to the product name, so for as
  // long as a thread takes to arrive the page claims to be called Trycord. The thread
  // replaces this with the peer's name once it has them.
  renderContextHeader({ title: 'Direct messages' });
  if (!id) return renderDmList(container);
  return renderDmThread(container, id);
}

export async function renderFriendsPage(container) {
  return renderFriends(container);
}

export { leaveDm };

export default { renderDms, renderFriendsPage, leaveDm };

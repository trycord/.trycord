// The panels around a direct conversation.
//
// Search, pinned messages and the settings of a group are three views onto the
// same conversation. They live here rather than in dms.js because each one is a
// dialog with its own lifetime and its own realtime subscription, and keeping
// the conversation page concerned with the timeline is what makes it readable.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { EVENTS, on } from '../../packages/realtime.js';
import {
  State, nameOf, dmName, dmPeople, refreshDms,
} from '../../packages/store.js';
import { avatar } from '../ui/primitives.js';
import { card, row, memo, blank, hold, fault, stamp } from '../ui/page.js';
import * as encrypted from '../ui/encrypted.js';
import {
  openDialog, confirmDialog, errorToast, toast,
} from '../ui/overlays.js';

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member' };

function groupFace(dm, size) {
  return avatar({
    id: dm.id,
    displayName: dmName(dm),
    avatarUrl: dm.avatarUrl || null,
  }, { size: size || 'lg', rounded: true });
}

function roleChip(role) {
  return el('span', {
    class: 'chip chip--quiet',
    title: 'Role in this group',
  }, ROLE_LABEL[role] || 'Member');
}

function contentLine(hit) {
  const text = String(hit.content || '').replace(/\s+/g, ' ').trim();
  if (hit.unreadable) return text || 'A message this device cannot read.';
  return text || 'An attachment.';
}

// A clickable row that is a div, because pins and search hits carry their own
// button at the trailing edge. The row kit's button form would nest one button
// inside another.
function hitRow(hit, options) {
  const opts = options || {};
  const line = row({
    lead: avatar({
      id: hit.authorId,
      displayName: hit.authorName,
      avatarUrl: hit.authorAvatarUrl || hit.authorAvatar || null,
    }, { size: 'sm', rounded: true }),
    title: hit.authorName || 'Someone',
    sub: contentLine(hit),
    meta: stamp(hit.createdAt || hit.created_at || hit.pinnedAt),
    side: opts.side || null,
  });
  line.setAttribute('role', 'button');
  line.tabIndex = 0;
  const open = async () => {
    if (!opts.onOpen) return;
    try {
      await opts.onOpen(hit);
    } catch (error) { errorToast(error); }
  };
  line.addEventListener('click', open);
  line.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    open();
  });
  return line;
}

// -- search -------------------------------------------------------------------

export function openSearch(conversationId, opts) {
  const options = opts || {};
  const input = el('input', {
    class: 'input', type: 'search', placeholder: 'Search this conversation',
    'aria-label': 'Search this conversation',
  });
  const results = el('div', { class: 'rowlist' });
  const note = el('p', { class: 'form-note' },
    'Type at least two characters. Messages in encrypted conversations are not searchable on the server.');
  const body = el('div', { class: 'fold fold--tight' }, input, note, results);
  const layer = openDialog({ title: 'Search messages', wide: true, body });
  let generation = 0;
  let timer = 0;

  const search = async () => {
    const q = String(input.value || '').trim();
    generation += 1;
    const mine = generation;
    if (q.length < 2) {
      results.replaceChildren();
      note.textContent = 'Type at least two characters. Messages in encrypted conversations are not searchable on the server.';
      return;
    }
    results.replaceChildren(hold('Searching this conversation'));
    try {
      const hits = await Api.dmSearch(conversationId, q, 30);
      if (mine !== generation) return;
      if (!hits.length) {
        results.replaceChildren(blank({
          glyph: 'search',
          title: 'No messages match',
          text: 'Search reads the text of messages this server can read. Encrypted messages are not in that set.',
        }));
        return;
      }
      note.textContent = hits.length === 1 ? 'One message' : hits.length + ' messages';
      results.replaceChildren(...hits.map((hit) => hitRow(hit, {
        onOpen: async (entry) => {
          const revealed = options.onJump ? await options.onJump(entry) : false;
          if (revealed) layer.close();
          else toast('That message is not in this page of the conversation.', { type: 'error' });
        },
      })));
    } catch (error) {
      if (mine !== generation) return;
      results.replaceChildren(fault(error, search));
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, 240);
  });
  setTimeout(() => input.focus(), 30);
  return layer;
}

// -- pinned messages ----------------------------------------------------------

export function openPins(conversationId, opts) {
  const options = opts || {};
  const list = el('div', { class: 'rowlist' });
  const body = el('div', { class: 'fold fold--tight' }, list);
  let stopPinned = () => {};
  let stopUnpinned = () => {};
  const layer = openDialog({
    title: 'Pinned messages',
    wide: true,
    body,
    onClose: () => {
      closed = true;
      stopPinned();
      stopUnpinned();
    },
  });
  let closed = false;
  let generation = 0;

  const load = async () => {
    generation += 1;
    const mine = generation;
    list.replaceChildren(hold('Reading the pins'));
    try {
      const pins = await Api.dmPins(conversationId);
      const rows = await encrypted.readRows(pins, conversationId);
      if (closed || mine !== generation) return;
      if (!rows.length) {
        list.replaceChildren(blank({
          glyph: 'pin',
          title: 'Nothing pinned yet',
          text: 'Pin a message from its menu to keep it within reach.',
        }));
        return;
      }
      list.replaceChildren(...rows.map((pin) => {
        const unpin = el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onClick: async (event) => {
            event.stopPropagation();
            try {
              await Api.unpinDm(conversationId, pin.id);
              await load();
              toast('Unpinned');
            } catch (error) { errorToast(error); }
          },
        }, 'Unpin');
        return hitRow(pin, {
          side: unpin,
          onOpen: async (entry) => {
            const revealed = options.onJump ? await options.onJump(entry) : false;
            if (revealed) layer.close();
            else toast('That message is not in this page of the conversation.', { type: 'error' });
          },
        });
      }));
    } catch (error) {
      if (closed || mine !== generation) return;
      list.replaceChildren(fault(error, load));
    }
  };

  const reload = () => { if (!closed) load().catch(() => {}); };
  stopPinned = on(EVENTS.DM_PINNED, (event) => {
    if (String(event.conversationId) === String(conversationId)) reload();
  });
  stopUnpinned = on(EVENTS.DM_UNPINNED, (event) => {
    if (String(event.conversationId) === String(conversationId)) reload();
  });
  load();
  return {
    close() { layer.close(); },
    element: layer.element,
  };
}

// -- group settings -----------------------------------------------------------

export function openGroupSettings(conversationId, opts) {
  const options = opts || {};
  let dm = options.dm || null;
  let closed = false;
  let invited = new Set();

  const body = el('div', { class: 'fold fold--tight' });
  const layer = openDialog({
    title: 'Group settings',
    wide: true,
    body,
    onClose: () => {
      closed = true;
      stopConversation();
    },
  });

  const isSelf = (person) => String(person.id) === String(State.user && State.user.id);

  const reload = async () => {
    const next = await Api.dm(conversationId);
    if (closed) return;
    dm = next;
    paint();
    if (options.onChanged) options.onChanged(next);
  };

  const apply = async (work, message) => {
    try {
      await work();
      if (message) toast(message);
      await reload();
      refreshDms().catch(() => {});
    } catch (error) { errorToast(error); }
  };

  const uploadAvatar = async (file) => {
    if (!file) return;
    await apply(async () => {
      await Api.uploadDmGroupAvatar(conversationId, file);
    }, 'Group picture changed');
  };

  const paint = () => {
    if (!dm) {
      body.replaceChildren(hold('Reading the group'));
      return;
    }
    const perms = dm.permissions || {};
    const people = dm.people || dm.members || [];
    const me = people.find(isSelf) || null;
    const cards = [];

    // The picture is identity; the name is what the group is called. Both are
    // changed here because both are the same kind of shared thing.
    const identityRows = el('div', { class: 'rowlist' });
    identityRows.appendChild(row({
      lead: groupFace(dm, 'lg'),
      title: dmName(dm),
      sub: String(people.length) + (people.length === 1 ? ' person' : ' people'),
      side: perms.canChangeAvatar
        ? (() => {
          const input = el('input', {
            type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp',
            'aria-label': 'Upload a group picture',
          });
          input.hidden = true;
          input.addEventListener('change', () => {
            uploadAvatar(input.files && input.files[0]).catch(() => {});
            input.value = '';
          });
          const tools = el('span', { class: 'rowmeta-pair' });
          tools.appendChild(el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: () => input.click(),
          }, icon('image', { size: 14 }), dm.avatarUrl ? 'Replace picture' : 'Add picture'));
          if (dm.avatarUrl) {
            tools.appendChild(el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              onClick: () => apply(() => Api.removeDmGroupAvatar(conversationId), 'Group picture removed'),
            }, 'Remove'));
          }
          tools.appendChild(input);
          return tools;
        })()
        : null,
    }));

    if (perms.canRename) {
      const nameInput = el('input', {
        class: 'input', type: 'text', value: dmName(dm), maxlength: '120',
        'aria-label': 'The name of this group',
      });
      identityRows.appendChild(el('div', { class: 'rowlist' },
        row({
          title: el('span', { class: 'rowmeta-pair' }, nameInput,
            el('button', {
              class: 'btn btn--default btn--sm', type: 'button',
              onClick: () => {
                const name = String(nameInput.value || '').trim();
                if (!name) { toast('A group needs a name.', { type: 'error' }); return; }
                apply(() => Api.renameDmGroup(conversationId, name), 'Group renamed');
              },
            }, 'Save name')),
        })));
    }
    cards.push(card({ label: 'Name and picture', glyph: 'image', body: identityRows }));

    const memberRows = el('div', { class: 'rowlist' });
    for (const person of people) {
      const self = isSelf(person);
      const tools = el('span', { class: 'rowmeta-pair' }, roleChip(person.role));
      if (perms.canPromoteMembers && !self && person.role !== 'owner') {
        tools.appendChild(el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onClick: () => apply(
            () => Api.setDmGroupRole(conversationId, person.id, person.role === 'admin' ? 'member' : 'admin'),
            person.role === 'admin' ? 'Admin made a member' : 'Member made an admin'
          ),
        }, person.role === 'admin' ? 'Make member' : 'Make admin'));
      }
      if (perms.canTransferOwnership && !self && person.role !== 'owner') {
        tools.appendChild(el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onClick: async () => {
            const yes = await confirmDialog({
              title: 'Hand this group to ' + (nameOf(person) || person.username) + '?',
              body: 'They become the owner. You stay in the group as an admin.',
              confirmLabel: 'Make owner',
            });
            if (yes) {
              apply(
                () => Api.transferDmGroup(conversationId, person.id),
                nameOf(person) + ' is now the owner'
              );
            }
          },
        }, 'Make owner'));
      }
      const removable = perms.canRemoveMembers && !self && person.role !== 'owner'
        && !(person.role === 'admin' && dm.myRole !== 'owner');
      if (removable) {
        tools.appendChild(el('button', {
          class: 'btn btn--danger btn--sm', type: 'button',
          onClick: async () => {
            const yes = await confirmDialog({
              title: 'Remove ' + (nameOf(person) || person.username) + '?',
              body: 'They stop receiving messages in this group. They can be invited again.',
              confirmLabel: 'Remove',
              danger: true,
            });
            if (yes) {
              apply(
                () => Api.removeDmGroupMember(conversationId, person.id),
                nameOf(person) + ' was removed'
              );
            }
          },
        }, 'Remove'));
      }
      memberRows.appendChild(row({
        lead: avatar(person, { size: 'sm', rounded: true, presence: person.presence || null }),
        title: nameOf(person) + (self ? ' (you)' : ''),
        sub: '@' + (person.username || ''),
        side: tools,
      }));
    }
    cards.push(card({
      label: 'Members', glyph: 'users', note: String(people.length), body: memberRows,
    }));

    if (perms.canAddMembers) {
      const taken = new Set(people.map((person) => String(person.id)));
      const candidates = (State.friends || []).filter((friend) => !taken.has(String(friend.id)));
      const candidateRows = el('div', { class: 'rowlist' });
      if (!candidates.length) {
        candidateRows.appendChild(el('p', { class: 'form-note' },
          'Nobody on your friends list is outside this group. Add a friend first, or share an invitation from another conversation.'));
      } else {
        for (const friend of candidates) {
          const tools = el('span', { class: 'rowmeta-pair' });
          if (invited.has(String(friend.id))) {
            tools.appendChild(el('span', { class: 'chip chip--quiet' }, 'Invited'));
          } else {
            tools.appendChild(el('button', {
              class: 'btn btn--default btn--sm', type: 'button',
              onClick: () => {
                apply(async () => {
                  await Api.inviteDmGroup(conversationId, friend.id);
                  invited.add(String(friend.id));
                }, 'Invitation sent to ' + nameOf(friend));
              },
            }, 'Invite'));
          }
          tools.appendChild(el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: () => apply(
              () => Api.addDmGroupMember(conversationId, friend.id),
              nameOf(friend) + ' is in the group'
            ),
          }, 'Add directly'));
          candidateRows.appendChild(row({
            lead: avatar(friend, { size: 'sm', rounded: true }),
            title: nameOf(friend),
            sub: '@' + (friend.username || ''),
            side: tools,
          }));
        }
      }
      cards.push(card({ label: 'Invite somebody', glyph: 'user-plus', body: candidateRows }));
    }

    const leaveText = perms.canLeave
      ? 'You will stop receiving new messages here. The conversation leaves your list.'
      : 'You own this group. Make somebody else the owner before you leave.';
    cards.push(memo({
      tone: perms.canLeave ? 'warning' : 'info',
      title: 'Leaving this group',
      text: leaveText,
      actions: perms.canLeave
        ? el('button', {
          class: 'btn btn--danger btn--sm', type: 'button',
          onClick: async () => {
            const yes = await confirmDialog({
              title: 'Leave this group?',
              body: 'You will stop receiving new messages here.',
              confirmLabel: 'Leave group', danger: true,
            });
            if (!yes) return;
            try {
              await Api.leaveDmGroup(conversationId);
              layer.close();
              if (options.onLeft) options.onLeft();
            } catch (error) { errorToast(error); }
          },
        }, 'Leave group')
        : (me && me.role === 'owner'
          ? el('span', { class: 'form-note' }, 'You are the owner.')
          : null),
    }));

    body.replaceChildren(...cards);
  };

  const stopConversation = on(EVENTS.DM_CONVERSATION_UPDATED, (event) => {
    if (String(event.conversationId) !== String(conversationId) || closed) return;
    reload().catch(() => {});
  });

  paint();
  reload().catch((error) => {
    if (!closed) body.replaceChildren(fault(error, () => reload()));
  });
  return {
    close() { layer.close(); },
    element: layer.element,
  };
}

// Direct messages.
//
// Two pages in one module: the list of conversations and one conversation open.
// The conversation page is the surface the reader spends hours in - the timeline
// and composer come from the shared engine in ui/chat.js; this file owns the
// transport, the realtime wiring and the rest of the page around it.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { EVENTS, on, joinDm, leaveDm } from '../../packages/realtime.js';
import {
  State, emit, nameOf, dmPeer, dmName, dmPeople, refreshDms, presenceOf, on as onStore,
} from '../../packages/store.js';
import { path, navigate } from '../../packages/nav.js';
import { avatar } from '../ui/primitives.js';
import { head, card, row, blank, fault, fold, stamp } from '../ui/page.js';
import { conversationSurface, asMessage } from '../ui/chat.js';
import * as encrypted from '../ui/encrypted.js';
import { personSheetEntries } from '../ui/person.js';
import { errorToast, toast, openDialog } from '../ui/overlays.js';

// -- the list -----------------------------------------------------------------

const lastLine = (dm) => {
  const last = dm.lastMessage;
  if (!last) return 'No messages here yet';
  const who = String(last.authorId) === String(State.user && State.user.id)
    ? 'You'
    : (last.authorName || '').split(' ')[0];
  return (who ? who + ': ' : '') + (last.content || 'an attachment');
};

// A conversation with more than two people in it.
//
// The people have to be somebody the reader can open a conversation with, so
// the list offered here is the reader's friends. The server applies the
// same gate again when the group is created, because the client is not the
// authority on who may talk to whom.
function newGroup() {
  const friends = (State.friends || []).slice();
  if (!friends.length) {
    toast('Open a friend first: a group is a conversation with more than one person in it.', { type: 'error' });
    return;
  }
  const name = el('input', {
    class: 'input', type: 'text', placeholder: 'What is this conversation about?',
    'aria-label': 'The name of this group',
  });
  const chosen = new Set();
  const list = el('div', { class: 'rowlist' });
  const count = el('p', { class: 'form-note' }, '');

  const paint = () => {
    count.textContent = chosen.size
      ? String(chosen.size) + ' chosen'
      : 'Choose who is in it.';
    list.replaceChildren(...friends.map((friend) => el('button', {
      class: 'cardrow cardrow--link' + (chosen.has(String(friend.id)) ? ' is-active' : ''),
      type: 'button',
      'aria-pressed': chosen.has(String(friend.id)) ? 'true' : 'false',
      onClick: () => {
        const id = String(friend.id);
        if (chosen.has(id)) chosen.delete(id);
        else chosen.add(id);
        paint();
      },
    },
    el('span', { class: 'cardrow-main' },
      el('span', { class: 'cardrow-title' }, nameOf(friend)),
      el('span', { class: 'cardrow-sub' }, '@' + (friend.username || ''))))));
  };
  paint();

  const layer = openDialog({
    title: 'New group',
    body: el('div', { class: 'fold fold--tight' }, name, count, list),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Create', primary: true,
        onSelect: async () => {
          const title = String(name.value || '').trim();
          if (!title) { toast('A group needs a name.', { type: 'error' }); return; }
          if (!chosen.size) { toast('Choose who is in it.', { type: 'error' }); return; }
          try {
            const group = await Api.createDmGroup({ name: title, userIds: [...chosen] });
            layer.close();
            await refreshDms();
            toast('The group is ready');
            navigate('/dms/' + group.id);
          } catch (error) { errorToast(error); }
        },
      },
    ],
  });
  setTimeout(() => name.focus(), 0);
  return layer;
}

export function renderDms() {
  const body = el('div', { class: 'rowlist' });
  const countNote = el('span', { class: 'cardhead-note' }, '');
  const listCard = card({ label: 'Conversations', glyph: 'message', note: countNote, body, flush: true });
  let ready = false;

  const paint = () => {
    const conversations = (State.dms || []).slice()
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    countNote.textContent = ready
      ? conversations.length + (conversations.length === 1 ? ' conversation' : ' conversations')
      : '';
    // Until the first read has answered, an empty store means "not asked yet",
    // not "you have none" - the hold stand in, and the real list (or the honest
    // empty state) only paints after the answer.
    if (!conversations.length) {
      if (!ready) {
        body.replaceChildren(el('p', { class: 'holdline' }, 'Reading the direct messages'));
        return;
      }
      body.replaceChildren(blank({
        glyph: 'message',
        title: 'No conversations yet',
        text: 'Open a friend and start the first exchange; it gathers here.',
      }));
      return;
    }
    body.replaceChildren(...conversations.map((dm) => {
      const peer = dmPeer(dm);
      // A group is called by its name, and a conversation of two people by
      // the other person's name. A group has no single person on the other
      // side, so the face beside it is the group's.
      const name = dmName(dm);
      const group = !!dm.isGroup;
      const pair = el('span', { class: 'rowmeta-pair' },
        dm.updatedAt ? el('span', { class: 'rowstamp' }, stamp(dm.updatedAt)) : null,
        dm.unreadCount ? el('span', {
          class: 'badge badge--count', 'aria-label': dm.unreadCount + ' unread',
        }, String(dm.unreadCount)) : null);
      return row({
        lead: group
          ? el('span', { class: 'avatar avatar--lg avatar--rounded', title: name }, icon('users', { size: 18 }))
          : avatar(peer, {
            size: 'lg', rounded: true,
            presence: peer ? presenceOf(peer.id) : 'offline',
          }),
        title: name,
        sub: group
          ? (String(dm.memberCount || 0) + ' people · ' + lastLine(dm))
          : lastLine(dm),
        href: path('/dms/' + dm.id),
        link: true,
        meta: pair,
        // A conversation is one of the things a person can be asked for, so the
        // row carries that person's menu on a right-click. A group has no one
        // person to ask for, so it carries none.
        menu: peer ? () => personSheetEntries(peer) : null,
      });
    }));
  };

  paint();
  if ((State.dms || []).length) {
    // Cached rows give the reader somewhere to land instantly; the refresh that
    // follows only replaces them when it returns something different.
    refreshDms().then(() => paint()).catch(() => {});
  }

  // A conversation read elsewhere clears its badge without a reload.
  const offDms = onStore('dms', paint);

  return {
    node: fold([
      (() => {
        const banner = head({
          kicker: 'Direct',
          title: 'Direct messages',
          lede: 'One-to-one conversations, the newest activity first.',
          actions: el('div', { class: 'pagehead-actions' },
            el('button', {
              class: 'btn btn--default', type: 'button',
              onClick: () => navigate('/friends'),
            }, icon('plus', { size: 15 }), 'New conversation'),
            el('button', {
              class: 'btn btn--default', type: 'button',
              onClick: () => newGroup(),
            }, icon('users', { size: 15 }), 'New group')),
        });
        banner.classList.add('hero');
        return banner;
      })(),
      listCard,
    ]),
    onMount: async () => {
      try {
        await refreshDms();
        ready = true;
        paint();
      } catch (e) {
        body.replaceChildren(fold([fault(e, null)]));
      }
    },
    cleanup() { offDms(); },
  };
}

// -- one conversation ---------------------------------------------------------

export function renderDmConversation(ctx) {
  const conversationId = ctx.params.id;
  const cached = (State.dms || []).find((d) => d.id === conversationId) || null;
  const cachedPeer = dmPeer(cached);
  const cachedName = cachedPeer ? nameOf(cachedPeer) : 'Direct message';

  const headNode = head({
    kicker: 'Direct',
    title: cachedName,
    lede: 'A conversation between the two of you.',
    actions: null,
  });

  const surface = conversationSurface({
    kind: 'dm',
    scopeId: conversationId,
    composerLabel: 'Message @' + (cachedPeer ? nameOf(cachedPeer) : 'this conversation'),
    composerHint: 'Message @' + (cachedPeer ? nameOf(cachedPeer) : 'this conversation'),
    threadOf: (messageId) => Api.thread('dm', conversationId, messageId),
    loadOlder: async (anchor) => {
      const page = await Api.dmMessages(conversationId, { before: anchor, limit: 40 });
      return { messages: Array.isArray(page) ? page : (page && page.messages) || [] };
    },
    send: (payload) => encrypted.send(conversationId, payload, (body) => Api.sendDm(conversationId, body)),
    // The backend has always accepted an attachment on a direct message; the
    // composer simply never offered one.
    upload: (file, onProgress) => encrypted.upload(
      conversationId,
      file,
      (plainFile) => Api.uploadDmAttachment(conversationId, plainFile, onProgress),
    ).then((out) => { if (onProgress) onProgress(1); return out; }),
    edit: (messageId, content) => Api.updateDm(conversationId, messageId, { content }),
    del: (messageId) => Api.deleteDm(conversationId, messageId),
    reactTo: (messageId, emoji) => Api.reactDm(conversationId, messageId, emoji),
    unreactFrom: (messageId, emoji) => Api.unreactDm(conversationId, messageId, emoji),
    copyHref: () => path('/dms/' + conversationId),
  });

  // The page is rebuilt when recovery needs the fault swapped for the working
  // surface again; the pieces themselves are the engine's and survive the swap.
  const buildStructure = () => el('div', { class: 'convo-page' },
    el('div', { class: 'convo-scroll' }, surface.node),
    surface.typing,
    surface.composer.node);
  const host = el('div', { class: 'convo-host' }, buildStructure());

  let readMarked = false;
  const markRead = () => {
    if (readMarked) return;
    readMarked = true;
    Api.dmRead(conversationId).then(() => {
      const dm = (State.dms || []).find((d) => d.id === conversationId);
      if (dm && dm.unreadCount) {
        dm.unreadCount = 0;
        emit('dms', State.dms);
      }
    }).catch(() => { /* the badge is corrected by the next list read */ });
  };

  const paintFault = (error) => {
    surface.cleanup();
    host.replaceChildren(fold([
      headNode,
      fault(error, () => {
        host.replaceChildren(buildStructure());
        open();
      }),
    ]));
  };

  // The header of the conversation.
  //
  // A conversation of two people shows the other person's name and a way to
  // their profile. A group shows its own name, who is in it, and the two
  // things a reader can do about it: rename it, and add somebody to it.
  const paintPeer = (dm) => {
    const peer = dmPeer(dm) || dm.peer || null;
    const group = !!dm.isGroup;
    const name = group ? dmName(dm) : (peer ? nameOf(peer) : 'Direct message');
    const people = dmPeople(dm);

    const actions = group
      ? el('div', { class: 'pagehead-actions' },
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onClick: () => renameGroup(dm),
        }, icon('edit', { size: 15 }), 'Rename'),
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onClick: () => addToGroup(dm),
        }, icon('user-plus', { size: 15 }), 'Add somebody'))
      : el('a', {
        class: 'btn btn--ghost btn--sm',
        href: peer ? path('/users/' + peer.id) : path('/friends'),
      }, icon('user', { size: 15 }), 'Profile');

    const old = headNode.querySelector('.pagehead-actions');
    if (old) old.remove();
    headNode.appendChild(actions);
    const title = headNode.querySelector('.pagehead-title');
    if (title) title.textContent = name;
    const lede = headNode.querySelector('.pagehead-lede');
    if (lede) {
      lede.textContent = group
        ? (String(people.length) + ' people: '
          + (people.length ? people.map((person) => nameOf(person)).join(', ') : 'nobody else yet')
          + '.')
        : (peer && peer.presence === 'online'
          ? 'Here now.'
          : 'A conversation between the two of you.');
    }
    const ta = surface.composer.node.querySelector('textarea');
    if (ta) {
      const target = group ? name : (peer ? nameOf(peer) : null);
      if (target) {
        ta.setAttribute('aria-label', 'Message ' + (group ? name : '@' + target));
        ta.placeholder = 'Message ' + (group ? name : '@' + target);
      }
    }
  };

  // Rename a group.
  const renameGroup = async (dm) => {
    const input = el('input', {
      class: 'input', type: 'text', value: dm.name || '',
      'aria-label': 'The name of this group',
    });
    const layer = openDialog({
      title: 'Rename this group',
      body: el('div', { class: 'fold fold--tight' }, input),
      actions: [
        { label: 'Cancel' },
        {
          label: 'Save', primary: true,
          onSelect: async () => {
            const name = String(input.value || '').trim();
            if (!name) return;
            try {
              await Api.renameDmGroup(dm.id, name);
              toast('Renamed');
              await open();
            } catch (error) { errorToast(error); }
          },
        },
      ],
    });
    setTimeout(() => input.focus(), 0);
    return layer;
  };

  // Somebody joins a group.
  const addToGroup = async (dm) => {
    const people = dmPeople(dm);
    const taken = new Set(people.map((person) => String(person.id)));
    const candidates = (State.friends || []).filter((friend) => !taken.has(String(friend.id)));
    if (!candidates.length) {
      toast('There is nobody to add. Open a friend first.', { type: 'error' });
      return;
    }
    const list = el('div', { class: 'rowlist' });
    for (const candidate of candidates) {
      list.appendChild(el('button', {
        class: 'cardrow cardrow--link', type: 'button',
        onClick: async () => {
          try {
            await Api.addDmGroupMember(dm.id, candidate.id);
            toast(nameOf(candidate) + ' is in it now');
            layer.close();
            await open();
          } catch (error) { errorToast(error); }
        },
      },
      el('span', { class: 'cardrow-main' },
        el('span', { class: 'cardrow-title' }, nameOf(candidate)),
        el('span', { class: 'cardrow-sub' }, '@' + (candidate.username || '')))));
    }
    const layer = openDialog({
      title: 'Add somebody',
      body: el('div', { class: 'fold fold--tight' }, list),
    });
    return layer;
  };

  let openGeneration = 0;
  const open = async () => {
    openGeneration += 1;
    const mine = openGeneration;
    try {
      const dm = await Api.dm(conversationId);
      if (!dm || !dm.id) {
        throw { code: 'NOT_FOUND', message: 'This conversation does not exist, or you are not in it.' };
      }
      if (mine !== openGeneration) return;
      if (!host.querySelector('.convo-page')) host.replaceChildren(buildStructure());
      paintPeer(dm);
      // The rows are opened before they are drawn: an encrypted row carries no
      // text from the server, so it has to be opened here or it is drawn as an
      // empty message.
      const rows = await encrypted.readRows(dm.messages || [], conversationId);
      if (mine !== openGeneration) return;
      surface.api.paint(rows.map(asMessage),
        { hasOlder: rows.length >= 50 });
      surface.wireScroller();
      joinDm(conversationId);
      markRead();
    } catch (e) {
      if (mine !== openGeneration) return;
      paintFault(e);
    }
  };

  const unsubs = [
    // The row is opened before it is shown. An encrypted message arrives as
    // an envelope with no text, and the text is in the envelope - so a row
    // that is drawn as it arrives is an empty bubble.
    on(EVENTS.DM_MESSAGE, async (event) => {
      if (String(event.conversationId) !== String(conversationId)) return;
      surface.api.created(await encrypted.readRow(event, conversationId));
    }),
    on(EVENTS.DM_MESSAGE_UPDATED, async (event) => {
      if (String(event.conversationId) !== String(conversationId)) return;
      surface.api.updated(await encrypted.readRow(event, conversationId));
    }),
    on(EVENTS.DM_MESSAGE_EMBEDS, (event) => {
      if (String(event.conversationId) !== String(conversationId)) return;
      surface.api.embeds(event.messageId, event.embeds || []);
    }),
    on(EVENTS.DM_TYPING, (event) => {
      if (String(event.conversationId) !== String(conversationId)) return;
      surface.api.typing(event.username || 'Someone');
    }),
  ];

  return {
    node: host,
    onMount: open,
    cleanup() {
      openGeneration += 1;
      for (const off of unsubs) off();
      leaveDm();
      surface.cleanup();
    },
  };
}

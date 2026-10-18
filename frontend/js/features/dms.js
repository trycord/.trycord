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
  State, emit, nameOf, dmPeer, refreshDms, presenceOf,
} from '../../packages/store.js';
import { path, navigate } from '../../packages/nav.js';
import { avatar } from '../ui/primitives.js';
import { head, card, row, blank, fault, fold, stamp } from '../ui/page.js';
import { conversationSurface, asMessage } from '../ui/chat.js';

// -- the list -----------------------------------------------------------------

const lastLine = (dm) => {
  const last = dm.lastMessage;
  if (!last) return 'No messages here yet';
  const who = String(last.authorId) === String(State.user && State.user.id)
    ? 'You'
    : (last.authorName || '').split(' ')[0];
  return (who ? who + ': ' : '') + (last.content || 'an attachment');
};

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
      const name = peer ? nameOf(peer) : 'Conversation';
      const pair = el('span', { class: 'rowmeta-pair' },
        dm.updatedAt ? el('span', { class: 'rowstamp' }, stamp(dm.updatedAt)) : null,
        dm.unreadCount ? el('span', {
          class: 'badge badge--count', 'aria-label': dm.unreadCount + ' unread',
        }, String(dm.unreadCount)) : null);
      return row({
        lead: avatar(peer, {
          size: 'lg', rounded: true,
          presence: peer ? presenceOf(peer.id) : 'offline',
        }),
        title: name,
        sub: lastLine(dm),
        href: path('/dms/' + dm.id),
        link: true,
        meta: pair,
      });
    }));
  };

  paint();
  if ((State.dms || []).length) {
    // Cached rows give the reader somewhere to land instantly; the refresh that
    // follows only replaces them when it returns something different.
    refreshDms().then(() => paint()).catch(() => {});
  }

  return {
    node: fold([
      (() => {
        const banner = head({
          kicker: 'Direct',
          title: 'Direct messages',
          lede: 'One-to-one conversations, the newest activity first.',
          actions: el('button', {
            class: 'btn btn--default', type: 'button',
            onClick: () => navigate('/friends'),
          }, icon('plus', { size: 15 }), 'New conversation'),
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
    cleanup() {},
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
    send: (payload) => Api.sendDm(conversationId, payload),
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

  const paintPeer = (dm) => {
    const peer = dmPeer(dm) || dm.peer || null;
    const name = peer ? nameOf(peer) : 'Direct message';
    const actions = el('a', {
      class: 'btn btn--ghost btn--sm',
      href: peer ? path('/users/' + peer.id) : path('/friends'),
    }, icon('user', { size: 15 }), 'Profile');
    headNode.querySelector('.pagehead-actions') && headNode.querySelector('.pagehead-actions').remove();
    headNode.appendChild(el('div', { class: 'pagehead-actions' }, actions));
    const title = headNode.querySelector('.pagehead-title');
    if (title) title.textContent = name;
    const lede = headNode.querySelector('.pagehead-lede');
    if (lede) lede.textContent = peer && peer.presence === 'online'
      ? 'Here now.'
      : 'A conversation between the two of you.';
    const ta = surface.composer.node.querySelector('textarea');
    if (ta && peer) {
      ta.setAttribute('aria-label', 'Message @' + nameOf(peer));
      ta.placeholder = 'Message @' + nameOf(peer);
    }
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
      surface.api.paint((dm.messages || []).map(asMessage),
        { hasOlder: (dm.messages || []).length >= 50 });
      surface.wireScroller();
      joinDm(conversationId);
      markRead();
    } catch (e) {
      if (mine !== openGeneration) return;
      paintFault(e);
    }
  };

  const unsubs = [
    on(EVENTS.DM_MESSAGE, (event) => {
      if (String(event.conversationId) !== String(conversationId)) return;
      surface.api.created(event);
    }),
    on(EVENTS.DM_MESSAGE_UPDATED, (event) => {
      if (String(event.conversationId) !== String(conversationId)) return;
      surface.api.updated(event);
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

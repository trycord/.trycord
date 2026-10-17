// Direct messages.
//
// The list is a page; opening one is the same scroll a channel uses, so the
// conversation renderer is shared and this file only supplies its scope and the
// header around it.

import { el } from '../../packages/dom.js';
import { avatar, countBadge, iconButton } from '../ui/primitives.js';
import { State, dmPeer, nameOf, refreshDms } from '../../packages/store.js';
import { path, navigate } from '../../packages/nav.js';
import { relativeTime } from '../../packages/format.js';
import Api from '../../packages/api.js';
import { page, band, panel, prow, loading, failure, empty } from './util.js';
import { renderConversation } from './messages.js';

function peerOf(dm) {
  const peer = dmPeer(dm);
  if (peer) return peer;
  const users = (dm && (dm.users || dm.participants)) || [];
  const other = users[0] || null;
  if (!other) return null;
  return {
    id: other.id,
    username: other.username,
    displayName: other.display_name || other.displayName || other.username,
    avatarUrl: other.avatar_url !== undefined ? other.avatar_url : other.avatarUrl,
  };
}

// --- the list ---------------------------------------------------------------

export function renderDms() {
  const host = el('div', { class: 'stack' });
  const node = page(
    band({
      eyebrow: 'Messages',
      icon: 'message',
      title: 'Direct messages',
      lede: 'One-to-one conversations, most recent first.',
    }),
    host,
  );

  async function load() {
    host.replaceChildren(loading('Loading your conversations'));
    try {
      await refreshDms();
      paint();
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }

  function paint() {
    host.replaceChildren();
    if (!State.dms.length) {
      host.appendChild(empty({
        icon: 'message',
        title: 'No conversations yet',
        text: 'Pick someone from your friends and send the first message.',
        action: el('a', { class: 'btn btn--primary btn--sm', href: path('/friends') }, 'Go to friends'),
      }));
      return;
    }
    host.appendChild(panel({
      title: 'Conversations',
      note: String(State.dms.length),
      rows: State.dms.map(rowFor),
    }));
  }

  function rowFor(dm) {
    const peer = peerOf(dm);
    const name = peer ? nameOf(peer) : 'Conversation';
    const updated = dm.updatedAt || dm.updated_at
      || (dm.lastMessage && (dm.lastMessage.created_at || dm.lastMessage.createdAt));
    const unread = Number(dm.unreadCount) || 0;
    return prow({
      class: unread ? 'is-unread' : null,
      lead: peer
        ? avatar(peer, { size: 'md', presence: State.presence.get(peer.id) || 'offline' })
        : el('span', { class: 'avatar avatar--md' }, ''),
      title: name,
      sub: preview(dm),
      actions: [
        unread ? countBadge(unread) : null,
        updated ? el('span', { class: 'prow-sub' }, relativeTime(updated)) : null,
      ],
      onClick: () => navigate('/dms/' + dm.id),
    });
  }

  function preview(dm) {
    const last = dm.lastMessage;
    if (!last) return 'No messages yet';
    const who = last.author_name || last.authorName || '';
    const text = String(last.content || '').replace(/\s+/g, ' ').trim();
    return (who ? who + ': ' : '') + text;
  }

  return { node, onMount: load };
}

// --- one conversation -------------------------------------------------------

export function renderDm(ctx) {
  const id = ctx.params.id;
  const scope = {
    kind: 'dm',
    id,
    placeholder: 'Message',
    emptyTitle: 'No messages yet',
    emptyText: 'Say hello.',
  };
  const conversation = renderConversation(ctx, scope);

  const name = el('span', { class: 'head-avatar' });
  const presence = el('span', { class: 'stage-head-sub' });
  const head = el('div', { class: 'stage-head-content' },
    el('h1', { class: 'stage-head-title head-avatar' }, name),
    presence,
  );

  function paintDm(dm) {
    const peer = peerOf(dm);
    name.replaceChildren();
    if (!peer) {
      name.textContent = 'Conversation';
      presence.replaceChildren();
      return;
    }
    const state = State.presence.get(peer.id) || 'offline';
    name.append(avatar(peer, { size: 'sm' }), el('span', {}, nameOf(peer)));
    presence.textContent = '@' + peer.username + ' \u00b7 ' + state;
  }

  async function load() {
    let dm = State.dms.find((d) => d.id === id) || null;
    if (!dm) {
      try {
        dm = await Api.dm(id);
        if (dm) State.dms = State.dms.concat([dm]);
      } catch { dm = null; }
    }
    if (dm) paintDm(dm);
    else name.textContent = 'Conversation';
  }

  return {
    head: [head, el('div', { class: 'stage-head-actions' },
      iconButton('user', {
        label: 'Open their profile',
        onClick: () => {
          const dm = State.dms.find((d) => d.id === id);
          const peer = dm && peerOf(dm);
          if (peer) navigate('/users/' + peer.id);
        },
      }))],
    node: conversation.node,
    composer: conversation.composer,
    onMount() {
      conversation.onMount();
      load();
    },
    cleanup: conversation.cleanup,
  };
}

export default { renderDms, renderDm };

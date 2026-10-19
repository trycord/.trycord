// Direct messages.
//
// The list is a screen; opening one is the same scroll a channel uses, so the
// conversation engine is shared and this file only supplies its scope and the
// bar around it.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { avatar, empty, loading, failure, badge } from '../components.js';
import { State, dmPeer, nameOf, refreshDms, presenceOf, on as onStore } from '../../../packages/store.js';
import { path, navigate } from '../../../packages/nav.js';
import { relativeTime } from '../../../packages/format.js';
import Api from '../../../packages/api.js';
import { screen, section } from './util.js';
import { renderConversation } from './messages.js';
import { setAppBar } from '../shell.js';

function peerOf(dm) {
  const peer = dmPeer(dm);
  if (peer) return peer;
  const users = (dm && (dm.users || dm.participants)) || [];
  const other = users.find((u) => !State.user || u.id !== State.user.id) || users[0] || null;
  if (!other) return null;
  return {
    id: other.id,
    username: other.username,
    displayName: other.display_name || other.displayName || other.username,
    avatarUrl: other.avatar_url !== undefined ? other.avatar_url : other.avatarUrl,
  };
}

function preview(dm) {
  const last = dm.lastMessage;
  if (!last) return 'No messages yet';
  const who = last.author_name || last.authorName || '';
  const text = String(last.content || '').replace(/\s+/g, ' ').trim();
  return (who ? who + ': ' : '') + text;
}

export function renderDms() {
  const host = el('div', { class: 'm-stack' });
  const node = screen(
    el('div', { class: 'm-hero m-hero--quiet' },
      el('h1', { class: 'm-hero__title' }, 'Direct messages'),
      el('div', { class: 'm-hero__sub' }, 'One-to-one conversations, most recent first.')),
    host,
  );

  // A conversation read elsewhere clears its badge without a reload.
  let ready = false;
  const offDms = onStore('dms', () => { if (ready) paint(); });

  async function load() {
    host.replaceChildren(loading('Loading your conversations'));
    ready = true;
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
        action: el('a', { class: 'm-btn m-btn--primary', href: path('/friends') }, 'Go to friends'),
      }));
      return;
    }
    const list = el('div', { class: 'm-list' });
    for (const dm of State.dms) list.appendChild(rowFor(dm));
    host.appendChild(section('Conversations', list, { note: String(State.dms.length) }));
  }

  function rowFor(dm) {
    const peer = peerOf(dm);
    const name = peer ? nameOf(peer) : 'Conversation';
    const updated = dm.updatedAt || dm.updated_at
      || (dm.lastMessage && (dm.lastMessage.created_at || dm.lastMessage.createdAt));
    const unread = Number(dm.unreadCount) || 0;
    return el('a', {
      class: 'm-row' + (unread ? ' is-unread' : ''),
      href: path('/dms/' + dm.id),
    },
      el('span', { class: 'm-row__lead' }, peer ? avatar(peer, { size: 'md', presence: true, decorative: true }) : el('span', { class: 'm-avatar m-avatar--md' }, '')),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title truncate' }, name),
        el('span', { class: 'm-row__sub truncate' }, preview(dm))),
      el('span', { class: 'm-row__trailing' },
        badge(unread),
        updated ? el('span', { class: 'm-row__time' }, relativeTime(updated)) : null));
  }

  return { node, head: { title: 'Messages' }, onMount: load, cleanup() { offDms(); } };
}

export function renderDm(ctx) {
  const id = ctx.params.id;
  const scope = {
    kind: 'dm',
    id,
    placeholder: 'Message',
    emptyTitle: 'No messages yet',
    emptyText: 'Say hello.',
    icon: 'message',
  };
  const conversation = renderConversation(ctx, scope);

  let peer = null;
  function head() {
    if (!peer) return { lead: 'back', title: 'Conversation' };
    return {
      lead: 'back',
      title: nameOf(peer),
      sub: '@' + peer.username + ' \u00b7 ' + presenceOf(peer.id),
      mark: avatar(peer, { size: 'sm', decorative: true }),
      actions: [el('button', {
        class: 'm-iconbtn', type: 'button', 'aria-label': 'Open their profile',
        onClick: () => navigate('/users/' + peer.id),
      }, icon('user', { size: 20 }))],
    };
  }

  async function load() {
    let dm = State.dms.find((d) => d.id === id) || null;
    if (!dm) {
      try {
        dm = await Api.dm(id);
        if (dm) State.dms = State.dms.concat([dm]);
      } catch { dm = null; }
    }
    peer = dm ? peerOf(dm) : null;
    // The bar is re-set once the peer is known, keeping the module's own shell
    // the only thing that draws it.
    setAppBar(head());
  }

  return {
    head: { lead: 'back', title: 'Conversation' },
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

import State, {
  refreshActivity, refreshDms, refreshNotifications, refreshFriends,
} from '../state.js';
import { esc, el, clear, plural, relTime } from '../ui.js';
import { avatar, communityMark, emptyState } from '../components.js';
import { renderContextHeader } from '../shell.js';
import { channelPath } from '../links.js';
import { navigate } from '../nav.js';

// Home is where you start, so it answers four questions and then stops: what needs
// me, what am I in the middle of, what am I part of, and where do I go next.
//
// It used to be none of those. It fetched every recent message across every
// community, merged in the direct messages, sorted by time and printed the first
// twenty-four as identical rows - a single message per row, no grouping, no
// unread, no communities, nothing that was not already in the sidebar. Nine
// messages in one channel looked like nine things that had happened. That is the
// shape of a database table, not the shape of a conversation list.

const timeOf = (v) => String(v || '');

// The activity feed is per message. A conversation is not that. Grouping by
// community and channel turns 'twelve things happened' into 'one place is busy,
// and here is the latest of them', which is the distinction the whole page turns
// on.
function conversationsFromActivity(activity) {
  const byPlace = new Map();
  for (const item of activity || []) {
    const key = String(item.server_id) + '/' + String(item.channel_id);
    const at = timeOf(item.created_at || item.createdAt);
    const seen = byPlace.get(key);
    if (!seen) {
      byPlace.set(key, {
        kind: 'channel',
        id: key,
        serverId: item.server_id,
        serverName: item.server_name || '',
        channelId: item.channel_id,
        channelName: item.channel_name || '',
        author: item.author_display || item.author_name || '',
        authorName: item.author_name || '',
        preview: item.content || 'Attachment',
        at,
        count: 1,
      });
      continue;
    }
    seen.count += 1;
    // The feed is newest-first, so the first message seen for a place is its
    // latest one. Later entries only add to the count.
  }
  return [...byPlace.values()];
}

function conversationRow(c) {
  const row = el('button', {
    class: 'row row--surface home-conversation' + (c.unread ? ' is-unread' : ''),
    type: 'button',
    onClick: () => {
      if (c.kind === 'dm') navigate('/dms/' + c.id);
      else navigate(channelPath(c.serverId, c.channelId));
    },
  });

  if (c.kind === 'dm') row.appendChild(avatar(c.peer, { withPresence: true }));
  else row.appendChild(el('span', { class: 'home-conversation__hash', 'aria-hidden': 'true' }, '#'));

  const main = el('div', { class: 'row-main' });

  // Level 1: who or where. Level 2: what was said. Level 3: when, and how much of
  // it. Not every one of those at the same weight - that is the difference
  // between a heading and a metadata line.
  const title = el('div', { class: 'row-title' },
    c.kind === 'dm'
      ? (c.peer.displayName || c.peer.username || 'Unknown')
      : '#' + esc(c.channelName));
  if (c.unread) title.appendChild(el('span', { class: 'home-conversation__dot', 'aria-label': 'Unread' }));
  main.appendChild(title);

  const subBits = [];
  if (c.kind === 'dm') {
    subBits.push('Direct message');
  } else {
    subBits.push(esc(c.serverName || 'Community'));
    if (c.author) subBits.push('from ' + esc(c.author));
  }
  const sub = el('div', { class: 'row-sub' }, subBits.join(' · '));
  if (c.at) sub.appendChild(el('span', { class: 'row-sub__time' }, relTime(c.at)));
  main.appendChild(sub);

  main.appendChild(el('div', { class: 'home-conversation__preview' },
    c.count > 1 ? c.count + ' messages · ' : '', esc(String(c.preview || '').slice(0, 160))));
  row.appendChild(main);

  if (c.unread) {
    row.appendChild(el('span', { class: 'nv-count' }, String(c.unread)));
  }
  return row;
}

function section(title, hint, body) {
  const s = el('section', { class: 'home-section' });
  const head = el('div', { class: 'home-section__head' });
  head.appendChild(el('h2', { class: 'home-section__title' }, title));
  if (hint) head.appendChild(el('span', { class: 'home-section__hint' }, hint));
  s.appendChild(head);
  if (body) s.appendChild(body);
  return s;
}

// Notifications explain why they should matter, which is the only reason to put
// one on a start page. Everything else stays on the notifications page.
function needsYou(notifications, dms, friendsIn) {
  const actionable = (notifications || []).filter(
    (n) => n && (n.type === 'mention' || n.type === 'reply' || n.type === 'friend_request'));
  const unreadDms = (dms || []).filter((d) => d.unreadCount > 0);

  if (!actionable.length && !unreadDms.length && !(friendsIn || []).length) return null;

  const box = el('div', { class: 'home-attention' });
  if (actionable.length) {
    for (const n of actionable.slice(0, 5)) {
      const who = (n.actor && (n.actor.displayName || n.actor.username)) || 'Someone';
      const what = n.type === 'mention' ? 'mentioned you'
        : n.type === 'reply' ? 'replied to your message'
          : 'sent you a friend request';
      const where = n.context && n.context.channelName ? ' in #' + esc(n.context.channelName) : '';
      const row = el('button', {
        class: 'home-attention__row', type: 'button',
        onClick: () => {
          if (n.type === 'friend_request') { navigate('/friends'); return; }
          if (n.context && n.context.serverId && n.context.channelId) {
            navigate(channelPath(n.context.serverId, n.context.channelId));
          }
        },
      });
      row.appendChild(avatar(n.actor || { username: who }, { size: 'sm' }));
      row.appendChild(el('span', { class: 'home-attention__text' },
        el('strong', {}, who), ' ' + what + where));
      row.appendChild(el('span', { class: 'home-attention__time' }, relTime(n.created_at || n.createdAt)));
      box.appendChild(row);
    }
  }
  for (const dm of unreadDms.slice(0, actionable.length ? 3 : 5)) {
    const peer = dm.peer || {};
    const row = el('button', {
      class: 'home-attention__row', type: 'button',
      onClick: () => { navigate('/dms/' + dm.id); },
    });
    row.appendChild(avatar(peer, { size: 'sm', withPresence: true }));
    row.appendChild(el('span', { class: 'home-attention__text' },
      el('strong', {}, peer.displayName || peer.username || 'Unknown'),
      ' · ', dm.unreadCount + (dm.unreadCount === 1 ? ' unread message' : ' unread messages')));
    row.appendChild(el('span', { class: 'home-attention__time' },
      relTime(dm.lastMessage && (dm.lastMessage.createdAt || dm.lastMessage.created_at))));
    box.appendChild(row);
  }
  return box;
}

function yourCommunities(servers) {
  if (!(servers || []).length) return null;
  const list = el('div', { class: 'home-communities' });
  for (const s of servers.slice(0, 8)) {
    const id = s.serverId || s.id;
    const row = el('button', {
      class: 'home-community', type: 'button',
      onClick: () => { navigate('/c/' + id); },
    });
    row.appendChild(communityMark(s.name || '?', { size: 'sm', server: s }));
    const main = el('div', { class: 'row-main' });
    main.appendChild(el('div', { class: 'row-title' }, s.name || 'Community'));
    const bits = [];
    if (s.member_count != null) bits.push(plural(s.member_count, 'member'));
    if (s.channel_count != null) bits.push(plural(s.channel_count, 'channel'));
    if (s.description) bits.push(String(s.description).slice(0, 70));
    if (bits.length) main.appendChild(el('div', { class: 'row-sub' }, bits.join(' · ')));
    row.appendChild(main);
    list.appendChild(row);
  }
  return list;
}

export async function renderHome(container) {
  clear(container);
  renderContextHeader({ title: 'Home', sub: 'Across your places' });

  // Everything Home shows is real state the shell already keeps. Nothing here is
  // fetched to make the page look fuller than the account actually is - which is
  // why every section below can be absent and the page still makes sense.
  const results = await Promise.allSettled([
    refreshActivity(),
    refreshDms(),
    refreshNotifications(),
    refreshFriends(),
  ]);
  const activity = results[0].status === 'fulfilled' ? results[0].value : State.activity;
  const dmList = results[1].status === 'fulfilled' ? results[1].value : State.dms;
  // Already refreshed by the lifecycle for every signed-in page.
  const servers = State.servers;
  const notifications = results[2].status === 'fulfilled' ? results[2].value : State.notifications;
  // refreshFriends() resolves the whole state object, not an {incoming} payload.
  const friendsIn = State.friendsIn || [];

  const wrap = el('div', { class: 'page home-environment' });
  const layout = el('div', { class: 'home-layout' });
  const primary = el('div', { class: 'home-primary' });
  const aside = el('aside', { class: 'home-aside' });

  const me = State.me || {};
  const firstName = (me.displayName || me.username || '').split(' ')[0];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  // The h1 for this surface is the context header's. This is the greeting under the
  // page title, not a second name for the page.
  wrap.appendChild(el('div', { class: 'home-greeting' },
    el('p', { class: 'home-greeting__title' }, firstName ? greeting + ', ' + firstName : greeting),
    el('p', { class: 'home-greeting__sub' },
      firstName ? 'Here is what has been happening in your Trycord.' : 'Here is what has been happening.')));

  // Conversations: the direct messages the user is actually in, and the places in
  // their communities that have been busy - one row each, not one row per message.
  const dmConversations = (dmList || []).filter((dm) => dm.lastMessage).map((dm) => ({
    kind: 'dm',
    id: dm.id,
    peer: dm.peer || {},
    preview: dm.lastMessage.content || '',
    at: dm.lastMessage.createdAt || dm.lastMessage.created_at || '',
    unread: Number(dm.unreadCount || 0),
  }));
  const placeConversations = conversationsFromActivity(activity).map((c) => ({ ...c, unread: 0 }));

  const conversations = [...dmConversations, ...placeConversations]
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 12);

  if (conversations.length) {
    const list = el('div', { class: 'home-conversations' });
    for (const c of conversations) list.appendChild(conversationRow(c));
    primary.appendChild(section('Conversations',
      conversations.length === 1 ? '1 conversation' : plural(conversations.length, 'conversation'),
      list));
  }

  const attention = needsYou(notifications, dmList, friendsIn);
  if (attention) {
    aside.appendChild(section('Needs you', null, attention));
  }
  const communities = yourCommunities(servers);
  if (communities) {
    aside.appendChild(section('Your communities',
      plural((servers || []).length, 'community'), communities));
  }

  if (!conversations.length && !attention && !communities) {
    // An honest empty state, with the two things worth doing in it. No filler, and
    // no invented activity to make the page look occupied.
    const empty = emptyState('hash', 'Nothing here yet',
      'When you join a community or start a conversation, it shows up here.');
    empty.appendChild(el('div', { class: 'home-empty-actions' },
      el('button', { class: 'btn primary', type: 'button', onClick: () => { navigate('/servers/new'); } }, 'Create a community'),
      el('button', { class: 'btn ghost', type: 'button', onClick: () => { navigate('/discover'); } }, 'Browse communities')));
    primary.appendChild(empty);
  }

  layout.appendChild(primary);
  if (aside.childElementCount) layout.appendChild(aside);
  wrap.appendChild(layout);
  container.appendChild(wrap);
}

export default { renderHome };
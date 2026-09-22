// Home / atrium. Aggregates the user's real servers, recent activity,
// DMs and friends into the main environment.

import State, { refreshServers, refreshActivity, refreshDms, refreshFriends } from './state.js';
import Api from './api.js';
import { esc, el, clear, relTime } from './ui.js';
import { avatar, emptyState, navRow } from './components.js';
import { renderContextHeader } from './shell.js';

export async function renderHome(container) {
  clear(container);
  renderContextHeader({ title: 'Home', sub: 'Your communities and conversations' });

  const wrap = el('div', { class: 'page atrium' });

  // Greeting
  const g = el('div', { class: 'atrium-greeting' });
  const me = State.me;
  g.appendChild(el('h1', {}, 'Welcome back' + (me ? ', ' + esc(me.displayName || me.username) : '') + '.'));
  g.appendChild(el('p', {}, 'Everything happening across your communities, DMs and friends — in one place.'));
  wrap.appendChild(g);

  // Servers
  const servers = State.servers.length ? State.servers : await refreshServers();
  const sr = el('section', { class: 'stack' });
  sr.appendChild(el('h2', {}, 'Communities'));
  if (!servers.length) {
    sr.appendChild(emptyState('☼', 'No communities yet',
      'Create a new server or browse the discovery feed to find one.'));
  } else {
    for (const s of servers) {
      const row = el('button', {
        class: 'row', type: 'button', dataset: { serverId: s.id },
        onClick: () => { location.hash = '#/server/' + s.id; },
      });
      const badge = el('span', { class: 'chip-badge' }, (s.name || '?')[0].toUpperCase());
      row.appendChild(badge);
      const main = el('div', { class: 'row-main' });
      const meta = el('span', { class: 'row-title' }, s.name);
      if (s.is_owner) meta.appendChild(el('span', { class: 'badge', title: 'You own this server' }, 'owner'));
      main.appendChild(meta);
      main.appendChild(el('div', { class: 'row-sub' },
        (s.member_count || 0) + ' members · ' + (s.channel_count || 0) + ' channels' +
        (s.description && s.description.trim() ? ' · ' + esc(s.description) : '')));
      row.appendChild(main);
      row.appendChild(el('span', { class: 'row-meta' }, 'Open →'));
      sr.appendChild(row);
    }
  }
  wrap.appendChild(sr);

  // Cross-column: activity + dms + friends
  const cols = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(min(360px,100%),1fr))', gap: 'var(--t-d-5)' } });

  // Activity feed
  const act = el('section', { class: 'stack' });
  act.appendChild(el('h2', {}, 'Recent activity'));
  let activity = State.activity;
  try { activity = await refreshActivity(); } catch { /* non-fatal */ }
  if (!activity || !activity.length) {
    act.appendChild(emptyState('◷', 'No activity yet', 'Messages posted anywhere in your servers will show up here.'));
  } else {
    for (const a of activity.slice(0, 10)) {
      const r = el('button', {
        class: 'row', type: 'button',
        onClick: () => { location.hash = '#/server/' + a.server_id + '/channel/' + a.channel_id; },
      });
      r.appendChild(avatar({ username: a.author_name, displayName: a.author_display }, { withPresence: false }));
      const m = el('div', { class: 'row-main' });
      m.appendChild(el('div', { class: 'row-title' }, a.author_display || a.author_name));
      m.appendChild(el('div', { class: 'row-sub' },
        '#' + esc(a.channel_name) + ' · ' + esc(a.server_name)));
      m.appendChild(el('div', { class: 'msg-text', style: { color: 'var(--t-txt2)' } }, a.content ? esc(a.content.slice(0, 140)) : 'Attachment'));
      r.appendChild(m);
      r.appendChild(el('span', { class: 'row-meta' }, relTime(a.created_at)));
      act.appendChild(r);
    }
  }
  cols.appendChild(act);

  // DMs
  const dms = el('section', { class: 'stack' });
  dms.appendChild(el('h2', {}, 'Direct messages'));
  let dmList = State.dms;
  try { dmList = await refreshDms(); } catch { /* non-fatal */ }
  if (!dmList || !dmList.length) {
    dms.appendChild(emptyState('✉', 'No messages yet', 'DMs with friends will appear here as soon as someone reaches out.'));
  } else {
    for (const dm of dmList.slice(0, 8)) {
      const r = el('button', {
        class: 'row', type: 'button',
        onClick: () => { location.hash = '#/dms/' + dm.id; },
      });
      r.appendChild(avatar(dm.peer, { withPresence: true }));
      const m = el('div', { class: 'row-main' });
      m.appendChild(el('div', { class: 'row-title' }, dm.peer.displayName || dm.peer.username));
      m.appendChild(el('div', { class: 'row-sub' },
        (dm.lastMessage ? esc(dm.lastMessage.content.slice(0, 80)) : 'Start the conversation')));
      r.appendChild(m);
      if (dm.unreadCount) r.appendChild(el('span', { class: 'nv-count' }, dm.unreadCount));
      dms.appendChild(r);
    }
  }
  cols.appendChild(dms);

  wrap.appendChild(cols);
  container.appendChild(wrap);
  // refresh DMs quietly in the background for the badge
  refreshDms().catch(() => {});
}

export default { renderHome };
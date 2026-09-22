// Home is an activity environment, not a dashboard. The persistent presence
// spine owns navigation; this surface only shows real, recent conversation.

import State, { refreshServers, refreshActivity, refreshDms } from './state.js';
import { esc, el, clear, relTime } from './ui.js';
import { avatar, emptyState } from './components.js';
import { renderContextHeader } from './shell.js';

export async function renderHome(container) {
  clear(container);
  renderContextHeader({ title: 'Home', sub: 'Across your places' });

  const wrap = el('div', { class: 'page home-environment' });
  const stream = el('section', { class: 'home-stream', 'aria-label': 'Recent activity' });
  const [activityResult, dmsResult] = await Promise.allSettled([
    refreshActivity(),
    refreshDms(),
  ]);
  const activity = activityResult.status === 'fulfilled' ? activityResult.value : State.activity;
  const dmList = dmsResult.status === 'fulfilled' ? dmsResult.value : State.dms;

  const entries = [
    ...(activity || []).map((item) => ({ kind: 'activity', item, at: item.created_at || item.createdAt || '' })),
    ...(dmList || []).filter((dm) => dm.lastMessage).map((item) => ({
      kind: 'dm', item, at: item.lastMessage.createdAt || item.lastMessage.created_at || '',
    })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 24);

  if (!entries.length) {
    let servers = State.servers;
    if (!servers.length) {
      try { servers = await refreshServers(); } catch { servers = State.servers; }
    }
    const empty = emptyState('○', 'Your space is quiet',
      servers.length ? 'Choose a community from the spine to start talking.' : 'Create a community or browse places to join the conversation.');
    empty.appendChild(el('div', { class: 'home-empty-actions' },
      el('button', { class: 'btn primary', type: 'button', onClick: () => { location.hash = '#/servers/new'; } }, 'Create community'),
      el('button', { class: 'btn ghost', type: 'button', onClick: () => { location.hash = '#/discover'; } }, 'Browse communities')));
    stream.appendChild(empty);
  }

  for (const entry of entries) {
    if (entry.kind === 'activity') {
      const a = entry.item;
      const row = el('button', {
        class: 'row home-event', type: 'button',
        onClick: () => { location.hash = '#/server/' + a.server_id + '/channel/' + a.channel_id; },
      });
      row.appendChild(avatar({ username: a.author_name, displayName: a.author_display }, { withPresence: false }));
      const main = el('div', { class: 'row-main' });
      main.appendChild(el('div', { class: 'row-title' }, a.author_display || a.author_name));
      main.appendChild(el('div', { class: 'row-sub' }, '#' + esc(a.channel_name) + ' in ' + esc(a.server_name)));
      main.appendChild(el('div', { class: 'msg-text' }, a.content ? esc(a.content.slice(0, 180)) : 'Attachment'));
      row.appendChild(main);
      row.appendChild(el('span', { class: 'row-meta' }, relTime(a.created_at || a.createdAt)));
      stream.appendChild(row);
      continue;
    }

    const dm = entry.item;
    const row = el('button', {
      class: 'row home-event', type: 'button',
      onClick: () => { location.hash = '#/dms/' + dm.id; },
    });
    row.appendChild(avatar(dm.peer, { withPresence: true }));
    const main = el('div', { class: 'row-main' });
    main.appendChild(el('div', { class: 'row-title' }, dm.peer.displayName || dm.peer.username));
    main.appendChild(el('div', { class: 'row-sub' }, 'Direct message'));
    main.appendChild(el('div', { class: 'msg-text' }, esc(dm.lastMessage.content.slice(0, 180))));
    row.appendChild(main);
    row.appendChild(el('span', { class: 'row-meta' }, relTime(dm.lastMessage.createdAt || dm.lastMessage.created_at)));
    if (dm.unreadCount) row.appendChild(el('span', { class: 'nv-count' }, dm.unreadCount));
    stream.appendChild(row);
  }

  wrap.appendChild(stream);
  container.appendChild(wrap);
  refreshDms().catch(() => {});
}

export default { renderHome };

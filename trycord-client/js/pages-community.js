import Api from './api.js';
import State from './state.js';

import { peerPresence, refreshServers, setViewRefresh } from './state.js';
import { clear, el, esc, toast } from './ui.js';
import { avatar, communityBannerUrl, communityMark, emptyState, loadAuthedImage } from './components.js';
import { renderAllChrome, renderContextHeader, currentRoute } from './shell.js';;
import { renderMemberList } from './pages-members.js';
import { ensureServer } from './workspace-shared.js';
import { channelPath } from './links.js';
import { navigate, route } from './nav.js';;

async function renderServerLanding(container, serverId) {
  clear(container);
  let server;
  try {
    const { detail } = await ensureServer(serverId);
    server = detail;
  } catch (ex) {
    renderContextHeader({ title: 'Unavailable' });
    container.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot open this community'));
    return;
  }
  renderContextHeader({ title: server.name, sub: (server.description || 'Community') + ' · ' + (server.member_count || 0) + ' members' });
    const wrap = el('div', { class: 'page atrium' });
    const onlineCount = (State.members || []).filter((m) => peerPresence(m.user_id || m.id) === 'online').length;
    const banner = communityBannerUrl(server);
    if (banner) {
      const band = el('div', { class: 'community-banner' });
      const layer = el('div', { class: 'community-banner__img' });
      loadAuthedImage(banner).then((url) => {
        if (url) layer.style.backgroundImage = 'url("' + url + '")';
      });
      band.append(layer, el('div', { class: 'community-banner__scrim' }));
      wrap.appendChild(band);
    }
    const hero = el('div', { class: 'community-hero' });
    hero.appendChild(communityMark(server.name || '?', { size: 'lg', server }));
  const heroText = el('div', { class: 'community-hero__text' });
  heroText.appendChild(el('h2', { class: 'community-hero__name' }, server.name || 'Community'));
  if (server.description) heroText.appendChild(el('p', { class: 'muted' }, server.description));
  const stats = el('div', { class: 'stat-inline' });
  stats.appendChild(el('span', {}, String(server.member_count || 0) + ' members · ' + String(onlineCount) + ' online'));
  stats.appendChild(el('span', {}, String(server.channel_count || 0) + ' channels'));
  stats.appendChild(el('span', {}, String(server.role_count || 0) + ' roles'));
  if (server.message_count != null) stats.appendChild(el('span', {}, String(server.message_count) + ' messages'));
  heroText.appendChild(stats);
  hero.appendChild(heroText);
  wrap.appendChild(hero);
  wrap.appendChild(el('h2', {}, 'Channels'));
  const layout = State.channels;
  const categories = layout.categories || [];
  const channels = layout.channels || [];
  if (!channels.length) {
    wrap.appendChild(emptyState('hash', 'No channels yet', 'Create a channel to get started.'));
  } else {
    for (const cat of categories) {
      const inCat = channels.filter((ch) => String(ch.category_id) === String(cat.id));
      if (!inCat.length) continue;
      wrap.appendChild(el('div', { class: 'section-label' }, cat.name));
      for (const ch of inCat) {
        const r = el('button', {
          class: 'row row--channel', type: 'button', style: { marginLeft: 0, width: '100%' },
          onClick: () => { navigate(channelPath(serverId, ch.id)); },
        });
        r.appendChild(el('span', { class: 'ch-prefix' }, '#'));
        r.appendChild(el('span', { class: 'ch-name' }, ch.name));
        if (ch.topic) r.appendChild(el('span', { class: 'row-sub' }, esc(ch.topic)));
        wrap.appendChild(r);
      }
    }
    const ungrouped = channels.filter((ch) => !ch.category_id);
    if (ungrouped.length) {
      for (const ch of ungrouped) {
        const r = el('button', {
          class: 'row row--channel', type: 'button', style: { marginLeft: 0, width: '100%' },
          onClick: () => { navigate(channelPath(serverId, ch.id)); },
        });
        r.appendChild(el('span', { class: 'ch-prefix' }, '#'));
        r.appendChild(el('span', { class: 'ch-name' }, ch.name));
        wrap.appendChild(r);
      }
    }
  }
  wrap.appendChild(el('div', { class: 'section-label' }, 'Members'));
  renderMemberList(wrap, serverId);
  container.appendChild(wrap);
  setViewRefresh(() => { renderServerLanding(container, serverId).catch(() => {}); });
  renderAllChrome();
}


async function renderNewServer(container, serverId) {
  clear(container);
  renderContextHeader({ title: 'Create a community' });
  const wrap = el('div', { class: 'auth-wrap' });
  const card = el('div', { class: 'card card--auth' });
  const err = el('div', { class: 'form-error', hidden: true });
  const name = el('input', { class: 'input', type: 'text', placeholder: 'My community', maxlength: 64, required: true });
  const desc = el('textarea', { class: 'textarea', placeholder: 'What is your community about? (optional)', maxlength: 400 });
  const joinCode = el('input', { class: 'input', type: 'text', placeholder: 'Public code (letters + numbers, optional)', maxlength: 32 });
  const isPublic = el('input', { type: 'checkbox', checked: true });
  const isDisc = el('input', { type: 'checkbox', checked: true });
  const createBtn = el('button', { class: 'btn primary block', type: 'submit' }, 'Create community');

  const form = el('form', {}, err,
    el('div', { class: 'field' }, el('label', {}, 'Community name'), name),
    el('div', { class: 'field' }, el('label', {}, 'Description'), desc),
    el('div', { class: 'field' }, el('label', {}, 'Join code'), joinCode,
      el('span', { class: 'hint' }, 'Leave blank to auto-generate one.')),
    el('div', { class: 'field' }, el('label', { class: 'switch' }, isPublic, ' Public — joinable by code or invite link')),
    el('div', { class: 'field' }, el('label', { class: 'switch' }, isDisc, ' Discoverable in the browse feed')),
    createBtn);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    createBtn.setAttribute('aria-busy', 'true');
    try {
      const res = await Api.createServer({
        name: name.value.trim(),
        description: desc.value.trim() || undefined,
        joinCode: joinCode.value.trim() || undefined,
        isPublic: isPublic.checked,
        isDiscoverable: isDisc.checked,
      });
      toast('Community created.', 'ok');
      await refreshServers();
      const sid = res.serverId;
      navigate(channelPath(sid, res.channelId));
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message || 'Failed';
    } finally {
      createBtn.removeAttribute('aria-busy');
    }
  });

  card.appendChild(el('h1', {}, 'Create a community'));
  card.appendChild(el('p', { class: 'auth-sub' }, 'A permanent place for your community to gather.'));
  card.appendChild(form);
  wrap.appendChild(card);
  container.appendChild(wrap);
}


async function renderMenu(container) {
  clear(container);
  renderContextHeader({ title: 'Menu', sub: 'Everywhere in Trycord' });
  const wrap = el('div', { class: 'page atrium' });
  const me = State.me || {};
  const acct = el('button', { class: 'row', type: 'button', onClick: () => { navigate('#/settings'); } });
  acct.appendChild(avatar(me, { size: 'sm', withPresence: true }));
  const am = el('div', { class: 'row-main' });
  am.appendChild(el('div', { class: 'row-title' }, me.displayName || me.username || 'You'));
  am.appendChild(el('div', { class: 'row-sub' }, 'Open settings'));
  acct.appendChild(am);
  wrap.appendChild(acct);

  // The route, not the raw pathname: on a subpath deployment the pathname
  // still carries the mount and no channel row would ever read as active.
  const route = currentRoute();
  const appSec = el('div', { class: 'stack' });
  appSec.appendChild(el('div', { class: 'section-label' }, 'App'));
  const links = [
    { label: 'Friends', href: route('/friends'), path: '/friends' },
    { label: 'Notifications', href: route('/notifications'), path: '/notifications', badge: State.notifUnread },
    { label: 'Discover', href: route('/discover'), path: '/discover' },
    { label: 'Support', href: route('/support'), path: '/support' },
  ];
  if (me && me.isAdmin) links.push({ label: 'Admin', href: route('/admin'), path: '/admin', badge: 0 });
  for (const l of links) {
    const b = el('button', {
      class: 'row' + (route === l.path || route.startsWith(l.path + '/') ? ' active' : ''),
      type: 'button', onClick: () => { navigate(l.href); },
    });
    const bm = el('div', { class: 'row-main' });
    bm.appendChild(el('div', { class: 'row-title' }, l.label));
    b.appendChild(bm);
    if (l.badge) b.appendChild(el('span', { class: 'nv-count' }, String(l.badge > 99 ? '99+' : l.badge)));
    appSec.appendChild(b);
  }
  wrap.appendChild(appSec);

  const srvSec = el('div', { class: 'stack' });
  srvSec.appendChild(el('div', { class: 'section-label' }, 'Communities'));
  wrap.appendChild(srvSec);
  container.appendChild(wrap);
  let servers = [];
  try { servers = await refreshServers(); } catch { /* offline */ }
  if (!servers.length) {
    srvSec.appendChild(el('p', { class: 'muted small' }, 'No communities yet.'));
    const go = el('button', { class: 'btn', type: 'button', onClick: () => { navigate('#/discover'); } }, 'Discover communities');
    srvSec.appendChild(go);
    renderAllChrome();
    return;
  }
  for (const s of servers) {
    srvSec.appendChild(el('div', { class: 'section-label' }, s.name || 'Community'));
    let channels = [];
    try {
      const layout = await Api.channels(s.id);
      channels = layout.channels || [];
    } catch { /* skip */ }
    if (!channels.length) {
      srvSec.appendChild(el('p', { class: 'muted small' }, 'No channels yet.'));
      continue;
    }
    for (const ch of channels) {
      const b = el('button', {
        class: 'row' + (route === '/server/' + s.id + '/channel/' + ch.id ? ' active' : ''),
        type: 'button', onClick: () => { navigate(channelPath(s.id, ch.id)); },
      });
      const bm = el('div', { class: 'row-main' });
      bm.appendChild(el('div', { class: 'row-title' }, '# ' + (ch.name || 'channel')));
      if (ch.topic) bm.appendChild(el('div', { class: 'row-sub' }, ch.topic));
      b.appendChild(bm);
      srvSec.appendChild(b);
    }
  }
  renderAllChrome();
}

export { renderServerLanding, renderNewServer, renderMenu };

import Api from '../api.js';
import State, { peerPresence, refreshServers, setViewRefresh } from '../state.js';
import { clear, el, esc, icon, plural, toast } from '../ui.js';
import { avatar, communityBannerUrl, communityMark, emptyState, loadAuthedImage, navRow } from '../components.js';
import { renderAllChrome, renderContextHeader, currentRoute } from '../shell.js';
import { renderMemberList } from './members.js';
import { ensureServer } from '../workspace-shared.js';
import { channelPath, serverPath } from '../links.js';
import { errorState, onStale} from '../states.js';
import { navigate } from '../nav.js';

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
  renderContextHeader({ title: server.name, sub: (server.description || 'Community') + ' · ' + plural(server.member_count || 0, 'member') });
    const wrap = el('div', { class: 'page' });
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
  stats.appendChild(el('span', {}, plural(server.member_count || 0, 'member') + ' · ' + onlineCount + ' online'));
  const detail = [
    [server.channel_count, 'channel'],
    [server.role_count, 'role'],
  ];
  if (server.message_count != null) detail.push([server.message_count, 'message']);
  // Dots between the pairs, and a dot before the last one: '1 member · 1 channel
  // · 1 role · 7 messages' rather than three dots and a gap that reads as two
  // unrelated lists.
  stats.appendChild(el('span', {}, detail.map(([n, w]) => plural(n, w)).join(' · ')));
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
  setViewRefresh(() => { renderServerLanding(container, serverId).catch(onStale('This community')); });
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


// The directory.
//
// The rail is the fast path: the handful of places you actually go, in one glance,
// with no room to explain anything. This is the index of everything, which is a
// different job and worth doing properly - every destination, including the ones
// the rail has no space for, and every channel of every community you are in, so
// there is somewhere to go when you know the name of the thing and not the place
// it lives.
//
// It used to be neither. It listed four destinations the rail already showed, as
// bare text with no glyphs, and left out Home, Messages, Settings and your own
// profile - so it added nothing over the rail while looking like a separate page to
// look at. A partial copy of the rail is worse than no copy: it looks like the
// complete list and is not.
//
// It also fetched each community's channels in turn, one request after another, so
// ten communities meant ten round trips before anything appeared. They are asked
// for together now.
async function renderMenu(container) {
  clear(container);
  renderContextHeader({ title: 'Everything', sub: 'Every place here, and every channel in them' });
  const wrap = el('div', { class: 'page page--quiet' });
  container.appendChild(wrap);

  const here = currentRoute();
  const me = State.me || {};
  const section = (title) => {
    const s = el('div', { class: 'stack' });
    s.appendChild(el('div', { class: 'section-label' }, title));
    wrap.appendChild(s);
    return s;
  };
  const link = (parent, opts) => {
    const { path, ...rest } = opts;
    parent.appendChild(navRow({
      ...rest,
      active: here === path || here.startsWith(path + '/'),
      onClick: () => { navigate(path); },
    }));
  };

  const dmUnread = (State.dms || []).reduce((n, d) => n + (d.unreadCount || 0), 0);
  const requests = (State.friendsIn || []).length;

  // Who you are, first. Everything else on this page is a place; this is the one
  // row that is a person, and it is the way into your own settings.
  const you = section('You');
  const account = el('button', {
    class: 'row row--nav', type: 'button',
    onClick: () => { navigate('/settings'); },
  });
  account.appendChild(avatar(me, { size: 'sm', withPresence: true }));
  const accountText = el('span', { class: 'nv-label' },
    me.displayName || me.username || 'You');
  accountText.append(' ', el('small', { class: 'muted' },
    me.username ? '@' + me.username : 'Your profile and settings'));
  account.appendChild(accountText);
  you.appendChild(account);

  const mine = section('Your Trycord');
  link(mine, { label: 'Home', sub: 'What needs you', icon: icon('home'), path: '/home' });
  link(mine, { label: 'Messages', sub: 'Direct conversations', icon: icon('mail'), path: '/dms', count: dmUnread });
  link(mine, { label: 'Alerts', sub: 'Mentions and replies', icon: icon('bell'), path: '/notifications', count: State.notifUnread });
  link(mine, { label: 'Friends', sub: requests ? 'People waiting on you' : 'People you know', icon: icon('users'), path: '/friends', count: requests });
  link(mine, { label: 'Discover', sub: 'Communities on this instance', icon: icon('search'), path: '/discover' });

  const instance = section('This instance');
  link(instance, { label: 'Support', sub: 'Rules, appeals and who runs this place', icon: icon('layers'), path: '/support' });
  link(instance, { label: 'Create a community', sub: 'A permanent place for your people', icon: icon('plus'), path: '/servers/new' });
  if (me.isAdmin) {
    link(instance, { label: 'Admin', sub: 'Instance settings and moderation', icon: icon('gear'), path: '/admin' });
  }

  const communities = section('Your communities');

  let servers = [];
  let loadFailed = false;
  try {
    servers = await refreshServers();
  } catch {
    // The comment this replaces claimed the section below says so. It said the
    // opposite: "You are not in any communities yet", with a button to go and
    // find some. Being offline is the one situation where that advice is least
    // useful and most likely to be acted on.
    loadFailed = true;
  }

  if (loadFailed) {
    communities.appendChild(errorState('Could not load your communities.', () => renderMenu(container),
      { detail: 'Everything above this section works without them.' }));
    renderAllChrome();
    return;
  }

  if (!servers.length) {
    communities.appendChild(el('p', { class: 'muted small' },
      'You are not in any communities yet. Everything above works without one.'));
    const discover = el('button', {
      class: 'btn', type: 'button', onClick: () => { navigate('/discover'); },
    }, 'Find communities');
    communities.appendChild(discover);
    renderAllChrome();
    return;
  }

  // Asked for together rather than in sequence: one community's channels should not
  // have to arrive before the next one's are on their way.
  const layouts = await Promise.all(servers.map(async (s) => {
    try {
      const layout = await Api.channels(s.id);
      return { server: s, channels: (layout && layout.channels) || [] };
    } catch {
      return { server: s, channels: null };
    }
  }));

  for (const { server, channels } of layouts) {
    const block = el('div', { class: 'stack' });
    block.appendChild(el('div', { class: 'section-label' }, server.name || 'Community'));

    // The community itself is a destination too - its landing page is not any one
    // channel - and on this page it is the only row that leads there.
    block.appendChild(navRow({
      label: server.name || 'Community',
      sub: 'Overview',
      icon: communityMark(server.name || '?', { server }),
      active: here === serverPath(server.id) || here.startsWith(serverPath(server.id) + '/'),
      onClick: () => { navigate(serverPath(server.id)); },
    }));

    if (channels === null) {
      // A failed request is not the same as a community with no channels, and
      // saying "no channels yet" about a server that would not load would be a
      // lie about the state of somebody's community.
      block.appendChild(el('p', { class: 'muted small' },
        'Channels could not be loaded. Open the community to try again.'));
      communities.appendChild(block);
      continue;
    }
    if (!channels.length) {
      block.appendChild(el('p', { class: 'muted small' }, 'No channels yet.'));
      communities.appendChild(block);
      continue;
    }
    for (const ch of channels) {
      const path = '/server/' + server.id + '/channel/' + ch.id;
      block.appendChild(navRow({
        label: ch.name || 'channel',
        sub: ch.topic || '',
        icon: icon('hash'),
        active: here === path,
        onClick: () => { navigate(channelPath(server.id, ch.id)); },
      }));
    }
    communities.appendChild(block);
  }

  renderAllChrome();
}


export { renderServerLanding, renderNewServer, renderMenu };

// A person's profile, on a phone.
//
// What is public about an account, and the one or two things the viewer can do
// about it. Every label follows the relationship the server reported, so a
// control never claims to do one thing while holding state that means another.

import { el } from '../../../packages/dom.js';
import { avatar, loading, failure } from '../components.js';
import { normalizeUser, nameOf } from '../../../packages/store.js';
import { navigate } from '../../../packages/nav.js';
import { joinedLabel } from '../../../packages/format.js';
import { mediaUrl } from '../../../packages/media.js';
import Api from '../../../packages/api.js';
import { screen, section, notice, stat } from './util.js';
import { personActions } from '../person.js';

function presenceText(presence) {
  const value = presence || 'offline';
  if (value === 'online') return 'Online';
  return value.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function currentRoute() {
  const pathname = String(window.location.pathname || '/');
  return pathname.replace(/\/+$/, '') || '/';
}

export function renderProfile(ctx) {
  const id = ctx.params.id;
  const host = el('div', { class: 'm-stack' });
  const node = screen(host);

  async function load() {
    host.replaceChildren(loading('Loading profile'));
    try {
      const profile = await Api.user(id, ctx.serverId || undefined);
      host.replaceChildren(view(normalizeUser(profile), profile));
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }

  function view(user, profile) {
    const frag = document.createDocumentFragment();

    const banner = el('div', { class: 'm-profile-banner' });
    if (user.bannerUrl) mediaUrl(user.bannerUrl).then((src) => { if (src) banner.style.backgroundImage = 'url("' + src + '")'; }).catch(() => {});
    frag.appendChild(banner);

    frag.appendChild(el('div', { class: 'm-profile-id' },
      avatar(user, { size: 'xl', decorative: true }),
      el('div', {},
        el('h1', { class: 'm-profile-name' }, nameOf(user)),
        el('div', { class: 'm-profile-handle' }, '@' + user.username))));

    const actions = el('div', { class: 'm-actions m-actions--wrap' });
    paintActions(actions, user, profile);
    frag.appendChild(actions);

    frag.appendChild(el('div', { class: 'm-strip' },
      stat('@' + user.username, 'Username'),
      stat(presenceText(profile.presence), 'Presence'),
      stat(user.createdAt ? joinedLabel(user.createdAt) : 'Unknown', 'Joined')));

    if (user.statusText) frag.appendChild(notice({ text: user.statusText }));
    if (user.bio) frag.appendChild(section('About', el('p', { class: 'm-lede' }, user.bio)));

    const roles = (profile.roles || []).slice();
    if (roles.length) {
      const list = el('div', { class: 'm-list' });
      for (const role of roles) {
        list.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__lead' }, el('span', { class: 'm-role-dot', style: role.color ? { background: role.color } : null })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, role.name),
            (role.description || role.memberCount) ? el('span', { class: 'm-row__sub' }, role.description || (role.memberCount + ' members')) : null)));
      }
      frag.appendChild(section('Roles', list, { note: profile.serverName || null }));
    }

    return frag;
  }

  // The actions on this person are the shared ones - the same list every other
  // surface offers for the same person - so the profile cannot disagree with
  // the rest of the application about what can be done with them.
  function paintActions(actions, user, profile) {
    personActions(user, {
      relation: profile.relation,
      blocked: !!profile.blockedByViewer,
      onChanged: () => navigate(currentRoute()),
    }).then((items) => {
      for (const item of items) {
        if (item.separator || item.header) continue;
        actions.appendChild(el('button', {
          class: 'm-btn ' + (item.danger ? 'm-btn--danger' : (item.icon === 'message' ? 'm-btn--primary' : 'm-btn--ghost')),
          type: 'button',
          onClick: () => { if (item.onSelect) item.onSelect(); },
        }, item.label));
      }
    });
  }

  return { node, head: { lead: 'back', title: 'Profile' }, onMount: load };
}

export default { renderProfile };

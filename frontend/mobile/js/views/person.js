// The profile page.
//
// One address, always a page: /users/:id. The banner and the face, the name
// and the words the person chose, when they arrived, and what the reader
// shares with them — friends and places. The actions are the relation's:
// message, friend, block. The person sheet opens the page; the page is the
// thing that exists even when no sheet does.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import { State, nameOf, normalizeUser, refreshDms } from '../../../packages/store.js';
import { navigate, path } from '../../../packages/nav.js';
import { avatar } from '../../../js/ui/primitives.js';
import { attachLongPress, failed, toast, hold, failure } from '../ui.js';
import { reportSheet } from '../actions.js';

export function renderPerson(ctx) {
  const id = ctx.params.id;
  const serverId = (ctx.query && ctx.query.server) || null;
  const host = el('div', { class: 'm-stack' });
  let version = 0;

  async function load() {
    const mine = ++version;
    clear(host);
    host.appendChild(hold());
    try {
      const [profile, blocks] = await Promise.all([
        Api.user(id, serverId),
        Api.blocks().catch(() => []),
      ]);
      if (mine !== version) return;
      clear(host);
      paint(profile, Array.isArray(blocks) ? blocks : (blocks && blocks.items) || []);
    } catch (error) {
      if (mine !== version) return;
      clear(host);
      host.appendChild(unreadableNode(error));
    }
  }

  // Why the page could not be read, said as what it is. A profile kept
  // private is not an error: it is the person's choice, and the screen says
  // so rather than showing a fault.
  function unreadableNode(error) {
    const code = error && error.code;
    if (code === 'PROFILE_PRIVATE') {
      return el('div', { class: 'm-empty' },
        el('div', { class: 'm-empty__icon' }, icon('lock', { size: 24 })),
        el('div', { class: 'm-empty__title' }, 'A private profile'),
        el('p', { class: 'm-empty__text' }, 'This person shares their profile with the people they chose. You can still talk to them where you already do.'),
        el('button', { class: 'm-go m-go--quiet', type: 'button', onClick: () => history.back() }, 'Go back'));
    }
    if (code === 'NOT_FOUND') {
      return el('div', { class: 'm-empty' },
        el('div', { class: 'm-empty__icon' }, icon('user', { size: 24 })),
        el('div', { class: 'm-empty__title' }, 'No such account'),
        el('p', { class: 'm-empty__text' }, 'The address points at an account this instance does not have.'),
        el('button', { class: 'm-go m-go--quiet', type: 'button', onClick: () => navigate(path('/dms')) }, 'To the chats'));
    }
    return failure(error, load);
  }

  function paint(profile, blocks) {
    clear(host);
    const person = normalizeUser(profile);
    const relation = profile.relation;
    const self = relation === 'self' || (State.user && String(person.id) === String(State.user.id));
    const blocked = blocks.some((b) => String((b.user || b).id || b.id) === String(person.id));

    const cover = el('div', {
      class: 'm-profile__cover',
      style: person.bannerUrl || person.banner_url
        ? { backgroundImage: 'url(' + (person.bannerUrl || person.banner_url) + ')' }
        : {},
    });

    const lead = el('div', { class: 'm-profile__lead' },
      avatar(person, { size: 'xl' }),
      el('div', { class: 'm-profile__id' },
        el('div', { class: 'm-profile__name' }, nameOf(person) || person.username || 'Someone'),
        el('div', { class: 'm-profile__handle' },
          '@' + (person.username || '') + (profile.isBot || person.isBot ? ' · bot' : ''))));

    const presence = profile.presence || {};
    const statusText = person.statusText || person.status_text || presence.statusText || presence.status_text;

    host.appendChild(cover);
    host.appendChild(lead);
    if (statusText) host.appendChild(el('p', { class: 'm-profile__bio' }, statusText));
    if (profile.bio) host.appendChild(el('p', { class: 'm-profile__bio' }, profile.bio));

    const facts = el('div', { class: 'm-profile__facts' });
    const arrived = profile.createdAt || profile.created_at;
    if (arrived) facts.appendChild(el('div', { class: 'm-profile__fact' }, icon('info', { size: 15 }), 'Here since ' + new Date(arrived).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })));
    if (presence && presence.status && presence.status !== 'offline' && !self) {
      facts.appendChild(el('div', { class: 'm-profile__fact' }, icon('circle', { size: 10 }), 'Seen as ' + presence.status));
    }
    if (profile.mutualFriendCount) {
      facts.appendChild(el('div', { class: 'm-profile__fact' }, icon('users', { size: 15 }),
        profile.mutualFriendCount + ' friend' + (profile.mutualFriendCount === 1 ? '' : 's') + ' in common'));
    }
    host.appendChild(facts);

    if ((profile.mutualFriends || []).length) {
      host.appendChild(el('div', { class: 'm-kicker' }, 'Friends in common'));
      host.appendChild(el('div', { class: 'm-card' }, profile.mutualFriends.map((f) => {
        const friend = normalizeUser(f);
        return el('button', { class: 'm-row', type: 'button', onClick: () => navigate(path('/users/' + friend.id)) },
          avatar(friend, { size: 'sm' }),
          el('div', { class: 'm-row__body' }, el('div', { class: 'm-row__name' }, nameOf(friend))),
          el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 16 })));
      })));
    }

    if ((profile.sharedCommunities || []).length) {
      host.appendChild(el('div', { class: 'm-kicker' }, 'Places in common'));
      host.appendChild(el('div', { class: 'm-card' }, profile.sharedCommunities.map((s) => el('button', {
        class: 'm-row', type: 'button', onClick: () => navigate(path('/server/' + s.id)),
      },
        avatar({ id: s.id, name: s.name, iconUrl: s.iconUrl || s.icon_url }, { size: 'sm', rounded: true }),
        el('div', { class: 'm-row__body' }, el('div', { class: 'm-row__name' }, s.name)),
        el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 16 }))))));
    }

    const actions = el('div', { class: 'm-profile__actions' });
    for (const action of profileActions(person, relation, blocked, self)) actions.appendChild(action);
    if (actions.children.length) host.appendChild(actions);
  }

  function profileActions(person, relation, blocked, self) {
    const actions = [];
    if (self) {
      actions.push(el('button', { class: 'm-go', type: 'button', onClick: () => navigate(path('/settings')) }, icon('settings', { size: 17 }), 'Edit your profile'));
      return actions;
    }
    if (relation === 'friend') {
      actions.push(el('button', { class: 'm-go', type: 'button', onClick: async () => {
        try { const dm = await Api.createDm(person.id); await refreshDms(); navigate(path('/dms/' + dm.id)); }
        catch (e) { failed(e); }
      } }, icon('message', { size: 17 }), 'Send a message'));
    }
    if (relation === 'none') {
      actions.push(el('button', { class: 'm-go', type: 'button', onClick: async () => {
        try { await Api.sendFriendRequest(person.id); toast('Asked to be friends', { type: 'success' }); paint(); }
        catch (e) { failed(e); }
      } }, icon('user-plus', { size: 17 }), 'Add as a friend'));
    }
    if (relation === 'pending-in') {
      actions.push(el('button', { class: 'm-go', type: 'button', onClick: async () => {
        try {
          const page = await Api.friendRequests();
          const rows = (page && page.items) || page || [];
          const mine = rows.find((r) => String(((r.from || r.user) || {}).id) === String(person.id));
          if (mine) await Api.acceptFriendRequest(mine.id);
          toast('You are friends now', { type: 'success' });
        } catch (e) { failed(e); }
      } }, icon('check', { size: 17 }), 'Accept their ask'));
    }
    if (relation === 'pending-out') {
      actions.push(el('button', { class: 'm-go m-go--quiet', type: 'button', disabled: true }, 'Asked — waiting'));
    }
    if (blocked) {
      actions.push(el('button', { class: 'm-go m-go--quiet', type: 'button', onClick: async () => {
        try { await Api.unblockUser(person.id); toast('No longer blocked', { type: 'success' }); load(); }
        catch (e) { failed(e); }
      } }, 'Unblock'));
    } else {
      actions.push(el('button', { class: 'm-go m-go--danger', type: 'button', onClick: async () => {
        try { await Api.blockUser(person.id, 'Blocked from their profile'); toast('Blocked', { type: 'success' }); load(); }
        catch (e) { failed(e); }
      } }, 'Block'));
    }
    return actions;
  }

  host.appendChild(hold());
  load().catch((e) => { clear(host); host.appendChild(failure(e, load)); });

  return {
    node: host,
    head: { back: true, title: 'Profile' },
    door: '/you',
    onMount: load,
    cleanup() { version += 1; },
  };
}

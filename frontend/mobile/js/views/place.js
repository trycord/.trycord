// A place: its channels, its voices, its people.
//
// The tree the reader knows — categories with their channels, voice rooms
// named plainly — with the members and the invitations behind the bar.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import {
  State, channelsOf, categoriesOf, isMuted, serverById,
  refreshServerTree, refreshServer,
} from '../../../packages/store.js';
import { navigate, path } from '../../../packages/nav.js';
import { avatar } from '../../../js/ui/primitives.js';
import { current as voice } from '../../../packages/voiceSession.js';
import { join as joinVoice } from '../../../packages/voiceSession.js';
import { sheet, closeSheet, failed, toast, emptyState, hold, failure, field, attachLongPress } from '../ui.js';
import { channelActions, categoryActions, memberActions } from '../actions.js';
import { nameOf, normalizeUser } from '../../../packages/store.js';

export function renderPlace(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'm-stack' });

  let version = 0;
  async function load() {
    const mine = ++version;
    await Promise.allSettled([refreshServer(serverId), refreshServerTree(serverId)]);
    if (mine !== version) return;
    paint();
  }

  function channelRow(channel) {
    const voiceRoom = channel.type === 'voice' || channel.type === 'stage';
    const inRoom = voice() && voice().channelId === channel.id;
    const note = voiceRoom
      ? (inRoom ? 'You are in this room' : 'A voice room')
      : (isMuted(channel.id) ? 'Muted' : '');
    const row = el('button', {
      class: 'm-row', type: 'button',
      onClick: () => navigate(path('/server/' + serverId + '/channel/' + channel.id)),
    },
      el('span', { class: 'm-row__chevron', style: { color: 'var(--text-3)' } }, icon(voiceRoom ? 'volume' : 'hash', { size: 18 })),
      el('div', { class: 'm-row__body' },
        el('div', { class: 'm-row__name' }, channel.name || 'A channel'),
        note ? el('div', { class: 'm-row__note' }, note) : null),
      inRoom ? el('span', { class: 'm-row__pip' }, 'live') : null);
    attachLongPress(row, () => channelActions(serverId, channel, { canManageChannels: mayManage(), onChange: load }));
    return row;
  }

  function mayManage() {
    // The server answers the permission question for real; the row only asks
    // whether the management actions are worth offering.
    const page = State.serverMembers && State.serverMembers.get ? State.serverMembers.get(String(serverId)) : null;
    const roster = Array.isArray(page) ? page : (page && page.items) || [];
    const meRow = roster.find((m) => State.user && String((m.user || m).id) === String(State.user.id));
    return !!(meRow && rowPerms(meRow).indexOf('MANAGE_CHANNELS') !== -1);
  }

  // The permission names a member row carries, from the row or its roles.
  function rowPerms(raw) {
    if (raw && Array.isArray(raw.permissions)) return raw.permissions.map(String);
    const roles = (raw && (raw.roles || raw.roleIds)) || [];
    const perms = [];
    for (const role of roles) for (const p of ((role && role.permissions) || [])) perms.push(String(p));
    if (raw && (raw.isOwner || raw.owner)) perms.push('MANAGE_CHANNELS', 'MANAGE_ROLES', 'KICK_MEMBERS', 'BAN_MEMBERS', 'TIMEOUT_MEMBERS');
    return perms;
  }
  function options2perms(raw) {
    const perms = rowPerms(raw);
    const bag = {};
    for (const p of perms) bag[p] = true;
    return bag;
  }

  function paint() {
    clear(host);
    const server = serverById(serverId);
    if (!server) {
      host.appendChild(emptyState('globe', 'A quiet place', 'This community did not answer. Pull to try again.'));
      return;
    }

    const categories = categoriesOf(serverId);
    const orphans = channelsOf(serverId).filter((c) => !c.categoryId && !c.category_id);

    if (orphans.length) {
      const orphanCard = el('div', { class: 'm-card' }, orphans.map(channelRow));
      orphanCard.addEventListener('contextmenu', (e) => e.preventDefault());
      host.appendChild(orphanCard);
    }
    for (const category of categories) {
      const channels = channelsOf(serverId).filter((ch) => (ch.categoryId || ch.category_id) === category.id);
      if (!channels.length) continue;
      const head = el('div', { class: 'm-kicker' }, category.name || 'Channels');
      attachLongPress(head, () => categoryActions(serverId, category, { canManageChannels: mayManage(), onChange: load }));
      host.appendChild(el('section', { class: 'm-stack' }, head, el('div', { class: 'm-card' }, channels.map(channelRow))));
    }
    if (!categories.length && !orphans.length) {
      host.appendChild(emptyState('hash', 'No channels', 'This place has no rooms yet. The desk makes them; the phone reads them.'));
    }
  }

  function inviteSheet() {
    const layer = sheet({ title: 'Invite someone', note: 'A code is made for you. You can name your own instead.' });
    const code = el('input', { class: 'm-input', type: 'text', placeholder: 'Leave it empty and one is rolled', 'aria-label': 'Invitation code, optional' });
    const go = el('button', { class: 'm-go m-go--block', type: 'button' }, 'Make the code');
    const out = el('p', { class: 'm-sheet__note' });
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const body = code.value.trim() ? { code: code.value.trim() } : {};
        const invite = await Api.createInvite(serverId, body);
        out.textContent = 'The code is ' + (invite.code || invite.id) + '. Anyone who holds it can join.';
        layer.body.appendChild(out);
      } catch (e) { failed(e); go.disabled = false; }
    });
    layer.body.append(field('Code, optional', code), go);
  }

  const membersSheet = async () => {
    const layer = sheet({ title: 'Members' });
    layer.body.appendChild(hold());
    try {
      const rows = await Api.serverMembers(serverId, { limit: 60 });
      clear(layer.body);
      const people = (rows && rows.items) || rows || [];
      if (!people.length) { layer.body.appendChild(emptyState('users', 'No one yet', 'The invitations will fix that.')); return; }
      for (const raw of people) {
        const member = normalizeUser(raw.user || raw);
        const row = el('button', {
          class: 'm-row', type: 'button',
          onClick: () => { layer.close(); navigate(path('/users/' + member.id + '?server=' + serverId)); },
        },
          avatar(member, { size: 'sm' }),
          el('div', { class: 'm-row__body' },
            el('div', { class: 'm-row__name' }, nameOf(member)),
            el('div', { class: 'm-row__note' }, '@' + (member.username || ''))),
          el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 16 })));
        attachLongPress(row, () => memberActions(serverId, member, { perms: options2perms(raw), onChange: load }));
        layer.body.appendChild(row);
      }
    } catch (e) {
      clear(layer.body);
      layer.body.appendChild(failure(e, membersSheet));
    }
  };

  host.appendChild(hold());
  load().catch((e) => { clear(host); host.appendChild(failure(e, load)); });

  return {
    node: host,
    head: {
      title: (serverById(serverId) || {}).name || 'A place',
      back: true,
      actions: [
        el('button', { class: 'm-bar__btn', type: 'button', 'aria-label': 'Members', onClick: membersSheet }, icon('users', { size: 20 })),
        el('button', { class: 'm-bar__btn', type: 'button', 'aria-label': 'Invite', onClick: inviteSheet }, icon('user-plus', { size: 21 })),
      ],
    },
    door: '/communities',
    onMount: load,
    cleanup() { version += 1; },
  };
}

// A place: its channels, its voices, its people.
//
// The tree the reader knows — categories with their channels, voice rooms
// named plainly — with the members and the invitations behind the bar.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import {
  State, channelsOf, categoriesOf, isMuted, serverById,
  refreshServerTree, refreshServer, on as onStore,
} from '../../../packages/store.js';
import { navigate, path } from '../../../packages/nav.js';
import { federatedName, federatedIsJoined } from '../../../packages/places.js';
import { avatar } from '../../../js/ui/primitives.js';
import { current as voice } from '../../../packages/voiceSession.js';
import { join as joinVoice } from '../../../packages/voiceSession.js';
import { sheet, closeSheet, confirm, failed, toast, emptyState, hold, failure, field, attachLongPress } from '../ui.js';
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
      el('span', { class: 'm-row__chevron', style: { color: 'var(--m-ink-3)' } }, icon(voiceRoom ? 'volume' : 'hash', { size: 18 })),
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
      sub: (serverById(serverId) || {}).description || '',
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

// A community on another instance, drawn with this screen's own pieces. It is
// still a place: the same card, the same rows, the same follow action a member
// takes from the Places door. What it cannot do is pretend the community is
// local - its channels and its people belong to the instance that hosts it.

function federatedFor(instanceId, communityId) {
  return (State.federated || []).find((entry) =>
    String(entry.originInstanceId) === String(instanceId)
    && String(entry.originCommunityId) === String(communityId)) || null;
}

export function renderFederatedCommunity(ctx) {
  const instanceId = ctx.params.instanceId;
  const communityId = ctx.params.communityId;
  const host = el('div', { class: 'm-stack' });
  const identity = el('div', { class: 'm-card' });
  const channels = el('div', { class: 'm-card' });
  const relayed = el('div', { class: 'm-card' });
  host.append(identity, channels, relayed);

  const paintIdentity = () => {
    const community = federatedFor(instanceId, communityId);
    const joined = community ? federatedIsJoined(community) : false;
    const origin = community && community.originName ? community.originName : 'another instance';
    clear(identity);
    identity.append(
      el('div', { class: 'm-kicker' }, 'Hosted on ' + origin),
      el('div', { class: 'm-row' },
        el('div', { class: 'm-row__body' },
          el('div', { class: 'm-row__name' }, community ? federatedName(community) : 'A community on another instance'),
          el('div', { class: 'm-row__note' }, community && community.description
            ? community.description
            : 'It lives there, and that instance decides who may read it.')),
        el('button', {
          class: 'm-go' + (joined ? ' m-go--quiet' : ''), type: 'button',
          onClick: async () => {
            try {
              if (joined) {
                if (!(await confirm({
                  title: 'Stop following this community?',
                  text: 'You stop seeing what is relayed. The community itself is not affected — it lives on another instance.',
                  confirmLabel: 'Stop following',
                }))) return;
                await Api.continuumLeaveCommunity(instanceId, communityId);
                toast('You stopped following it', { type: 'success' });
              } else {
                await Api.continuumJoinCommunity(instanceId, communityId);
                toast('You are following it', { type: 'success' });
              }
              await load();
            } catch (error) { failed(error); }
          },
        }, joined ? 'Stop following' : 'Follow')),
      el('p', { class: 'm-sheet__note' },
        'This community is not yours to change. The people on ' + origin
        + ' decide who may read it, who may post, and who may remove whom.'),
    );
  };

  const paintChannels = () => {
    const community = federatedFor(instanceId, communityId);
    const list = (community && community.channels) || [];
    clear(channels);
    channels.appendChild(el('div', { class: 'm-kicker' }, 'Channels'));
    channels.append(...(list.length ? list.map((channel) => el('div', { class: 'm-row' },
      el('span', { class: 'm-row__chevron' }, icon(channel.type === 'voice' ? 'volume' : 'hash', { size: 16 })),
      el('div', { class: 'm-row__body' },
        el('div', { class: 'm-row__name' }, channel.name || 'A channel'),
        el('div', { class: 'm-row__note' }, channel.topic || (channel.canPost ? 'Open to you' : 'Read only'))))) : [
      emptyState('hash', 'No channels published', 'The instance that owns this place has not published any that can be read from here.'),
    ]));
  };

  async function load() {
    paintIdentity();
    paintChannels();
    clear(relayed);
    relayed.append(el('div', { class: 'm-kicker' }, 'What was relayed'), hold());
    try {
      const rows = await Api.continuumRelayedMessages(instanceId, communityId, 40);
      const list = Array.isArray(rows) ? rows : [];
      relayed.append(el('div', { class: 'm-kicker' }, 'What was relayed'),
        ...(list.length ? list.map((entry) => el('div', { class: 'm-row' },
          el('span', { class: 'm-row__chevron' }, icon('message', { size: 16 })),
          el('div', { class: 'm-row__body' },
            el('div', { class: 'm-row__name truncate' }, String(entry.content || '').slice(0, 120) || 'A message'),
            el('div', { class: 'm-row__note' }, (entry.author_name || entry.author || 'Somebody')
              + (entry.created_at ? ' · ' + entry.created_at.slice(0, 16) : ''))))) : [
          emptyState('share', 'Nothing relayed yet', 'Messages reach this instance when somebody here follows the community.'),
        ]));
    } catch (error) {
      clear(relayed);
      relayed.append(el('div', { class: 'm-kicker' }, 'What was relayed'), failure(error, load));
    }
  }

  const off = onStore('federated', () => { paintIdentity(); paintChannels(); });
  return { node: host, onMount: load, cleanup() { off(); } };
}

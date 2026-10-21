// A community, on a phone.
//
// The channel a member is reading, the roster behind a sheet, and the settings
// that administer it. One module, because they are one place: the settings are
// reached from the channel, never from a parallel tree. What a member may change
// is read from the same permission the server sent with the community, so a
// control that would be refused is never drawn.

import { clear, el, replaceChildren } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { avatar, serverMark, empty, loading, failure } from '../components.js';
import {
  State, normalizeUser, nameOf, refreshServer, refreshServerTree,
  refreshServerRoles, refreshServerMembers, isMuted, channelsOf, categoriesOf,
  can, isOwner, serverById, presenceOf, refreshPresence,
} from '../../../packages/store.js';
import { path, navigate, BASE } from '../../../packages/nav.js';
import { setOverride, siblingMount } from '../../../packages/chooser.js';
import { menu, sheet, confirm, toast, attachLongPress } from '../ui.js';
import { personActions, openPerson } from '../person.js';
import {
  iconFor, openChannelEditor, openCategoryEditor,
  channelActions, categoryActions, attachChannelMenu,
} from '../manage.js';
import { copyText } from '../clipboard.js';
import { relativeTime } from '../../../packages/format.js';
import { mediaUrl } from '../../../packages/media.js';
import Api from '../../../packages/api.js';
import { screen, notice, stat } from './util.js';
import { renderConversation } from './messages.js';
import { voiceSection } from './communityVoice.js';
import { joinVoiceCall } from './voiceCall.js';
import { MEMBER_ACTIONS } from '../../../packages/actions.js';
import { current as voiceCurrent } from '../../../packages/voiceSession.js';

export function isVoiceType(type) {
  const clean = String(type || '').toLowerCase();
  return clean === 'voice' || clean === 'stage';
}

function membersOf(serverId) {
  const roster = State.serverMembers.get(serverId);
  return roster && roster.items ? roster.items : [];
}

function sortedChannels(serverId) {
  return channelsOf(serverId).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
}

function selectControl(options) {
  const opts = options || {};
  const node = el('select', { class: 'm-input m-input--select', 'aria-label': opts.label || null });
  for (const choice of opts.choices || []) {
    node.appendChild(el('option', { value: choice.value, selected: String(choice.value) === String(opts.value) ? true : null }, choice.label));
  }
  return node;
}

// -- the channel list sheet --------------------------------------------------

function channelMenu(serverId) {
  const items = [];
  const categories = categoriesOf(serverId);
  const channels = sortedSiblings(serverId);
  const byCategory = new Map();
  const loose = [];
  for (const channel of channels) {
    const key = channel.category_id || channel.categoryId || null;
    if (key && categories.some((c) => c.id === key)) {
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key).push(channel);
    } else loose.push(channel);
  }
  for (const category of categories) {
    const list = byCategory.get(category.id) || [];
    if (!list.length) continue;
    items.push({ header: category.name });
    for (const channel of list) items.push(channelItem(serverId, channel));
  }
  if (loose.length) {
    if (items.length) items.push({ separator: true });
    for (const channel of loose) items.push(channelItem(serverId, channel));
  }
  if (!channels.length) items.push({ label: 'No channels yet', disabled: true });
  return items;
}

function sortedSiblings(serverId) {
  const categories = categoriesOf(serverId);
  const order = new Map(categories.map((c) => [c.id, c.position || 0]));
  const rank = (channel) => {
    const key = channel.category_id || channel.categoryId;
    const value = order.get(key);
    return value === undefined ? -1 : value;
  };
  return channelsOf(serverId).slice().sort((a, b) => (rank(a) - rank(b)) || ((a.position || 0) - (b.position || 0)));
}

function channelItem(serverId, channel) {
  return {
    label: channel.name,
    icon: iconFor(channel),
    checked: isMuted(channel.id) ? true : null,
    onSelect: () => navigate('/server/' + serverId + '/channel/' + channel.id),
  };
}

// The actions of the channel the reader is inside. Muting and the link live
// here rather than buried in the channel jump list, because they act on the
// channel at hand; the list itself stays a list and marks muted channels.
// The actions on the channel the reader is inside. They are the shared ones -
// muting, the link, and the management the permission list allows - so the
// channel screen and the channel list cannot disagree.
function channelActionsSheet(serverId, channel) {
  const route = '/server/' + serverId + '/channel/' + channel.id;
  const items = channelActions(serverId, channel, null);
  if (can(serverId, 'MANAGE_MESSAGES')) {
    items.push({ separator: true });
    items.push({ label: 'Pins', icon: 'pin', onSelect: () => navigate(route + '/pins') });
  }
  menu({ title: '#' + (channel.name || 'channel'), items });
}

function communityMenu(serverId) {
  const items = [];
  items.push({ header: 'Channels' });
  for (const item of channelMenu(serverId)) items.push(item);
  items.push({ separator: true });
  items.push({ label: 'Workspace', icon: 'layers', onSelect: () => navigate('/server/' + serverId + '/workspace') });
  items.push({ label: 'Members', icon: 'users', onSelect: () => navigate('/server/' + serverId + '/members') });
  if (can(serverId, 'MANAGE_ROLES') || isOwner(serverId)) {
    items.push({ label: 'Roles', icon: 'shield', onSelect: () => navigate('/server/' + serverId + '/roles') });
  }
  if (can(serverId, 'CREATE_INVITE') || can(serverId, 'MANAGE_SERVER') || isOwner(serverId)) {
    items.push({ label: 'Invites', icon: 'mail', onSelect: () => navigate('/server/' + serverId + '/invites') });
  }
  if (can(serverId, 'MANAGE_SERVER') || isOwner(serverId)) {
    items.push({ separator: true });
    items.push({ label: 'Categories', icon: 'layers', onSelect: () => navigate('/server/' + serverId + '/categories') });
    items.push({ label: 'Community settings', icon: 'settings', onSelect: () => navigate('/server/' + serverId + '/settings') });
  }
  return items;
}

// -- a text channel ----------------------------------------------------------

function sharedState(serverId) {
  return {
    openSheet() {
      menu({ title: serverById(serverId) ? serverById(serverId).name : 'Community', items: communityMenu(serverId) });
    },
  };
}

export function renderChannel(ctx) {
  const serverId = ctx.serverId;
  const channel = ctx.channel;
  if (!channel) {
    return {
      head: { lead: 'back', title: 'Channel' },
      node: screen(empty({ icon: 'hash', title: 'Channel not found', text: 'That channel is not part of this community.' })),
    };
  }

  if (isVoiceType(channel.type)) {
    // The room, and the way into it.
    //
    // The call is the same call the desktop makes - the same engine, the
    // same server, the same permissions - and it opens in a sheet over the
    // page, because a phone has no room for a floating panel.
    const room = el('div', { class: 'm-state' },
      el('span', { class: 'm-state__icon' }, icon('volume', { size: 24 })),
      el('div', { class: 'm-state__title' }, channel.name + ' is a ' + channel.type + ' channel'),
      el('div', { class: 'm-state__text' },
        'Join the room to talk to the people who are in it. Your browser will ask for the microphone.'));
    const join = el('button', {
      class: 'm-btn m-btn--primary', type: 'button',
      onClick: () => {
        joinVoiceCall({
          id: channel.id,
          serverId,
          name: channel.name,
          type: channel.type,
        });
      },
    }, 'Join the room');
    room.appendChild(join);

    // The room the reader is already in, if it is this one.
    const current_ = voiceCurrent();
    if (current_ && current_.joined && current_.channel
      && String(current_.channel.id) === String(channel.id)) {
      room.appendChild(el('p', { class: 'm-section__note' },
        'You are in this room. Open the call to see who is here.'));
    }

    const node = screen(room);
    return {
      head: { lead: 'back', title: channel.name, sub: 'Voice', mark: el('span', { class: 'm-mark' }, icon('volume', { size: 18 })),
        actions: [el('button', { class: 'm-iconbtn', type: 'button', 'aria-label': 'Community menu', onClick: () => sharedState(serverId).openSheet() }, icon('menu', { size: 20 }))] },
      node,
    };
  }

  const scope = {
    kind: 'channel',
    id: channel.id,
    serverId,
    placeholder: channel.type === 'announcement' ? 'Announce something' : 'Message #' + (channel.name || 'channel'),
    emptyTitle: channel.type === 'announcement' ? 'Nothing announced yet' : 'No messages yet',
    emptyText: 'Be the first to write here.',
    icon: iconFor(channel),
  };
  const conversation = renderConversation(ctx, scope);

  return {
    head: {
      lead: 'back',
      title: channel.name,
      sub: channel.topic || null,
      mark: el('span', { class: 'm-mark' }, icon(iconFor(channel), { size: 18 })),
      actions: [
        el('button', {
          class: 'm-iconbtn', type: 'button', 'aria-label': 'Pinned messages',
          onClick: () => navigate('/server/' + serverId + '/channel/' + channel.id + '/pins'),
        }, icon('pin', { size: 20 })),
        el('button', {
          class: 'm-iconbtn', type: 'button', 'aria-label': 'Channel actions',
          onClick: () => channelActionsSheet(serverId, channel),
        }, icon('dots', { size: 20 })),
        el('button', {
          class: 'm-iconbtn', type: 'button', 'aria-label': 'Community menu',
          onClick: () => sharedState(serverId).openSheet(),
        }, icon('menu', { size: 20 })),
      ],
    },
    node: conversation.node,
    composer: conversation.composer,
    onMount: conversation.onMount,
    cleanup: conversation.cleanup,
  };
}

// -- pinned messages ---------------------------------------------------------

export function renderChannelPins(ctx) {
  const serverId = ctx.serverId;
  const channel = ctx.channel || {};
  const host = el('div', { class: 'm-stack' });
  const node = screen(host);

  async function load() {
    replaceChildren(host, loading('Loading pinned messages'));
    try {
      const pins = await Api.listPins(serverId, channel.id);
      const list = Array.isArray(pins) ? pins : (pins.messages || []);
      replaceChildren(host);
      if (!list.length) {
        host.appendChild(empty({ icon: 'pin', title: 'Nothing pinned', text: 'Pin a message from its menu to keep it here.' }));
        return;
      }
      const rows = el('div', { class: 'm-list' });
      for (const message of list) {
        rows.appendChild(el('button', {
          class: 'm-row', type: 'button',
          onClick: () => navigate('/server/' + serverId + '/channel/' + channel.id + '#m-' + message.id),
        },
          el('span', { class: 'm-row__lead' }, icon('pin', { size: 16 })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title truncate' }, message.content || '(no text)'),
            el('span', { class: 'm-row__sub truncate' }, (message.author_name || message.authorName || 'Someone') + ' \u00b7 ' + relativeTime(message.created_at || message.createdAt)))));
      }
      host.appendChild(el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'Pinned in ' + (channel.name || 'this channel'))), rows));
    } catch (error) {
      replaceChildren(host, failure(error, load));
    }
  }

  return { node, head: { lead: 'back', title: 'Pinned messages' }, onMount: load };
}

// -- members -----------------------------------------------------------------

// The moderation the community's permission list allows. The person sheet
// knows nothing about communities, so the community adds its own entries.
function memberActions(serverId, item, user, reload) {
  const items = [];

  // What each action does, on this shell. The table says which actions there
  // are and what they are called; this says what they do here.
  const handlers = {
    roles: () => openMemberRoles(serverId, item, user, reload),
    timeout: () => openTimeout(serverId, user, reload),
    kick: () => kickMember(serverId, user, reload),
    ban: () => banMember(serverId, user, reload),
    permissions: () => showPermissions(serverId, item, user),
  };

  for (const action of MEMBER_ACTIONS) {
    if (action.needs && !can(serverId, action.needs)) continue;
    // The owner cannot be timed out, kicked or banned by the menu.
    if ((action.id === 'kick' || action.id === 'ban' || action.id === 'timeout')
      && (item.is_owner || item.isOwner)) continue;
    const handler = handlers[action.id];
    if (!handler) continue;
    items.push({ label: action.label, icon: action.icon, onSelect: handler, danger: action.danger });
  }
  return items;
}

// What a member may actually do in a community.
//
// The answer has three parts, and the third is the one that matters: the
// roles they hold, what those roles give, and the places where an override
// makes the community different from the default. A person who may post
// everywhere except in the quiet channel is not a person who may post
// everywhere, and only the override says so.
async function showPermissions(serverId, item, user) {
  const body = el('div', { class: 'm-stack' });
  const layer = sheet({
    title: 'What ' + nameOf(user) + ' may do here',
    body,
  });
  body.appendChild(loading('Reading what this person may do'));
  let preview;
  try {
    preview = await Api.memberPermissions(serverId, item.id);
  } catch (error) {
    replaceChildren(body, failure(error, null));
    return;
  }

  const section = (title, rows) => el('section', { class: 'm-section' },
    el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, title)),
    rows);

  // The roles they hold.
  const roleRows = el('div', { class: 'm-list' });
  if (!preview.roles.length) {
    roleRows.appendChild(empty({
      icon: 'shield', title: 'No roles', text: 'This person holds no role in this community.',
    }));
  }
  for (const role of preview.roles) {
    roleRows.appendChild(el('div', { class: 'm-row' },
      el('span', { class: 'm-row__lead' }, icon('shield', { size: 17 })),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title truncate' }, role.name),
        el('span', { class: 'm-row__sub truncate' },
          role.permissions.length ? role.permissions.join(' · ') : 'Grants nothing on its own'))));
  }

  // What the roles give, across the community.
  const wideRows = el('div', { class: 'm-list' });
  if (preview.isOwner) {
    wideRows.appendChild(empty({
      icon: 'crown', title: 'They hold everything',
      text: 'The owner of a community may do everything in it.',
    }));
  } else if (!preview.permissions.length) {
    wideRows.appendChild(empty({
      icon: 'shield', title: 'Nothing', text: 'Their roles grant nothing across the community.',
    }));
  }
  for (const permission of preview.permissions) {
    wideRows.appendChild(el('div', { class: 'm-row' },
      el('span', { class: 'm-row__lead' }, icon('check', { size: 17 })),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title truncate' }, permission),
        el('span', { class: 'm-row__sub' }, 'Across the community'))));
  }

  // Where the community is different from that.
  const overrideRows = el('div', { class: 'm-list' });
  if (!preview.overrides.length) {
    overrideRows.appendChild(empty({
      icon: 'hash', title: 'Nowhere different',
      text: 'No channel or category here changes what they may do.',
    }));
  }
  for (const entry of preview.overrides) {
    overrideRows.appendChild(el('div', { class: 'm-row' },
      el('span', { class: 'm-row__lead' }, icon('hash', { size: 17 })),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title truncate' }, entry.channelName),
        el('span', { class: 'm-row__sub truncate' },
          entry.changed
            .map((change) => change.permission + ' ' + (change.effect === 'deny' ? 'is refused here' : 'is allowed here'))
            .join(' · ')))));
  }

  replaceChildren(body,
    el('p', { class: 'm-lede' },
      'These are the permissions the server enforces for this person right now.'),
    section('The roles they hold', roleRows),
    section('What that gives', wideRows),
    section('Where it is different', overrideRows),
  );
}

// One member, drawn. The presence is written twice - as the dot on the face and
// as the word beside the name - because a dot is a colour and a colour is not
// a sentence for a reader who cannot see it.
function memberRow(serverId, item, reload) {
  const user = normalizeUser(item);
  const roles = (item.roles || []).map((r) => (typeof r === 'string' ? r : r.name)).filter(Boolean);
  const status = presenceOf(user.id);
  const node = el('button', {
    class: 'm-row m-row--member', type: 'button',
    onClick: () => openPerson(user, { extra: memberActions(serverId, item, user, reload) }),
  },
    el('span', { class: 'm-row__lead' }, avatar(user, { size: 'md', presence: true, decorative: true })),
    el('span', { class: 'm-row__body' },
      el('span', { class: 'm-row__title truncate' }, nameOf(user)),
      el('span', { class: 'm-row__sub truncate' }, '@' + (user.username || '')
        + (roles.length ? ' \u00b7 ' + roles.join(', ') : (item.is_owner ? ' \u00b7 Owner' : '')))),
    el('span', { class: 'm-row__trailing' },
      el('span', { class: 'm-member-presence', dataset: { presence: status } }, PRESENCE_LABEL[status] || 'Offline')));
  attachLongPress(node, () => personActions(user, { extra: memberActions(serverId, item, user, reload) }),
    { title: nameOf(user) });
  return node;
}

const PRESENCE_LABEL = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do not disturb',
  offline: 'Offline',
};

function openTimeout(serverId, user, reload) {
  const minutes = el('input', { class: 'm-input', type: 'number', min: '0', max: '10080', value: '60', 'aria-label': 'Minutes' });
  const layer = sheet({
    title: 'Timeout ' + nameOf(user),
    body: el('div', { class: 'm-stack' },
      el('p', { class: 'm-lede' }, 'How long they cannot speak. Zero lifts it.'),
      minutes),
    footer: el('button', {
      class: 'm-btn m-btn--block m-btn--primary', type: 'button',
      onClick: async () => {
        try {
          await Api.timeoutMember(serverId, user.id, Number(minutes.value || 0));
          layer.close();
          toast('Timeout updated.', { type: 'success' });
          reload();
        } catch (error) { toast(error.message, { type: 'danger' }); }
      },
    }, 'Apply'),
  });
}

async function kickMember(serverId, user, reload) {
  const sure = await confirm({ title: 'Remove ' + nameOf(user) + '?', text: 'They can join again with a new invite.', confirmLabel: 'Remove', danger: true });
  if (!sure) return;
  try { await Api.kickMember(serverId, user.id); toast('Removed.', { type: 'success' }); reload(); }
  catch (error) { toast(error.message, { type: 'danger' }); }
}

async function banMember(serverId, user, reload) {
  const sure = await confirm({ title: 'Ban ' + nameOf(user) + '?', text: 'They cannot return until unbanned.', confirmLabel: 'Ban', danger: true });
  if (!sure) return;
  try { await Api.banMember(serverId, user.id, ''); toast('Banned.', { type: 'success' }); reload(); }
  catch (error) { toast(error.message, { type: 'danger' }); }
}

async function openMemberRoles(serverId, item, user, reload) {
  let roles;
  try { roles = await Api.roles(serverId); } catch (error) { toast(error.message, { type: 'danger' }); return; }
  const held = new Set((item.roles || []).map((r) => (typeof r === 'string' ? r : r.id)));
  const boxes = new Map();
  const list = el('div', { class: 'm-list' });
  for (const role of roles) {
    const box = el('input', { type: 'checkbox', checked: held.has(role.id) ? true : null });
    boxes.set(role.id, { box, was: held.has(role.id) });
    list.appendChild(el('label', { class: 'm-row m-row--check' }, box,
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title' }, role.name),
        el('span', { class: 'm-row__sub' }, (role.permissions || []).length + ' permissions'))));
  }
  const layer = sheet({
    title: 'Roles for ' + nameOf(user),
    body: list,
    footer: el('button', {
      class: 'm-btn m-btn--block m-btn--primary', type: 'button',
      onClick: async (event) => {
        event.currentTarget.disabled = true;
        try {
          for (const [roleId, entry] of boxes) {
            if (entry.box.checked && !entry.was) await Api.assignRole(serverId, roleId, user.id);
            else if (!entry.box.checked && entry.was) await Api.unassignRole(serverId, roleId, user.id);
          }
          layer.close();
          toast('Roles updated.', { type: 'success' });
          reload();
        } catch (error) { toast(error.message, { type: 'danger' }); event.currentTarget.disabled = false; }
      },
    }, 'Save'),
  });
}

export function renderMembersPage(ctx) {
  return membersScreen(ctx.serverId, 'Members', 'Everyone in this community.');
}

export function renderRolesPage(ctx) {
  return rolesScreen(ctx.serverId);
}

export function renderInvitesPage(ctx) {
  return invitesScreen(ctx.serverId);
}

export function renderCategoriesPage(ctx) {
  return categoriesScreen(ctx.serverId);
}

// The roster, on a phone. It pages, it searches, and it says who is here.
//
// The server answers with { items, total, hasMore }, so a large community is
// a first page and a button rather than a truncated list that claims to be the
// whole thing. The search is the server's own.
function membersScreen(serverId, title, sub) {
  const host = el('div', { class: 'm-stack' });
  const node = screen(el('div', { class: 'm-hero m-hero--quiet' },
    el('h1', { class: 'm-hero__title' }, title), el('div', { class: 'm-hero__sub' }, sub)), host);

  const search = el('input', {
    class: 'm-input m-input--search', type: 'search',
    placeholder: 'Search members', 'aria-label': 'Search the members of this community',
    autocomplete: 'off', spellcheck: 'false',
  });
  const list = el('div', { class: 'm-list' });
  const note = el('div', { class: 'm-section__note' });
  const more = el('div', { class: 'm-actions' });

  const items = [];
  let total = 0;
  let hasMore = false;
  let query = '';
  let loading = false;

  function paint() {
    replaceChildren(list);
    for (const item of items) list.appendChild(memberRow(serverId, item, load));
    note.textContent = total ? items.length + ' of ' + total : String(items.length);
    replaceChildren(more, hasMore
      ? el('button', { class: 'm-btn m-btn--block m-btn--ghost', type: 'button', onClick: () => loadMore() }, 'Load more members')
      : null);
  }

  async function fetchPage(offset) {
    const params = { limit: 50 };
    if (offset) params.offset = offset;
    if (query) params.q = query;
    const page = await Api.serverMembers(serverId, params);
    return {
      items: (page && page.items) || [],
      total: (page && page.total) || 0,
      hasMore: !!(page && page.hasMore),
    };
  }

  async function load() {
    loading = true;
    replaceChildren(list, loading('Reading the roster'));
    replaceChildren(more);
    try {
      const page = await fetchPage(0);
      items.length = 0;
      for (const item of page.items) items.push(item);
      total = page.total;
      hasMore = page.hasMore;
      paint();
      refreshPresence(items.map((item) => item.id)).catch(() => {});
    } catch (error) {
      replaceChildren(list, failure(error, load));
    } finally {
      loading = false;
    }
  }

  async function loadMore() {
    if (loading || !hasMore) return;
    loading = true;
    replaceChildren(more, el('div', { class: 'm-loading' }, 'Reading more'));
    try {
      const page = await fetchPage(items.length);
      for (const item of page.items) {
        if (!items.some((known) => String(known.id) === String(item.id))) items.push(item);
      }
      total = page.total;
      hasMore = page.hasMore;
      paint();
      refreshPresence(page.items.map((item) => item.id)).catch(() => {});
    } catch (error) {
      replaceChildren(more, failure(error, loadMore));
    } finally {
      loading = false;
    }
  }

  let timer = null;
  search.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      query = search.value.trim();
      load();
    }, 240);
  });

  const section = el('section', { class: 'm-section' },
    el('div', { class: 'm-section__head' },
      el('div', { class: 'm-section__title' }, 'Members'), note),
    search, list, more);

  host.appendChild(section);
  return { node, head: { lead: 'back', title }, onMount: load };
}

// -- roles -------------------------------------------------------------------

function rolesScreen(serverId) {
  const host = el('div', { class: 'm-stack' });
  const node = screen(host);
  const newButton = el('button', {
    class: 'm-btn m-btn--sm m-btn--primary', type: 'button',
    onClick: () => openRoleEditor(serverId, null, load),
  }, 'New role');

  async function load() {
    replaceChildren(host, loading('Loading roles'));
    try {
      await refreshServerRoles(serverId);
      const roles = State.serverRoles.get(serverId) || [];
      replaceChildren(host);
      if (!roles.length) {
        host.appendChild(empty({ icon: 'shield', title: 'No roles', text: 'Every community has at least one role.' }));
        return;
      }
      const list = el('div', { class: 'm-list' });
      for (const role of roles) {
        list.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__lead' }, el('span', { class: 'm-role-dot', style: role.color ? { background: role.color } : null })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, role.name),
            el('span', { class: 'm-row__sub' }, role.is_default ? 'Baseline role, held by everyone' : (role.permissions || []).length + ' permissions')),
          el('span', { class: 'm-row__actions' },
            el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => openRoleEditor(serverId, role, load) }, 'Edit'),
            role.is_default ? null : el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', 'aria-label': 'Delete role', onClick: () => deleteRole(serverId, role, load) }, 'Delete'))));
      }
      host.appendChild(el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'Roles'), newButton), list));
    } catch (error) {
      replaceChildren(host, failure(error, load));
    }
  }

  return { node, head: { lead: 'back', title: 'Roles' }, onMount: load };
}

async function openRoleEditor(serverId, role, reload) {
  let catalogue;
  try { catalogue = await Api.rolePermissions(serverId); } catch (error) { toast(error.message, { type: 'danger' }); return; }
  const editing = !!role;
  const name = el('input', { class: 'm-input', type: 'text', value: role ? role.name : '', placeholder: 'Role name', maxlength: '32', 'aria-label': 'Role name' });
  if (role && role.is_default) name.disabled = true;
  const color = el('input', { class: 'm-input m-input--color', type: 'color', value: role && role.color ? role.color : '#99aab5', 'aria-label': 'Role colour' });
  const selected = new Set(role && role.permissions ? role.permissions : []);
  const descriptions = catalogue.descriptions || {};
  const grid = el('div', { class: 'm-perms' });
  for (const key of (catalogue.all || []).slice().sort()) {
    const box = el('input', { type: 'checkbox', class: 'm-check', checked: selected.has(key) ? true : null });
    box.addEventListener('change', () => { if (box.checked) selected.add(key); else selected.delete(key); });
    grid.appendChild(el('label', { class: 'm-check-row' }, box, el('span', {}, descriptions[key] || key)));
  }
  const layer = sheet({
    title: editing ? 'Edit ' + role.name : 'New role',
    body: el('div', { class: 'm-stack' },
      el('label', { class: 'm-field' }, el('span', { class: 'm-field__label' }, 'Name'), name),
      el('label', { class: 'm-field' }, el('span', { class: 'm-field__label' }, 'Colour'), color),
      el('div', { class: 'm-section__title' }, 'Permissions'), grid),
    footer: el('button', {
      class: 'm-btn m-btn--block m-btn--primary', type: 'button',
      onClick: async (event) => {
        event.currentTarget.disabled = true;
        try {
          const payload = { name: name.value.trim(), color: color.value, permissions: Array.from(selected) };
          if (editing) await Api.updateRole(serverId, role.id, payload);
          else await Api.createRole(serverId, payload);
          layer.close();
          toast(editing ? 'Role saved.' : 'Role created.', { type: 'success' });
          reload();
        } catch (error) { toast(error.message, { type: 'danger' }); event.currentTarget.disabled = false; }
      },
    }, editing ? 'Save' : 'Create'),
  });
}

async function deleteRole(serverId, role, reload) {
  const sure = await confirm({ title: 'Delete ' + role.name + '?', text: 'Members lose it immediately.', confirmLabel: 'Delete', danger: true });
  if (!sure) return;
  try { await Api.deleteRole(serverId, role.id); toast('Role deleted.', { type: 'success' }); reload(); }
  catch (error) { toast(error.message, { type: 'danger' }); }
}

// -- invites -----------------------------------------------------------------

function inviteState(invite) {
  if (invite.revoked) return 'revoked';
  if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now()) return 'expired';
  if (invite.max_uses !== null && invite.max_uses !== undefined && invite.uses >= invite.max_uses) return 'exhausted';
  return 'active';
}

function invitesScreen(serverId) {
  const host = el('div', { class: 'm-stack' });
  const node = screen(host);
  const newButton = el('button', {
    class: 'm-btn m-btn--sm m-btn--primary', type: 'button',
    onClick: () => openInvite(serverId, load),
  }, 'New invite');

  async function load() {
    replaceChildren(host, loading('Loading invites'));
    try {
      const invites = await Api.invites(serverId);
      const list = Array.isArray(invites) ? invites : (invites.invites || []);
      replaceChildren(host);
      if (!list.length) {
        host.appendChild(empty({ icon: 'mail', title: 'No invites', text: 'Make one and share the code.' }));
        return;
      }
      const rows = el('div', { class: 'm-list' });
      for (const invite of list) {
        const state = inviteState(invite);
        const used = (invite.uses || 0) + (invite.max_uses ? ' / ' + invite.max_uses : '');
        rows.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__lead' }, el('span', { class: 'm-chip m-chip--' + state }, invite.code)),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title truncate' }, invite.creator_name ? 'by ' + invite.creator_name : state),
            el('span', { class: 'm-row__sub' }, 'used ' + used)),
          el('span', { class: 'm-row__actions' },
            el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => copyText(invite.code) }, 'Copy'),
            el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => revokeInvite(serverId, invite, load) }, 'Revoke'))));
      }
      host.appendChild(el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'Invites'), newButton), rows));
    } catch (error) {
      replaceChildren(host, failure(error, load));
    }
  }

  return { node, head: { lead: 'back', title: 'Invites' }, onMount: load };
}

function openInvite(serverId, reload) {
  const uses = el('input', { class: 'm-input', type: 'number', min: '1', max: '100', placeholder: 'Unlimited', 'aria-label': 'Uses' });
  const hours = el('input', { class: 'm-input', type: 'number', min: '1', placeholder: 'Never', 'aria-label': 'Expires after hours' });
  const layer = sheet({
    title: 'New invite',
    body: el('div', { class: 'm-stack' },
      el('p', { class: 'm-lede' }, 'A code, bounded by uses and time.'),
      el('label', { class: 'm-field' }, el('span', { class: 'm-field__label' }, 'Uses'), uses),
      el('label', { class: 'm-field' }, el('span', { class: 'm-field__label' }, 'Expires after (hours)'), hours)),
    footer: el('button', {
      class: 'm-btn m-btn--block m-btn--primary', type: 'button',
      onClick: async (event) => {
        event.currentTarget.disabled = true;
        try {
          const out = await Api.createInvite(serverId, {
            maxUses: uses.value ? Number(uses.value) : null,
            expiresInHours: hours.value ? Number(hours.value) : null,
          });
          layer.close();
          if (out && out.code) copyText(out.code);
          else toast('Invite created.', { type: 'success' });
          reload();
        } catch (error) { toast(error.message, { type: 'danger' }); event.currentTarget.disabled = false; }
      },
    }, 'Create'),
  });
}

async function revokeInvite(serverId, invite, reload) {
  const sure = await confirm({ title: 'Revoke ' + invite.code + '?', text: 'Anyone holding it can no longer join.', confirmLabel: 'Revoke', danger: true });
  if (!sure) return;
  try { await Api.deleteInvite(serverId, invite.id); toast('Invite revoked.', { type: 'success' }); reload(); }
  catch (error) { toast(error.message, { type: 'danger' }); }
}

// -- categories --------------------------------------------------------------

function categoriesScreen(serverId) {
  const host = el('div', { class: 'm-stack' });
  const node = screen(host);
  const newButton = el('button', {
    class: 'm-btn m-btn--sm m-btn--primary', type: 'button',
    onClick: () => openCategoryEditor(serverId, null, load),
  }, 'New category');

  async function load() {
    replaceChildren(host, loading('Loading categories'));
    try {
      await refreshServerTree(serverId);
      const channels = channelsOf(serverId);
      const categories = (State.serverTree.get(serverId) ? (State.serverTree.get(serverId).categories || []) : [])
        .map((category) => ({ ...category, count: channels.filter((c) => c.category_id === category.id).length }));
      replaceChildren(host);
      if (!categories.length) {
        host.appendChild(empty({ icon: 'layers', title: 'No categories', text: 'Group channels to keep the list short.' }));
        return;
      }
      const list = el('div', { class: 'm-list' });
      for (const category of categories) {
        const row = el('button', {
          class: 'm-row m-row--category', type: 'button',
          onClick: () => openCategoryEditor(serverId, category, load),
        },
          el('span', { class: 'm-row__lead' }, icon('layers', { size: 17 })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, category.name),
            el('span', { class: 'm-row__sub' }, category.count + (category.count === 1 ? ' channel' : ' channels'))));
        // A long press on a category raises the actions that belong to it.
        attachLongPress(row, () => categoryActions(serverId, category, load), { title: category.name });
        list.appendChild(row);
      }
      host.appendChild(el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'Categories'), newButton), list));
    } catch (error) {
      replaceChildren(host, failure(error, load));
    }
  }

  return { node, head: { lead: 'back', title: 'Categories' }, onMount: load };
}

// -- channels ----------------------------------------------------------------

// The channel list. Every action here is the shared one from mobile/manage.js,
// so the settings section and the community's own list cannot disagree.
function channelsSection(serverId) {
  const host = el('div', { class: 'm-stack' });
  const newButton = el('button', {
    class: 'm-btn m-btn--sm m-btn--primary', type: 'button',
    onClick: () => openChannelEditor(serverId, null, load),
  }, 'New channel');

  async function load() {
    replaceChildren(host, loading('Loading channels'));
    try {
      await refreshServerTree(serverId, { force: true });
      const channels = sortedSiblings(serverId);
      replaceChildren(host);
      if (!channels.length) {
        host.appendChild(empty({ icon: 'hash', title: 'No channels', text: 'Make one so people can talk.' }));
        return;
      }
      const list = el('div', { class: 'm-list' });
      for (const channel of channels) {
        const row = el('button', {
          class: 'm-row m-row--channel', type: 'button',
          onClick: () => navigate('/server/' + serverId + '/channel/' + channel.id),
        },
          el('span', { class: 'm-row__lead' }, icon(iconFor(channel), { size: 17 })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title truncate' }, channel.name),
            channel.topic ? el('span', { class: 'm-row__sub truncate' }, channel.topic) : null));
        // A long press on a channel raises the actions that belong to it.
        attachChannelMenu(row, serverId, channel, load);
        list.appendChild(row);

        // The people in a voice room are shown under it, so a member can see
        // who is in there before they join it.
        const people = (channel.participants || []);
        if (!people.length) continue;
        list.appendChild(el('div', { class: 'm-room__people' },
          ...people.map((person) => el('span', { class: 'm-room__person' },
            avatar({
              id: person.userId,
              username: person.username,
              displayName: person.displayName,
              avatarUrl: person.avatarUrl,
            }, { size: 'xs', decorative: true }),
            el('span', { class: 'truncate' }, person.displayName || person.username || 'Someone')))));
      }
      host.appendChild(el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'Channels'), newButton), list));
    } catch (error) {
      replaceChildren(host, failure(error, load));
    }
  }

  return { node: host, load };
}

// -- settings sections -------------------------------------------------------

const SETTINGS_SECTIONS = [
  ['overview', 'Overview', 'settings'],
  ['appearance', 'Appearance', 'image'],
  ['channels', 'Channels', 'hash'],
  ['categories', 'Categories', 'layers'],
  ['members', 'Members', 'users'],
  ['roles', 'Roles', 'shield'],
  ['invites', 'Invites', 'mail'],
  ['moderation', 'Moderation', 'flag'],
  ['rules', 'Rules', 'shield'],
  ['voice', 'Voice and video', 'mic'],
  ['onboarding', 'Onboarding', 'help'],
  ['integrations', 'Integrations', 'rocket'],
  ['analytics', 'Analytics', 'chart'],
  ['ownership', 'Ownership', 'crown'],
];

export function renderCommunitySettings(ctx) {
  const serverId = ctx.serverId;
  const server = serverById(serverId) || {};
  if (!can(serverId, 'MANAGE_SERVER') && !isOwner(serverId)) {
    return {
      head: { lead: 'back', title: 'Community settings' },
      node: screen(empty({ icon: 'shield', title: 'Not your call', text: 'Only administrators can change this community.' })),
    };
  }
  const initial = String(ctx.query.get('section') || 'overview');
  const active = builders()[initial] ? initial : 'overview';
  const host = el('div', { class: 'm-stack' });
  const strip = el('div', { class: 'm-seg m-seg--scroll', role: 'tablist', 'aria-label': 'Community settings' });

  const node = screen(
    el('div', { class: 'm-hero m-hero--quiet' }, el('h1', { class: 'm-hero__title' }, server.name || 'Community'), el('div', { class: 'm-hero__sub' }, 'Settings')),
    strip, host);

  for (const [id, label] of SETTINGS_SECTIONS) {
    strip.appendChild(el('button', {
      class: 'm-seg__item' + (id === active ? ' is-active' : ''),
      type: 'button', role: 'tab', 'aria-selected': id === active ? 'true' : 'false',
      onClick: () => show(id),
    }, label));
  }

  let current = null;
  function show(id) {
    for (const button of strip.children) button.classList.toggle('is-active', button.textContent === labelOf(id));
    for (const button of strip.children) button.setAttribute('aria-selected', button.textContent === labelOf(id) ? 'true' : 'false');
    if (current && current.cleanup) current.cleanup();
    replaceChildren(host, loading('Loading'));
    const section = builders()[id]();
    current = section;
    replaceChildren(host, section.node);
    if (section.load) section.load();
  }

  function labelOf(id) {
    const entry = SETTINGS_SECTIONS.find(([key]) => key === id);
    return entry ? entry[1] : id;
  }

  function builders() {
    return {
      overview: () => overviewSection(serverId),
      appearance: () => appearanceSection(serverId),
      channels: () => sectionWrap(channelsSection(serverId), 'Channels'),
      categories: () => sectionWrap(categoriesScreen(serverId), 'Categories'),
      members: () => sectionWrap(membersScreen(serverId, 'Members', ''), 'Members'),
      roles: () => sectionWrap(rolesScreen(serverId), 'Roles'),
      invites: () => sectionWrap(invitesScreen(serverId), 'Invites'),
      moderation: () => moderationSection(serverId),
      voice: () => voiceSection(serverId),
      integrations: () => integrationsSection(serverId),
      analytics: () => analyticsSection(serverId),
      ownership: () => ownershipSection(serverId),
    };
  }

  return { node, head: { lead: 'back', title: 'Community settings' }, onMount: () => show(active) };
}

// A section built as a screen (with its own hero) is reduced to its node so it
// sits inside the settings scroll without a second title.
function sectionWrap(screenResult, title) {
  return {
    node: el('div', { class: 'm-stack' }, el('div', { class: 'm-section__title' }, title), screenResult.node),
    load: screenResult.onMount || screenResult.load,
    cleanup: screenResult.cleanup,
  };
}

function field(label, control, note) {
  return el('label', { class: 'm-field' },
    el('span', { class: 'm-field__label' }, label), control,
    note ? el('span', { class: 'm-field__note' }, note) : null);
}

function overviewSection(serverId) {
  const server = serverById(serverId) || {};
  const name = el('input', { class: 'm-input', type: 'text', value: server.name || '', maxlength: '60', 'aria-label': 'Community name' });
  const description = el('textarea', { class: 'm-input m-input--area', rows: '3', maxlength: '400', 'aria-label': 'Description' }, server.description || '');
  const isPublic = el('input', { type: 'checkbox', class: 'm-check', checked: server.is_public ? true : null });
  const isDiscoverable = el('input', { type: 'checkbox', class: 'm-check', checked: server.is_discoverable ? true : null });
  const save = el('button', { class: 'm-btn m-btn--block m-btn--primary', type: 'button' }, 'Save changes');
  const node = el('div', { class: 'm-stack' },
    field('Name', name),
    field('Description', description),
    el('label', { class: 'm-check-row' }, isPublic, el('span', {}, 'Public — anyone with the link may read the preview')),
    el('label', { class: 'm-check-row' }, isDiscoverable, el('span', {}, 'Discoverable — appears in Discover searches')),
    save);
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await Api.updateServer(serverId, { name: name.value.trim(), description: description.value, isPublic: isPublic.checked, isDiscoverable: isDiscoverable.checked });
      await refreshServer(serverId).catch(() => {});
      toast('Community saved.', { type: 'success' });
    } catch (error) { toast(error.message, { type: 'danger' }); }
    finally { save.disabled = false; }
  });
  return { node };
}

function appearanceSection(serverId) {
  const host = el('div', { class: 'm-stack' });
  const build = () => {
    const server = serverById(serverId) || {};
    replaceChildren(host);
    const iconPreview = el('div', { class: 'm-media-preview' }, serverMark(server, { size: 'lg' }));
    const bannerPreview = el('div', { class: 'm-media-preview m-media-preview--wide' });
    if (server.banner_url) {
      const img = el('img', { class: 'm-media-img', alt: '' });
      mediaUrl(server.banner_url).then((src) => { if (src) img.src = src; }).catch(() => {});
      bannerPreview.appendChild(img);
    } else {
      bannerPreview.appendChild(icon('image', { size: 22 }));
    }
    host.append(
      el('div', { class: 'm-media-row' }, iconPreview,
        el('div', { class: 'm-actions' },
          el('button', { class: 'm-btn m-btn--ghost', type: 'button', onClick: () => pickServerImage(serverId, 'icon', load) }, 'Change icon'),
          server.icon_url ? el('button', { class: 'm-btn m-btn--ghost', type: 'button', onClick: () => removeServerImage(serverId, 'icon', load) }, 'Remove') : null)),
      el('div', { class: 'm-media-row' }, bannerPreview,
        el('div', { class: 'm-media-controls' },
          el('button', { class: 'm-btn m-btn--ghost', type: 'button', onClick: () => pickServerImage(serverId, 'banner', load) }, 'Change banner'),
          server.banner_url ? el('button', { class: 'm-btn m-btn--ghost', type: 'button', onClick: () => removeServerImage(serverId, 'banner', load) }, 'Remove') : null)));
  };
  async function load() {
    try { await refreshServer(serverId); } catch { /* the form still edits what it has */ }
    build();
  }
  return { node: host, load };
}

function pickServerImage(serverId, kind, done) {
  const input = el('input', { type: 'file', accept: 'image/*', class: 'visually-hidden' });
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    try { await Api.setServerImage(serverId, kind, file); toast('Image updated.', { type: 'success' }); if (done) done(); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  });
  input.click();
}

async function removeServerImage(serverId, kind, done) {
  try { await Api.removeServerImage(serverId, kind); toast('Image removed.', { type: 'success' }); if (done) done(); }
  catch (error) { toast(error.message, { type: 'danger' }); }
}

function moderationSection(serverId) {
  const host = el('div', { class: 'm-stack' });
  async function load() {
    replaceChildren(host, loading('Loading bans'));
    try {
      const out = await Api.bans(serverId);
      const bans = Array.isArray(out) ? out : (out.bans || out.items || []);
      replaceChildren(host);
      if (!bans.length) {
        host.appendChild(empty({ icon: 'ban', title: 'Nobody is banned', text: 'People you ban appear here, and can be unbanned.' }));
        return;
      }
      const list = el('div', { class: 'm-list' });
      for (const ban of bans) {
        const id = ban.user_id || ban.userId || ban.id;
        const name = ban.display_name || ban.displayName || ban.username || id;
        list.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, name),
            ban.reason ? el('span', { class: 'm-row__sub' }, ban.reason) : null),
          el('span', { class: 'm-row__actions' },
            el('button', {
              class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
              onClick: async () => {
                try { await Api.unbanMember(serverId, id); toast('Unbanned.', { type: 'success' }); load(); }
                catch (error) { toast(error.message, { type: 'danger' }); }
              },
            }, 'Unban'))));
      }
      host.appendChild(el('section', { class: 'm-section' }, el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'Banned')), list));
    } catch (error) {
      replaceChildren(host, failure(error, load));
    }
  }
  return { node: host, load };
}

function integrationsSection(serverId) {
  const host = el('div', { class: 'm-stack' });
  const newButton = el('button', {
    class: 'm-btn m-btn--sm m-btn--primary', type: 'button',
    onClick: () => createWebhook(serverId, load),
  }, 'New webhook');

  async function load() {
    replaceChildren(host, loading('Loading webhooks'));
    try {
      const out = await Api.webhooks(serverId);
      const hooks = Array.isArray(out) ? out : (out.webhooks || []);
      replaceChildren(host);
      if (!hooks.length) {
        host.appendChild(empty({ icon: 'webhook', title: 'No webhooks', text: 'Notify another service about what happens here.' }));
        return;
      }
      const list = el('div', { class: 'm-list' });
      for (const hook of hooks) {
        list.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__lead' }, icon('webhook', { size: 17 })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title truncate' }, hook.name || hook.url || hook.id),
            el('span', { class: 'm-row__sub truncate' }, hook.url || '')),
          el('span', { class: 'm-row__actions' },
            el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => rotateWebhook(serverId, hook, load) }, 'Rotate'),
            el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => deleteWebhook(serverId, hook, load) }, 'Delete'))));
      }
      host.appendChild(el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'Webhooks'), newButton), list));
    } catch (error) {
      replaceChildren(host, failure(error, load));
    }
  }

  return { node: host, load };
}

function createWebhook(serverId, reload) {
  const name = el('input', { class: 'm-input', type: 'text', placeholder: 'Name', maxlength: '60', 'aria-label': 'Webhook name' });
  const url = el('input', { class: 'm-input', type: 'url', placeholder: 'https://...', maxlength: '400', 'aria-label': 'Endpoint URL' });
  const layer = sheet({
    title: 'New webhook',
    body: el('div', { class: 'm-stack' }, field('Name', name), field('Endpoint', url)),
    footer: el('button', {
      class: 'm-btn m-btn--block m-btn--primary', type: 'button',
      onClick: async (event) => {
        event.currentTarget.disabled = true;
        try {
          await Api.createWebhook(serverId, { name: name.value.trim(), url: url.value.trim() });
          layer.close();
          toast('Webhook created.', { type: 'success' });
          reload();
        } catch (error) { toast(error.message, { type: 'danger' }); event.currentTarget.disabled = false; }
      },
    }, 'Create'),
  });
}

async function rotateWebhook(serverId, hook, reload) {
  try {
    const out = await Api.rotateWebhookSecret(serverId, hook.id);
    if (out && out.secret) toast('New secret: ' + out.secret, { type: 'info' });
    else toast('Secret rotated.', { type: 'success' });
    reload();
  } catch (error) { toast(error.message, { type: 'danger' }); }
}

async function deleteWebhook(serverId, hook, reload) {
  const sure = await confirm({ title: 'Delete webhook?', text: hook.name || hook.url || '', confirmLabel: 'Delete', danger: true });
  if (!sure) return;
  try { await Api.deleteWebhook(serverId, hook.id); toast('Webhook deleted.', { type: 'success' }); reload(); }
  catch (error) { toast(error.message, { type: 'danger' }); }
}

function analyticsSection(serverId) {
  const host = el('div', { class: 'm-stack' });
  async function load() {
    replaceChildren(host, loading('Reading activity'));
    try {
      const report = await Api.analytics(serverId, 30);
      replaceChildren(host, render(report));
    } catch (error) {
      replaceChildren(host, failure(error, load));
    }
  }
  function render(report) {
    const totals = report.totals || {};
    const averages = report.averages || {};
    const frag = document.createDocumentFragment();
    const stats = el('div', { class: 'm-strip' },
      stat(String(totals.messages || 0), 'messages / ' + (report.windowDays || 30) + 'd'),
      stat(String(totals.members || 0), 'members'),
      stat(String(totals.channels || 0), 'channels'),
      stat(String(averages.messagesPerActiveDay || 0), 'msgs / active day'));
    frag.appendChild(stats);
    if ((report.topChannels || []).length) {
      frag.appendChild(el('div', { class: 'm-section__title' }, 'Busiest channels'));
      const list = el('div', { class: 'm-list' });
      for (const channel of report.topChannels) {
        list.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, channel.name || channel.channel_name || channel.id)),
          el('span', { class: 'm-row__actions' }, String(channel.messages || 0))));
      }
      frag.appendChild(list);
    }
    if ((report.topMembers || []).length) {
      frag.appendChild(el('div', { class: 'm-section__title' }, 'Most active'));
      const list = el('div', { class: 'm-list' });
      for (const member of report.topMembers) {
        list.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, member.name || member.display_name || member.username || member.id)),
          el('span', { class: 'm-row__actions' }, String(member.messages || 0))));
      }
      frag.appendChild(list);
    }
    return frag;
  }
  return { node: host, load };
}

function ownershipSection(serverId) {
  const host = el('div', { class: 'm-stack' });
  const chooser = selectControl({ label: 'New owner', value: '', choices: [{ value: '', label: 'Choose a member' }] });
  const transferButton = el('button', { class: 'm-btn m-btn--primary m-btn--block', type: 'button' }, 'Transfer ownership');
  const deleteButton = el('button', { class: 'm-btn m-btn--ghost m-btn--block m-btn--danger', type: 'button' }, 'Delete community');
  host.append(
    notice({ title: 'Transfer ownership', text: 'Hand this community to another member. You keep only their permissions.' }),
    chooser, transferButton,
    notice({ title: 'Delete community', text: 'Deletes this community and everything in it. This cannot be undone.', tone: 'danger' }),
    deleteButton);

  deleteButton.addEventListener('click', async () => {
    const sure = await confirm({ title: 'Delete this community?', text: 'Every channel, message and membership goes.', confirmLabel: 'Delete', danger: true });
    if (!sure) return;
    try {
      await Api.deleteServer(serverId);
      const { refreshServers } = await import('../../../packages/store.js');
      await refreshServers().catch(() => {});
      navigate('/home');
    } catch (error) { toast(error.message, { type: 'danger' }); }
  });

  transferButton.addEventListener('click', async () => {
    if (!chooser.value) { toast('Choose a member first.', { type: 'info' }); return; }
    const sure = await confirm({ title: 'Transfer ownership?', text: 'You will no longer be the owner.', confirmLabel: 'Transfer', danger: true });
    if (!sure) return;
    try { await Api.transferServer(serverId, chooser.value); toast('Ownership transferred.', { type: 'success' }); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  });

  async function load() {
    try {
      await refreshServerMembers(serverId, { limit: 100 });
      clear(chooser);
      chooser.appendChild(el('option', { value: '' }, 'Choose a member'));
      for (const item of membersOf(serverId)) {
        if (item.is_owner) continue;
        chooser.appendChild(el('option', { value: item.id }, item.display_name || item.username || item.id));
      }
    } catch { /* an empty chooser is honest */ }
  }

  return { node: host, load };
}

// -- the community landing ---------------------------------------------------

export function renderCommunityHome(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'm-stack' });
  const community = serverById(serverId) || {};
  // The identity of the community: its mark, its name, and what it is for in
  // the community's own words - and only when it has said them.
  const identity = el('div', { class: 'm-identity' },
    el('span', { class: 'm-identity__mark' }, serverMark(community, { size: 'md' })),
    el('span', { class: 'm-identity__words' },
      el('span', { class: 'm-identity__name' }, community.name || 'Community'),
      community.description
        ? el('span', { class: 'm-identity__about' }, community.description)
        : null));
  const node = screen(
    el('div', { class: 'm-hero m-hero--quiet' },
      identity,
      el('div', { class: 'm-hero__sub' }, 'Choose a channel.')),
    host);
  return { node, head: { lead: 'back', title: 'Channels' }, onMount() { paint(); } };

  function paint() {
    replaceChildren(host);
    const channels = sortedSiblings(serverId);
    if (!channels.length) {
      host.appendChild(empty({ icon: 'hash', title: 'No channels yet', text: 'An administrator can make one in settings.' }));
      return;
    }
    const list = el('div', { class: 'm-list' });
    for (const channel of channels) {
      list.appendChild(el('a', { class: 'm-row', href: path('/server/' + serverId + '/channel/' + channel.id) },
        el('span', { class: 'm-row__lead' }, icon(iconFor(channel), { size: 17 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title truncate' }, channel.name),
          channel.topic ? el('span', { class: 'm-row__sub truncate' }, channel.topic) : null)));
    }
    host.appendChild(list);
  }
}

export default {
  renderChannel, renderChannelPins, renderMembersPage, renderRolesPage,
  renderInvitesPage, renderCategoriesPage, renderCommunitySettings, renderCommunityHome,
};

// One community, from the inside.
//
// The channel a reader is looking at, the roster beside it, and the
// administrative screens underneath. What a member may do is decided by the
// permission list the API already returned with the community, so a control
// that would be refused is never drawn.

import { el, clear, fragment } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { avatar, iconButton, serverMark, fieldRow } from '../components.js';
import {
  State, normalizeUser, nameOf, refreshServer, refreshServerTree,
  refreshServerMembers, refreshServerRoles, channelsOf, categoriesOf, can, isOwner, serverById,
} from '../../packages/store.js';
import { path, navigate } from '../../packages/nav.js';
import { openDialog, confirmDialog, toast, errorToast, attachContextMenu } from '../ui.js';
import { openUserMenu, userMenuItems } from '../user-menu.js';
import { relativeTime } from '../../packages/format.js';
import Api from '../../packages/api.js';
import { page, heading, loading, failure, nothing, stat, panel, empty, relative } from './util.js';
import { renderConversation } from './messages.js';

// -- small shared pieces -----------------------------------------------------

function serverName(serverId) {
  const server = serverById(serverId);
  return (server && server.name) || 'Community';
}

function membersOf(serverId) {
  const roster = State.serverMembers.get(serverId);
  return roster && roster.items ? roster.items : [];
}

function iconFor(channel) {
  const type = String((channel && channel.type) || '').toLowerCase();
  if (type === 'voice' || type === 'stage') return 'volume';
  if (type === 'announcement') return 'bell';
  if (type === 'forum') return 'list';
  return 'hash';
}

// Voice and stage are the same medium: both open a voice room rather than a feed, and
// services/voice.js authorises them the same way. Kept in one place so the route, the
// sidebar and the editors cannot disagree about which channels have a feed.
export function isVoiceType(type) {
  const clean = String(type || '').toLowerCase();
  return clean === 'voice' || clean === 'stage';
}

function button(label, options) {
  const opts = options || {};
  return el('button', {
    class: 'btn btn--' + (opts.kind || 'default') + (opts.small === false ? '' : ' btn--sm'),
    type: 'button',
    onClick: opts.onClick || null,
  }, opts.icon ? icon(opts.icon, { size: 15 }) : null, el('span', {}, label));
}

function fieldBlock(label, hint, control) {
  return el('label', { class: 'field' },
    el('span', { class: 'field-label' }, label),
    control,
    hint ? el('span', { class: 'field-hint' }, hint) : null);
}

function sectionShell() {
  return el('div', { class: 'settings-section' });
}

// -- the roster that sits beside a conversation ------------------------------

function membersPanel(serverId) {
  const head = el('div', { class: 'members-head' });
  const scroll = el('div', { class: 'members-scroll' });

  head.append(
    el('span', { class: 'members-title' }, 'Members'),
    iconButton('x', { label: 'Close members', class: 'members-close', onClick: () => closeContext() }));

  function paint() {
    clear(scroll);
    const items = membersOf(serverId);
    if (!items.length) {
      scroll.appendChild(el('div', { class: 'muted-note' }, 'No members yet.'));
      return;
    }
    const online = [];
    const offline = [];
    for (const item of items) {
      const user = normalizeUser(item);
      const presence = State.presence.get(user.id) || 'offline';
      (presence === 'offline' ? offline : online).push({ user, item });
    }
    for (const [label, list] of [['Online', online], ['Offline', offline]]) {
      if (!list.length) continue;
      scroll.appendChild(el('div', { class: 'member-group' },
        el('div', { class: 'member-group-head' }, label + ' - ' + list.length),
        list.map((entry) => el('button', {
          class: 'member-row', type: 'button', title: nameOf(entry.user),
          onClick: () => navigate('/users/' + entry.user.id),
        },
          avatar(entry.user, { size: 'sm', presence: entry.user.id ? (State.presence.get(entry.user.id) || 'offline') : 'offline' }),
          el('span', { class: 'member-name truncate' }, nameOf(entry.user)),
          roleTag(entry.item)))));
    }
  }

  async function load() {
    try {
      await refreshServerMembers(serverId, { limit: 100 });
      paint();
      const ids = membersOf(serverId).map((m) => m.id).filter(Boolean);
      if (ids.length) {
        const { refreshPresence } = await import('../../packages/store.js');
        refreshPresence(ids).catch(() => {});
      }
    } catch {
      scroll.replaceChildren(el('div', { class: 'muted-note' }, 'Members did not load.'));
    }
  }

  return { node: fragment(head, scroll), load };
}

function roleTag(member) {
  const first = (member.roles || [])[0];
  if (!first) return member.is_owner ? el('span', { class: 'member-role' }, 'Owner') : null;
  const name = typeof first === 'string' ? first : first.name;
  return name ? el('span', { class: 'member-role truncate' }, name) : null;
}

function membersOfIds(serverId) {
  return membersOf(serverId).map((m) => m.id).filter(Boolean);
}

// -- a text channel ----------------------------------------------------------

function channelHead(channel, serverId) {
  const actions = el('div', { class: 'stage-head-actions' });
  actions.appendChild(iconButton('pin', { label: 'Pinned messages', onClick: () => navigate(path('/server/' + serverId + '/channel/' + channel.id + '/pins')) }));
  actions.appendChild(membersToggle());
  return el('div', { class: 'stage-head-content' },
    el('span', { class: 'stage-head-icon' }, icon(iconFor(channel), { size: 19 })),
    el('div', { class: 'stage-head-main' },
      el('h1', { class: 'stage-head-title truncate' }, channel.name),
      channel.topic ? el('div', { class: 'stage-head-sub truncate' }, channel.topic) : null),
    actions);
}

// The control that opens the context panel. It is a disclosure rather than a
// toggle button, so it reports aria-expanded, and the shell keeps that attribute
// in step from wherever the panel is opened or closed - including the panel's own
// close control.
function membersToggle() {
  const button = iconButton('users', {
    label: 'Members',
    class: 'context-toggle',
    onClick: () => toggleContext(),
  });
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', 'context-panel');
  return button;
}

async function toggleContext() {
  const shell = await import('../shell.js');
  shell.toggleContextPanel();
}

async function closeContext() {
  const shell = await import('../shell.js');
  shell.closeContextPanel();
}

export function renderChannel(ctx) {
  const serverId = ctx.serverId;
  const channel = ctx.channel;
  if (!channel) {
    return {
      head: [],
      node: page({ wide: true }, heading('Channel not found', 'That channel is not part of this community.')),
      onMount() {},
    };
  }
  if (isVoiceType(channel.type)) return renderVoice(ctx, channel);

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
  const roster = membersPanel(serverId);

  return {
    head: [channelHead(channel, serverId)],
    node: conversation.node,
    composer: conversation.composer,
    members: roster.node,
    onMount() {
      conversation.onMount();
      roster.load();
    },
    cleanup: conversation.cleanup,
  };
}

// voice channels delegate to the media module, which is the only place that
// knows whether this instance even offers a session.
function renderVoice(ctx, channel) {
  const host = el('div', { class: 'voice-stage' });
  const node = page({ wide: true }, host);
  const serverId = ctx.serverId;
  const head = el('div', { class: 'stage-head-content' },
    el('span', { class: 'stage-head-icon' }, icon('volume', { size: 19 })),
    el('div', { class: 'stage-head-main' }, el('div', { class: 'stage-head-title' }, channel.name)));

  let voice = null;

  async function load() {
    host.replaceChildren(el('div', { class: 'view-loading' }, 'Checking this channel'));
    try {
      voice = await import('../voice.js');
      host.replaceChildren(await voice.voiceChannelPanel({ serverId, channel }));
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }

  return {
    head: [channelHead(channel, serverId)],
    node,
    onMount: load,
    // Navigating away ends the call rather than leaving the microphone open in a
    // panel nobody can see.
    cleanup() {
      if (voice) voice.leaveVoice(channel.id);
    },
  };
}

// -- pinned messages ---------------------------------------------------------

export function renderChannelPins(ctx) {
  const serverId = ctx.serverId;
  const channel = ctx.channel || {};
  const host = el('div', { class: 'rows' });
  const node = page(
    heading('Pinned in #' + (channel.name || 'channel'), 'Messages kept within reach.'),
    host,
  );

  async function load() {
    host.replaceChildren(loading('Loading pins'));
    try {
      const pins = await Api.listPins(serverId, channel.id);
      paint(Array.isArray(pins) ? pins : (pins.items || []));
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }

  function paint(pins) {
    host.replaceChildren();
    if (!pins.length) {
      host.appendChild(nothing('Nothing pinned', 'Pin a message from its menu to keep it here.'));
      return;
    }
    for (const message of pins) {
      host.appendChild(el('div', { class: 'row-item' },
        el('div', { class: 'row-item-main' },
          el('div', { class: 'row-item-title' }, message.content || '(no text)'),
          el('div', { class: 'row-item-sub' },
            (message.author_name || message.authorName || 'Someone') + ' - ' + relativeTime(message.created_at || message.createdAt))),
        el('div', { class: 'row-item-actions' },
          button('Open', { kind: 'ghost', onClick: () => navigate('/server/' + serverId + '/channel/' + channel.id) }))));
    }
  }

  return { node, onMount: load };
}

// -- members -----------------------------------------------------------------

function memberLine(serverId, item) {
  const user = normalizeUser(item);
  const controls = el('div', { class: 'row-item-actions' });
  if (can(serverId, 'MANAGE_ROLES') && !item.is_owner) {
    controls.appendChild(button('Roles', { kind: 'default', onClick: () => openMemberRoles(serverId, item, loadMembersInto) }));
  }
  if (!item.is_owner && (can(serverId, 'KICK_MEMBERS') || can(serverId, 'BAN_MEMBERS'))) {
    controls.appendChild(button('Manage', {
      kind: 'ghost',
      onClick: (event) => openUserMenu(event.currentTarget, user, { extra: memberMenuItems(serverId, item, user) }),
    }));
  }
  const roles = (item.roles || []).map((r) => (typeof r === 'string' ? r : r.name)).filter(Boolean);
  const row = el('div', { class: 'row-item' },
    avatar(user, { size: 'md' }),
    el('div', { class: 'row-item-main' },
      el('div', { class: 'row-item-title' }, nameOf(user)),
      el('div', { class: 'row-item-sub' }, '@' + (user.username || '') + (roles.length ? ' - ' + roles.join(', ') : ''))),
    controls);
  attachContextMenu(row, () => userMenuItems(user, { extra: memberMenuItems(serverId, item, user) }));
  return row;
}

let loadMembersInto = null;

function membersSection(serverId) {
  const host = sectionShell();
  const rows = el('div', { class: 'rows' });
  host.appendChild(rows);
  loadMembersInto = load;

  async function load() {
    rows.replaceChildren(loading('Loading members'));
    try {
      await refreshServerMembers(serverId, { limit: 100 });
      const items = membersOf(serverId);
      const ids = items.map((m) => m.id).filter(Boolean);
      if (ids.length) {
        const { refreshPresence } = await import('../../packages/store.js');
        refreshPresence(ids).catch(() => {});
      }
      rows.replaceChildren();
      if (!items.length) {
        rows.appendChild(nothing('No members yet', 'Invite people to this community.'));
        return;
      }
      for (const item of items) rows.appendChild(memberLine(serverId, item));
    } catch (error) {
      rows.replaceChildren(failure(error, load));
    }
  }

  return { node: host, load };
}

// The actions a moderator can take on a member. One list, used by both the row's
// context menu and its Manage button, so the two can never drift apart. Items carry
// `onSelect`, which is what the menu actually calls - `onClick` here silently did
// nothing, which is why the Manage button looked responsive and was not.
function memberMenuItems(serverId, item, user) {
  const items = [];
  if (can(serverId, 'MANAGE_ROLES')) {
    items.push({ label: 'Edit roles', onSelect: () => openMemberRoles(serverId, item, loadMembersInto) });
  }
  if (can(serverId, 'BAN_MEMBERS')) {
    items.push({ label: 'Timeout', onSelect: () => openTimeout(serverId, item, user) });
  }
  if (can(serverId, 'KICK_MEMBERS')) {
    items.push({ label: 'Kick', danger: true, onSelect: () => kickMember(serverId, user) });
  }
  if (can(serverId, 'BAN_MEMBERS')) {
    items.push({ label: 'Ban', danger: true, onSelect: () => banMember(serverId, user) });
  }
  return items;
}

async function openTimeout(serverId, item, user) {
  const minutes = el('input', { class: 'input', type: 'number', min: '0', max: '10080', value: '10' });
  const body = el('div', { class: 'settings-section' },
    el('p', { class: 'page-sub' }, 'Minutes of silence for ' + nameOf(user) + '. Zero lifts it.'),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Minutes'), minutes));
  const cancel = el('button', { class: 'btn btn--ghost', type: 'button' }, 'Cancel');
  const save = el('button', { class: 'btn btn--primary', type: 'button' }, 'Apply');
  const dialog = openDialog({ title: 'Timeout ' + nameOf(user), foot: [cancel, save] });
  dialog.element.insertBefore(body, dialog.element.querySelector('.dialog-foot'));
  cancel.addEventListener('click', () => dialog.close());
  save.addEventListener('click', async () => {
    try {
      await Api.timeoutMember(serverId, user.id, Number(saveMinutes()));
      dialog.close();
      toast('Timeout updated.', { type: 'success' });
      if (loadMembersInto) loadMembersInto();
    } catch (error) { errorToast(error); }
  });
  function saveMinutes() {
    const field = dialog.element.querySelector('input');
    return field ? field.value : 0;
  }
}

async function kickMember(serverId, user) {
  const yes = await confirmDialog({ title: 'Remove ' + nameOf(user) + '?', body: 'They can join again with a new invite.', confirmLabel: 'Remove', danger: true });
  if (!yes) return;
  try {
    await Api.kickMember(serverId, user.id);
    toast('Removed.', { type: 'success' });
    if (loadMembersInto) loadMembersInto();
  } catch (error) { errorToast(error); }
}

async function ban(serverId, user) {
  const yes = await confirmDialog({ title: 'Ban ' + nameOf(user) + '?', body: 'They cannot return until unbanned.', confirmLabel: 'Ban', danger: true });
  if (!yes) return;
  try {
    await Api.banMember(serverId, user.id, '');
    toast('Banned.', { type: 'success' });
    if (loadMembersInto) loadMembersInto();
  } catch (error) { errorToast(error); }
}

function banMember(serverId, user) {
  return ban(serverId, user);
}

async function openMemberRoles(serverId, item, done) {
  const user = normalizeUser(item);
  let roles;
  try { roles = await Api.roles(serverId); } catch (error) { errorToast(error); return; }
  const held = new Set((item.roles || []).map((r) => (typeof r === 'string' ? r : r.id)));
  const boxes = new Map();
  roles = roles.filter((role) => !role.is_default || true);
  const list = el('div', { class: 'rows' });
  for (const role of roles) {
    const box = el('input', { type: 'checkbox', checked: held.has(role.id) });
    boxes.set(role.id, { box, was: held.has(role.id) });
    list.appendChild(el('label', { class: 'row-item field-row--check' },
      box,
      el('div', { class: 'row-item-main' },
        el('div', { class: 'row-item-title' }, role.name),
        el('div', { class: 'row-item-sub' }, (role.permissions || []).length + ' permissions'))));
  }
  const body = el('div', { class: 'settings-section' }, list);
  const cancel = el('button', { class: 'btn btn--ghost', type: 'button' }, 'Cancel');
  const save = el('button', { class: 'btn btn--primary', type: 'button' }, 'Save');
  const dialog = openDialog({ title: 'Roles for ' + nameOf(user), sub: 'Add or remove what they hold.', foot: [cancel, save] });
  dialog.element.insertBefore(body, dialog.element.querySelector('.dialog-foot'));
  cancel.addEventListener('click', () => dialog.close());
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      for (const [roleId, entry] of boxes) {
        if (entry.box.checked && !entry.was) await Api.assignRole(serverId, roleId, user.id);
        else if (!entry.box.checked && entry.was) await Api.unassignRole(serverId, roleId, user.id);
      }
      dialog.close();
      toast('Roles updated.', { type: 'success' });
      if (done) done();
    } catch (error) {
      errorToast(error);
      save.disabled = false;
    }
  });
}

export function renderMembersPage(ctx) {
  return standalone('Members', 'Everyone in this community.', () => membersSection(ctx.serverId));
}

function editableText(value, placeholder, maxlength) {
  return el('input', { class: 'input', type: 'text', value: value || '', placeholder: placeholder || '', maxlength: String(maxlength || 120) });
}

// -- roles -------------------------------------------------------------------

function rolesSection(serverId) {
  const host = sectionShell();
  const head = el('div', { class: 'settings-actions' });
  const rows = el('div', { class: 'rows' });
  head.appendChild(button('New role', { kind: 'primary', icon: 'plus', onClick: () => openRoleEditor(serverId, null, load) }));
  host.append(head, rows);

  async function load() {
    rows.replaceChildren(loading('Loading roles'));
    try {
      await refreshServerRoles(serverId);
      const roles = State.serverRoles.get(serverId) || [];
      rows.replaceChildren();
      if (!roles.length) {
        rows.appendChild(nothing('No roles', 'Every community has at least one role.'));
        return;
      }
      for (const role of roles) {
        rows.appendChild(el('div', { class: 'row-item' },
          el('span', { class: 'role-chip', style: role.color ? { borderColor: role.color, color: role.color } : null }, role.name),
          el('div', { class: 'row-item-main' },
            el('div', { class: 'row-item-sub' }, role.is_default ? 'Baseline role, held by everyone' : (role.permissions || []).length + ' permissions')),
          el('div', { class: 'row-item-actions' },
            button('Edit', { kind: 'default', onClick: () => openRoleEditor(serverId, role, load) }),
            role.is_default ? null : iconButton('trash', { label: 'Delete role', onClick: () => deleteRole(serverId, role, load) }))));
      }
    } catch (error) {
      rows.replaceChildren(failure(error, load));
    }
  }

  return { node: host, load };
}

function listPerm(grid, key, descriptions) {
  const label = (descriptions && (descriptions[key] || descriptions[key.replace(/[._-]+/g, ' ')])) || key;
  grid.appendChild(el('label', { class: 'perm-row' }, el('span', { class: 'perm-label' }, label)));
}

async function openRoleEditor(serverId, role, done) {
  let context;
  try { context = await Api.rolePermissions(serverId); } catch (error) { errorToast(error); return; }
  const editing = !!role;
  const nameInput = editableText(role ? role.name : '', 'Role name', 32);
  if (role && role.is_default) nameInput.disabled = true;
  const selected = new Set(role && role.permissions ? role.permissions : []);
  const grid = el('div', { class: 'perm-grid' });
  const keys = (context.all || []).slice().sort();
  for (const key of keys) {
    const box = el('input', { type: 'checkbox', checked: selected.has(key) });
    box.addEventListener('change', () => { if (box.checked) selected.add(key); else selected.delete(key); });
    listPerm(grid, key, context.descriptions);
    grid.lastChild.insertBefore(box, grid.lastChild.firstChild);
  }
  const body = el('div', { class: 'settings-section' },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Name'), nameInput),
    el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Permissions'), el('div', { class: 'perm-grid' }, grid.children.length ? null : null, Array.from(grid.childNodes))));
  const cancel = el('button', { class: 'btn btn--ghost', type: 'button' }, 'Cancel');
  const save = el('button', { class: 'btn btn--primary', type: 'button' }, editing ? 'Save' : 'Create');
  const dialog = openDialog({ title: editing ? 'Edit ' + role.name : 'New role', sub: editing ? 'What this role may do.' : 'Name it, then choose what it may do.', foot: [cancel, save] });
  dialog.element.insertBefore(body, dialog.element.querySelector('.dialog-foot'));
  cancel.addEventListener('click', () => dialog.close());
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const payload = { name: nameInput.value.trim(), permissions: Array.from(selected) };
      if (editing) await Api.updateRole(serverId, role.id, payload);
      else await Api.createRole(serverId, payload);
      dialog.close();
      toast(editing ? 'Role saved.' : 'Role created.', { type: 'success' });
      if (done) done();
    } catch (error) {
      errorToast(error);
      save.disabled = false;
    }
  });
}

async function deleteRole(serverId, role, done) {
  const yes = await confirmDialog({ title: 'Delete ' + role.name + '?', body: 'Members lose it immediately.', confirmLabel: 'Delete', danger: true });
  if (!yes) return;
  try {
    await Api.deleteRole(serverId, role.id);
    toast('Role deleted.', { type: 'success' });
    if (done) done();
  } catch (error) { errorToast(error); }
}

export function renderRolesPage(ctx) {
  return standalone('Roles', 'What each role may manage.', () => rolesSection(ctx.serverId));
}

// -- invites -----------------------------------------------------------------

function inviteState(invite) {
  if (invite.revoked) return 'revoked';
  if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now()) return 'expired';
  if (invite.max_uses !== null && invite.max_uses !== undefined && invite.uses >= invite.max_uses) return 'exhausted';
  return 'active';
}

function invitesSection(serverId) {
  const host = sectionShell();
  const head = el('div', { class: 'settings-actions' });
  const rows = el('div', { class: 'rows' });
  head.appendChild(button('New invite', { kind: 'primary', icon: 'plus', onClick: () => openInvite(serverId, load) }));
  host.append(head, rows);

  async function load() {
    rows.replaceChildren(loading('Loading invites'));
    try {
      const invites = await Api.invites(serverId);
      const list = Array.isArray(invites) ? invites : (invites.invites || []);
      rows.replaceChildren();
      if (!list.length) {
        rows.appendChild(nothing('No invites', 'Make one and share the code.'));
        return;
      }
      for (const invite of list) {
        const state = inviteState(invite);
        const uses = (invite.uses || 0) + (invite.max_uses ? ' / ' + invite.max_uses : '');
        const main = el('a', { class: 'row-item-main', href: path('/invite/' + invite.code) },
          el('div', { class: 'row-item-title' }, invite.code),
          el('div', { class: 'row-item-sub' }, invite.creator_name ? 'by ' + invite.creator_name : ''));
        rows.appendChild(el('div', { class: 'row-item' },
          el('span', { class: 'invite-state invite-state--' + state }, state),
          main,
          el('div', { class: 'row-item-sub', style: { marginRight: '10px' } }, 'used ' + uses),
          el('div', { class: 'row-item-actions' },
            iconButton('copy', { label: 'Copy code', onClick: () => copyInvite(invite.code) }),
            button('Revoke', { kind: 'ghost', onClick: () => revokeInvite(serverId, invite, load) }))));
      }
    } catch (error) {
      rows.replaceChildren(failure(error, load));
    }
  }

  return { node: host, load };
}

async function copyInvite(code) {
  try {
    await navigator.clipboard.writeText(code);
    toast('Code copied.', { type: 'success' });
  } catch {
    toast(code, { type: 'info' });
  }
}

async function revokeInvite(serverId, invite, done) {
  const yes = await confirmDialog({ title: 'Revoke ' + invite.code + '?', body: 'Anyone holding it can no longer join.', confirmLabel: 'Revoke', danger: true });
  if (!yes) return;
  try {
    await Api.deleteInvite(serverId, invite.id);
    toast('Invite revoked.', { type: 'success' });
    if (done) done();
  } catch (error) { errorToast(error); }
}

function openInvite(serverId, done) {
  const usesInput = el('input', { class: 'input', type: 'number', min: '1', max: '100', placeholder: 'Unlimited' });
  const hoursInput = el('input', { class: 'input', type: 'number', min: '1', placeholder: 'Never' });
  const body = el('div', { class: 'settings-section' },
    fieldRow('Uses', 'How many people may redeem it.', usesInput),
    fieldRow('Expires after', 'Hours. Leave empty to keep it.', hoursInput));
  const cancel = el('button', { class: 'btn btn--ghost', type: 'button' }, 'Cancel');
  const create = el('button', { class: 'btn btn--primary', type: 'button' }, 'Create');
  const dialog = openDialog({ title: 'New invite', sub: 'A code, bounded by uses and time.', foot: [cancel, create] });
  dialog.element.insertBefore(body, dialog.element.querySelector('.dialog-foot'));
  cancel.addEventListener('click', () => dialog.close());
  create.addEventListener('click', async () => {
    create.disabled = true;
    try {
      const out = await Api.createInvite(serverId, {
        maxUses: usesInput.value ? Number(usesInput.value) : null,
        expiresInHours: hoursInput.value ? Number(hoursInput.value) : null,
      });
      dialog.close();
      if (out && out.code) copyInvite(out.code);
      else toast('Invite created.', { type: 'success' });
      if (done) done();
    } catch (error) {
      errorToast(error);
      create.disabled = false;
    }
  });
}

export function renderInvitesPage(ctx) {
  return standalone('Invites', 'Codes and how they have been used.', () => invitesSection(ctx.serverId));
}

// -- channels and categories -------------------------------------------------

function channelsSection(serverId) {
  const host = sectionShell();
  const head = el('div', { class: 'settings-actions' });
  const rows = el('div', { class: 'rows' });
  head.appendChild(button('New channel', { kind: 'primary', icon: 'plus', onClick: () => openChannelEditor(serverId, null, load) }));
  host.append(head, rows);

  async function load() {
    rows.replaceChildren(loading('Loading channels'));
    try {
      await refreshServerTree(serverId);
      const channels = channelsOf(serverId);
      rows.replaceChildren();
      if (!channels.length) {
        rows.appendChild(nothing('No channels', 'Make one so people can talk.'));
        return;
      }
      const ordered = channels.slice().sort((a, b) => (a.position || 0) - (b.position || 0));
      for (const channel of ordered) {
        rows.appendChild(el('div', { class: 'row-item' },
          el('span', { class: 'row-item-icon' }, icon(iconFor(channel), { size: 17 })),
          el('div', { class: 'row-item-main' },
            el('div', { class: 'row-item-title' }, channel.name),
            channel.topic ? el('div', { class: 'row-item-sub truncate' }, channel.topic) : null),
          el('div', { class: 'row-item-actions' },
            button('Edit', { kind: 'default', onClick: () => openChannelEditor(serverId, channel, load) }),
            iconButton('trash', { label: 'Delete channel', onClick: () => deleteChannel(serverId, channel, load) }))));
      }
    } catch (error) {
      rows.replaceChildren(failure(error, load));
    }
  }

  return { node: host, load };
}

function categoryOptions(serverId, selectedId) {
  const select = el('select', { class: 'input' });
  select.appendChild(el('option', { value: '' }, 'No category'));
  for (const category of (categoriesOf(serverId))) {
    select.appendChild(el('option', { value: category.id, selected: category.id === selectedId }, category.name));
  }
  return select;
}

function voiceReason(voice) {
  if (voice.available) return '';
  if (voice.reason === 'disabled') return 'Voice and video are off on this instance.';
  if (voice.reason === 'unreachable') return 'The media server could not be reached.';
  return voice.detail || 'Voice is unavailable on this instance.';
}

async function openChannelEditor(serverId, channel, done) {
  const editing = !!channel;
  const current = String((channel && channel.type) || 'text').toLowerCase();
  const nameInput = editableText(channel ? channel.name : '', 'channel-name', 40);
  const topicInput = editableText(channel ? (channel.topic || '') : '', 'Topic (optional)', 200);
  const category = categoryOptions(serverId, channel ? channel.category_id : null);

  // Whether a voice channel can work here is the server's answer, read from the same
  // capability the media panel reads, so the editor cannot offer a type the instance
  // cannot carry. Until it is known the voice options stay off, with the reason shown.
  let voice = { available: false, reason: 'unknown', detail: 'Checking this instance.' };
  try {
    const mod = await import('../voice.js');
    voice = await mod.voiceCapabilities();
  } catch { /* unreachable backend: the options stay off and the reason says so */ }
  const voiceOff = !voice.available;

  const typeSelect = el('select', { class: 'input' });
  for (const [value, label] of [['text', 'Text channel'], ['voice', 'Voice channel'], ['stage', 'Stage channel']]) {
    typeSelect.appendChild(el('option', {
      value,
      selected: value === current,
      // A channel that is already a voice type keeps that option selectable, or the
      // editor could not show what the channel is.
      disabled: isVoiceType(value) && voiceOff && value !== current,
    }, label));
  }
  const typeHint = el('div', { class: 'field-hint' },
    isVoiceType(current) && voiceOff
      ? 'This channel is a ' + current + ' channel, but voice is not available right now. ' + voiceReason(voice)
      : voiceOff
        ? voiceReason(voice)
        : 'A channel type can be changed later, as long as nobody is connected to it.');

  const body = el('div', { class: 'settings-section' },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Name'), nameInput),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Type'), typeSelect, typeHint),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Topic'), topicInput),
    editing ? null : el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Category'), category));
  const cancel = el('button', { class: 'btn btn--ghost', type: 'button' }, 'Cancel');
  const save = el('button', { class: 'btn btn--primary', type: 'button' }, editing ? 'Save' : 'Create');
  const dialog = openDialog({ title: editing ? 'Edit channel' : 'New channel', foot: [cancel, save] });
  dialog.element.insertBefore(body, dialog.element.querySelector('.dialog-foot'));
  cancel.addEventListener('click', () => dialog.close());
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const payload = { name: nameInput.value.trim(), topic: topicInput.value };
      payload.categoryId = editing ? channel.category_id : (category.value || null);
      if (!editing || typeSelect.value !== current) payload.type = typeSelect.value;
      if (editing) await Api.updateChannel(serverId, channel.id, payload);
      else await Api.createChannel(serverId, payload);
      dialog.close();
      toast(editing ? 'Channel saved.' : 'Channel created.', { type: 'success' });
      if (done) done();
    } catch (error) {
      errorToast(error);
      save.disabled = false;
    }
  });
}

async function deleteChannel(serverId, channel, done) {
  const yes = await confirmDialog({ title: 'Delete #' + channel.name + '?', body: 'Its messages go with it. This cannot be undone.', confirmLabel: 'Delete', danger: true });
  if (!yes) return;
  try {
    await Api.deleteChannel(serverId, channel.id);
    toast('Channel deleted.', { type: 'success' });
    if (done) done();
  } catch (error) { errorToast(error); }
}

function categoriesSection(serverId) {
  const host = sectionShell();
  const head = el('div', { class: 'settings-actions' });
  const rows = el('div', { class: 'rows' });
  head.appendChild(button('New category', { kind: 'primary', icon: 'plus', onClick: () => openCategoryEditor(serverId, null, load) }));
  host.append(head, rows);

  async function load() {
    rows.replaceChildren(loading('Loading categories'));
    try {
      await refreshServerTree(serverId);
      const categories = joinCategories(serverId);
      rows.replaceChildren();
      if (!categories.length) {
        rows.appendChild(nothing('No categories', 'Group channels to keep the list short.'));
        return;
      }
      for (const category of categories) {
        rows.appendChild(el('div', { class: 'row-item' },
          el('span', { class: 'row-item-icon' }, icon('layers', { size: 17 })),
          el('div', { class: 'row-item-main' },
            el('div', { class: 'row-item-title' }, category.name),
            el('div', { class: 'row-item-sub' }, category.count + (category.count === 1 ? ' channel' : ' channels'))),
          el('div', { class: 'row-item-actions' },
            button('Rename', { kind: 'default', onClick: () => openCategoryEditor(serverId, category, load) }),
            iconButton('trash', { label: 'Delete category', onClick: () => deleteCategory(serverId, category, load) }))));
      }
    } catch (error) {
      rows.replaceChildren(failure(error, load));
    }
  }

  return { node: host, load };
}

function joinCategories(serverId) {
  const channels = channelsOf(serverId);
  return State.serverTree.get(serverId)
    ? (State.serverTree.get(serverId).categories || []).map((category) => ({
      ...category,
      count: channels.filter((c) => c.category_id === category.id).length,
    }))
    : [];
}

function openCategoryEditor(serverId, category, done) {
  const input = editableText(category ? category.name : '', 'Category name', 40);
  const body = el('div', { class: 'settings-section' },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Name'), input));
  const cancel = el('button', { class: 'btn btn--ghost', type: 'button' }, 'Cancel');
  const save = el('button', { class: 'btn btn--primary', type: 'button' }, category ? 'Save' : 'Create');
  const dialog = openDialog({ title: category ? 'Rename category' : 'New category', foot: [cancel, save] });
  dialog.element.insertBefore(body, dialog.element.querySelector('.dialog-foot'));
  cancel.addEventListener('click', () => dialog.close());
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const name = input.value.trim();
      if (category) await Api.updateCategory(serverId, category.id, { name });
      else await Api.createCategory(serverId, { name });
      dialog.close();
      toast(category ? 'Category saved.' : 'Category created.', { type: 'success' });
      if (done) done();
    } catch (error) {
      errorToast(error);
      save.disabled = false;
    }
  });
}

async function deleteCategory(serverId, category, done) {
  const yes = await confirmDialog({ title: 'Delete "' + category.name + '"?', body: 'Its channels are not deleted, just ungrouped.', confirmLabel: 'Delete', danger: true });
  if (!yes) return;
  try {
    await Api.deleteCategory(serverId, category.id);
    toast('Category deleted.', { type: 'success' });
    if (done) done();
  } catch (error) { errorToast(error); }
}

export function renderChannelsPage() {
  return { node: page({ wide: true }, heading('Channels', 'The rooms people talk in.')), onMount() {} };
}

export function renderCategoriesPage(ctx) {
  return standalone('Categories', 'Group channels together.', () => categoriesSection(ctx.serverId));
}

// -- settings sections -------------------------------------------------------

function overviewSection(serverId) {
  const server = serverById(serverId) || {};
  const host = sectionShell();
  const nameInput = editableText(server.name || '', 'Community name', 60);
  const description = el('textarea', { class: 'input', rows: '3', maxlength: '400' });
  description.value = server.description || '';
  const card = el('div', { class: 'settings-card' },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Name'), nameInput),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Description'), description));
  host.appendChild(card);

  const flags = el('div', { class: 'settings-card' });
  const state = { isPublic: !!server.is_public, isDiscoverable: !!server.is_discoverable };
  flags.appendChild(settingsToggle('Public', 'Anyone with the link may read the preview.', state.isPublic, (v) => { state.isPublic = v; }));
  flags.appendChild(settingsToggle('Discoverable', 'Appears in Discover searches.', state.isDiscoverable, (v) => { state.isDiscoverable = v; }));
  host.appendChild(flags);

  const actions = el('div', { class: 'settings-actions' });
  const save = el('button', { class: 'btn btn--primary', type: 'button' }, 'Save changes');
  flags.appendChild(el('div', { class: 'settings-actions' }, save));
  host.appendChild(el('div', { class: 'settings-actions' },
    el('button', { class: 'btn btn--ghost', type: 'button', onClick: () => navigate(path('/server/' + serverId + '/settings/appearance')) }, 'Appearance')));

  async function load() { /* the values are already here */ }

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await Api.updateServer(serverId, { name: nameInput.value.trim(), description: description.value, isPublic: state.isPublic, isDiscoverable: state.isDiscoverable });
      await refreshServer(serverId).catch(() => {});
      toast('Community saved.', { type: 'success' });
    } catch (error) { errorToast(error); } finally { save.disabled = false; }
  });

  return { node: host, load };
}

function settingsToggle(labelText, description, initial, setValue) {
  let value = !!initial;
  const control = el('button', {
    class: 'switch', type: 'button', role: 'switch',
    'aria-checked': String(value), 'aria-label': labelText,
  });
  control.addEventListener('click', () => {
    value = !value;
    control.setAttribute('aria-checked', String(value));
    setValue(value);
  });
  return fieldRow(labelText, description, control);
}

function appearanceSection(serverId) {
  const host = sectionShell();
  const build = () => {
    const server = serverById(serverId) || {};
    clear(host);
    host.appendChild(el('div', { class: 'settings-card' },
      el('div', { class: 'media-row' },
        el('div', { class: 'media-preview' }, serverMark(server, { size: 'lg' })),
        el('div', { class: 'media-controls' },
          button('Change icon', { kind: 'default', onClick: () => pickServerImage(serverId, 'icon', load) }),
          server.icon_url ? button('Remove', { kind: 'ghost', onClick: () => removeServerImage(serverId, 'icon', load) }) : null)),
      el('div', { class: 'media-row' },
        el('div', { class: 'media-preview media-preview--wide' }, bannerOrBlank(server)),
        el('div', { class: 'media-controls' },
          button('Change banner', { kind: 'default', onClick: () => pickServerImage(serverId, 'banner', load) }),
          server.banner_url ? button('Remove', { kind: 'ghost', onClick: () => removeServerImage(serverId, 'banner', load) }) : null))));
  };
  async function load() {
    try { await refreshServer(serverId); } catch { /* the form still edits what it has */ }
    build();
  }
  return { node: host, load };
}


async function unbanPerson(serverId, userId, done) {
  try {
    await Api.unbanMember(serverId, userId);
    toast('Unbanned.', { type: 'success' });
    if (done) done();
  } catch (error) { errorToast(error); }
}

function ownershipSection(serverId) {
  const host = sectionShell();
  const server = serverById(serverId) || {};
  const transferCard = el('div', { class: 'settings-card' });
  transferCard.appendChild(el('div', { class: 'panel-title' }, 'Transfer ownership'));
  transferCard.appendChild(el('div', { class: 'muted-note' }, 'Hand this community to another member. You keep only their permissions.'));
  const select = el('select', { class: 'input' });
  transferCard.appendChild(select);
  transferCard.appendChild(el('div', { class: 'settings-actions' },
    button('Transfer', { kind: 'danger', onClick: () => transfer(serverId, select, load) })));

  const dangerCard = el('div', { class: 'settings-card' });
  dangerCard.appendChild(el('div', { class: 'panel-title' }, 'Delete community'));
  dangerCard.appendChild(el('div', { class: 'muted-note' }, 'Deletes ' + (server.name || 'this community') + ' and everything in it.'));
  dangerCard.appendChild(el('div', { class: 'settings-actions' },
    button('Delete community', { kind: 'danger', onClick: () => deleteCommunity(serverId) })));

  host.append(transferCard, dangerCard);

  async function load() {
    try {
      await refreshServerMembers(serverId, { limit: 100 });
      clear(select);
      select.appendChild(el('option', { value: '' }, 'Choose a member'));
      for (const item of membersOf(serverId)) {
        if (item.is_owner) continue;
        select.appendChild(el('option', { value: item.id }, (item.display_name || item.username || item.id)));
      }
    } catch { /* an empty chooser is honest */ }
  }

  return { node: host, load };
}

async function transfer(serverId, select, done) {
  const userId = select.value;
  if (!userId) { toast('Choose a member first.', { type: 'info' }); return; }
  const yes = await confirmDialog({ title: 'Transfer ownership?', body: 'You will no longer be the owner.', confirmLabel: 'Transfer', danger: true });
  if (!yes) return;
  try {
    await Api.transferServer(serverId, userId);
    toast('Ownership transferred.', { type: 'success' });
    if (done) done();
  } catch (error) { errorToast(error); }
}

async function deleteCommunity(serverId) {
  const yes = await confirmDialog({ title: 'Delete this community?', body: 'Every channel, message and membership goes. This cannot be undone.', confirmLabel: 'Delete', danger: true });
  if (!yes) return;
  try {
    await Api.deleteServer(serverId);
    signOutToHome();
  } catch (error) { errorToast(error); }
}

async function signOutToHome() {
  const { refreshServers } = await import('../../packages/store.js');
  await refreshServers().catch(() => {});
  navigate('/home');
}

function integrationsSection(serverId) {
  const host = sectionShell();
  const head = el('div', { class: 'settings-actions' });
  const rows = el('div', { class: 'rows' });
  head.appendChild(button('New webhook', { kind: 'primary', icon: 'plus', onClick: () => createWebhook(serverId, load) }));
  host.append(el('div', { class: 'panel-title' }, 'Webhooks'), el('div', { class: 'muted-note' }, 'Notify another service when something happens here.'), head, rows);
  return { node: host, load };

  async function load() {
    rows.replaceChildren(loading('Loading webhooks'));
    try {
      const out = await Api.webhooks(serverId);
      const hooks = Array.isArray(out) ? out : (out.webhooks || []);
      rows.replaceChildren();
      if (!hooks.length) {
        rows.appendChild(nothing('No webhooks', 'Notify another service about what happens here.'));
        return;
      }
      for (const hook of hooks) {
        rows.appendChild(el('div', { class: 'row-item' },
          el('span', { class: 'row-item-icon' }, icon('webhook', { size: 17 })),
          el('div', { class: 'row-item-main' },
            el('div', { class: 'row-item-title' }, hook.name || hook.url || hook.id),
            el('div', { class: 'row-item-sub truncate' }, hook.url || '')),
          el('div', { class: 'row-item-actions' },
            button('Rotate', { kind: 'default', onClick: () => rotateWebhook(serverId, hook, load) }),
            iconButton('trash', { label: 'Delete webhook', onClick: () => deleteWebhook(serverId, hook, load) }))));
      }
    } catch (error) {
      rows.replaceChildren(failure(error, load));
    }
  }
}

function createWebhook(serverId, done) {
  const nameInput = editableText('', 'Name', 60);
  const urlInput = editableText('', 'https://...', 400);
  const body = el('div', { class: 'settings-section' },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Name'), nameInput),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Endpoint'), urlInput));
  const cancel = el('button', { class: 'btn btn--ghost', type: 'button' }, 'Cancel');
  const create = el('button', { class: 'btn btn--primary', type: 'button' }, 'Create');
  const dialog = openDialog({ title: 'New webhook', foot: [cancel, create] });
  dialog.element.insertBefore(body, dialog.element.querySelector('.dialog-foot'));
  cancel.addEventListener('click', () => dialog.close());
  create.addEventListener('click', async () => {
    create.disabled = true;
    try {
      await Api.createWebhook(serverId, { name: nameInput.value.trim(), url: urlInput.value.trim() });
      dialog.close();
      toast('Webhook created.', { type: 'success' });
      if (done) done();
    } catch (error) {
      errorToast(error);
      create.disabled = false;
    }
  });
}

async function rotateWebhook(serverId, hook, done) {
  try {
    const out = await Api.rotateWebhookSecret(serverId, hook.id);
    if (out && out.secret) toast('New secret: ' + out.secret, { type: 'info' });
    else toast('Secret rotated.', { type: 'success' });
    if (done) done();
  } catch (error) { errorToast(error); }
}

async function deleteWebhook(serverId, hook, done) {
  const yes = await confirmDialog({ title: 'Delete webhook?', body: hook.name || hook.url || '', confirmLabel: 'Delete', danger: true });
  if (!yes) return;
  try {
    await Api.deleteWebhook(serverId, hook.id);
    toast('Webhook deleted.', { type: 'success' });
    if (done) done();
  } catch (error) { errorToast(error); }
}

function analyticsSection(serverId) {
  const host = sectionShell();

  async function load() {
    host.replaceChildren(loading('Reading activity'));
    try {
      const report = await Api.analytics(serverId, 30);
      host.replaceChildren(render(report));
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }

  function render(report) {
    const totals = report.totals || {};
    const averages = report.averages || {};
    const wrap = el('div', { class: 'settings-section' });
    wrap.appendChild(el('div', { class: 'stats' },
      stat(String(totals.messages || 0), 'messages over ' + (report.windowDays || 30) + ' days'),
      stat(String(totals.members || 0), 'members'),
      stat(String(totals.channels || 0), 'channels'),
      stat(String(averages.messagesPerActiveDay || 0), 'messages per active day')));
    if ((report.topChannels || []).length) {
      wrap.appendChild(el('div', { class: 'panel-title' }, 'Busiest channels'));
      const rows = el('div', { class: 'rows' });
      for (const channel of report.topChannels) {
        rows.appendChild(el('div', { class: 'row-item' },
          el('div', { class: 'row-item-main' },
            el('div', { class: 'row-item-title' }, channel.name || channel.channel_name || channel.id)),
          el('div', { class: 'row-item-actions' }, String(channel.messages || 0))));
      }
      wrap.appendChild(rows);
    }
    if ((report.topMembers || []).length) {
      wrap.appendChild(el('div', { class: 'panel-title' }, 'Most active'));
      const rows = el('div', { class: 'rows' });
      for (const member of report.topMembers) {
        rows.appendChild(el('div', { class: 'row-item' },
          el('div', { class: 'row-item-main' },
            el('div', { class: 'row-item-title' }, member.display_name || member.displayName || member.username || member.id)),
          el('div', { class: 'row-item-actions' }, String(member.messages || member.count || 0))));
      }
      wrap.appendChild(rows);
    }
    return wrap;
  }

  return { node: host, load };
}

// -- the settings page -------------------------------------------------------

function bannerOrBlank(server) {
  if (server.banner_url) {
    return el('img', { class: 'media-img', src: server.banner_url, alt: '' });
  }
  return el('div', { class: 'media-blank' }, icon('image', { size: 22 }));
}

function communitySettings(serverId) {
  const host = el('div', { class: 'settings-stack' });

  const welcomeContent = el('textarea', { class: 'input', rows: '4', placeholder: 'Welcome message shown to new members...' });
  welcomeContent.value = serverById(serverId)?.welcome_content || '';
  const welcomeEnabled = el('input', { type: 'checkbox', role: 'switch', 'aria-checked': String(!!serverById(serverId)?.welcome_enabled) });
  welcomeEnabled.checked = !!serverById(serverId)?.welcome_enabled;
  const guidelines = el('textarea', { class: 'input', rows: '6', placeholder: 'Community guidelines...' });
  guidelines.value = serverById(serverId)?.guidelines || '';
  const notificationDefaults = el('textarea', { class: 'input', rows: '4', placeholder: 'Notification defaults (JSON)...' });
  notificationDefaults.value = serverById(serverId)?.notification_defaults || '';
  const interactionSettings = el('textarea', { class: 'input', rows: '4', placeholder: 'Interaction settings (JSON)...' });
  interactionSettings.value = serverById(serverId)?.interaction_settings || '';

  const save = el('button', { class: 'btn btn--primary', type: 'button' }, 'Save settings');
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await Api.updateServerSettings(serverId, {
        welcome_content: welcomeContent.value,
        welcome_enabled: welcomeEnabled.checked,
        guidelines: guidelines.value,
        notification_defaults: notificationDefaults.value,
        interaction_settings: interactionSettings.value,
      });
      toast('Community settings saved.', { type: 'success' });
      await refreshServer(serverId);
    } catch (error) { errorToast(error); } finally { save.disabled = false; }
  });

  return host;
}

function communityAllowed(serverId) {
  const host = el('div', { class: 'settings-stack' });

  const instances = el('div', { class: 'stack' });
  const formHost = el('div', { class: 'stack' });

  function render() {
    host.replaceChildren(el('table', { class: 'table' },
      el('thead', el('tr',
        el('th', 'Instance'),
        el('th', 'Origin'),
        el('th', 'Trust'),
        el('th', 'Actions'))),
      el('tbody')));
    loadInstances();
  }

  async function loadInstances() {
    instances.replaceChildren(el('div', { class: 'stack' }, loading('Loading remote instances…')));
    let rows;
    try {
      rows = await Api.request('GET', '/api/continuum/instances');
    } catch (error) {
      instances.replaceChildren(failure(error, loadInstances));
      return;
    }
    if (!rows || !rows.length) {
      instances.replaceChildren(nothing('No remote instances yet. Add one below to begin federating.'));
    } else {
      instances.replaceChildren(el('table', { class: 'table' },
        el('thead', el('tr',
          el('th', 'Instance'),
          el('th', 'Origin'),
          el('th', 'Trust'),
          el('th', 'Actions'))),
        el('tbody', ...rows.map(instanceRow))));
    }
  }

  async function setTrust(id, status) {
    try {
      await Api.request('PATCH', '/api/continuum/instances/' + encodeURIComponent(id) + '/trust', { body: { trust_status: status } });
      toast('Trust updated.', { type: 'success' });
      loadInstances();
    } catch (error) { errorToast(error); }
  }

  const nameInput = el('input', { class: 'input', placeholder: 'Remote instance name', maxLength: '128' });
  const originInput = el('input', { class: 'input', placeholder: 'https://remote.example.com', maxLength: '512' });
  const keyInput = el('textarea', { class: 'input', rows: '4', placeholder: '-----BEGIN PUBLIC KEY-----...', maxLength: '512' });
  const addError = el('div', { class: 'form-error' });
  const addBtn = el('button', { class: 'btn btn--primary', type: 'button' }, 'Add instance');

  const addForm = el('div', { class: 'stack' },
    fieldBlock('Name', 'Shown in lists.', nameInput),
    fieldBlock('Origin', 'The instance\'s origin URL, https:// or http://.', originInput),
    fieldBlock('Public key', 'Paste the remote instance\'s public key so its events can be verified.', keyInput),
    el('div', { class: 'stack' }, addError, addBtn)
  );

  addBtn.addEventListener('click', async () => {
    addError.textContent = '';
    if (!nameInput.value.trim()) { addError.textContent = 'Give the instance a name.'; return; }
    if (!originInput.value.trim()) { addError.textContent = 'Enter its origin URL.'; return; }
    if (!keyInput.value.trim()) { addError.textContent = 'Paste its public key.'; return; }
    addBtn.disabled = true;
    try {
      await Api.request('POST', '/api/continuum/instances', { body: {
        id: nameInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        name: nameInput.value.trim(),
        origin: originInput.value.trim(),
        public_key: keyInput.value.trim(),
      }});
      nameInput.value = ''; originInput.value = ''; keyInput.value = '';
      toast('Remote instance added. It starts untrusted; set it to Trust to exchange events.', { type: 'success' });
      loadInstances();
    } catch (error) { addError.textContent = error.message || 'That did not work.'; }
    finally { addBtn.disabled = false; }
  });

  host.replaceChildren(
    panel({ title: 'Remote instances', body: instances }),
    panel({ title: 'Add a remote instance', body: addForm })
  );

  loadInstances();

  return host;
}


export function renderCommunitySettings(ctx) {
  const serverId = ctx.serverId;
  const server = serverById(serverId) || {};
  if (!communityAllowed(serverId)) {
    return {
      node: page({ wide: true },
        heading(server.name || 'Community', 'Settings'),
        el('div', { class: 'view-empty' },
          el('div', { class: 'view-empty-title' }, 'Not your call'),
          el('div', { class: 'view-empty-text' }, 'Only administrators can change this community.'))),
    };
  }

  const content = el('div', { class: 'settings-content' });
  const nav = el('nav', { class: 'settings-nav', 'aria-label': 'Community settings' });
  const layout = el('div', { class: 'settings-layout' }, nav, content);
  const host = el('div', { class: 'page page--wide' },
    heading(server.name || 'Community', 'Settings'),
    layout);

  const order = [
    ['overview', 'Overview', 'settings'],
    ['appearance', 'Appearance', 'image'],
    ['channels', 'Channels', 'hash'],
    ['categories', 'Categories', 'layers'],
    ['members', 'Members', 'users'],
    ['roles', 'Roles', 'shield'],
    ['invites', 'Invites', 'mail'],
    ['moderation', 'Moderation', 'flag'],
    ['automation', 'Integrations', 'rocket'],
    ['analytics', 'Analytics', 'chart'],
    ['ownership', 'Ownership', 'crown'],
    ['settings', 'Settings', 'sliders'],
    ['memory', 'Memory', 'book'],
  ];
  const builders = {
    overview: () => overviewSection(serverId),
    appearance: () => appearanceSection(serverId),
    channels: () => channelsSection(serverId),
    categories: () => categoriesSection(serverId),
    members: () => membersSection(serverId),
    roles: () => rolesSection(serverId),
    invites: () => invitesSection(serverId),
    moderation: () => moderationSection(serverId),
    integrations: () => integrationsSection(serverId),
    analytics: () => analyticsSection(serverId),
    ownership: () => ownershipSection(serverId),
    settings: () => renderCommunitySettings({ serverId }),
    memory: () => memorySection(serverId),
  };

  const requested = (ctx.query && ctx.query.get('section')) || 'overview';
  let selected = builders[requested] ? requested : 'overview';

  const buttons = new Map();
  for (const [id, label, iconName] of order) {
    const item = el('button', {
      class: 'nav-item', type: 'button',
      'aria-current': id === selected ? 'true' : null,
      onClick: () => { selected = id; show(); },
    }, icon(iconName, { size: 17 }), el('span', { class: 'nav-label' }, label));
    buttons.set(id, item);
    nav.appendChild(item);
  }

  function show() {
    if (!builders[selected]) selected = 'overview';
    for (const [key, node] of buttons) {
      if (key === selected) node.setAttribute('aria-current', 'true');
      else node.removeAttribute('aria-current');
    }
    const section = builders[selected]();
    content.replaceChildren(section.node);
    if (section.load) { try { section.load(); } catch { /* the section reports its own failure */ } }
  }

  return { node: host, onMount: show };
}

// -- plain wrapper and the community landing ---------------------------------

function standalone(title, subtitle, maker) {
  const host = el('div', { class: 'view-host' });
  const node = page({ wide: true }, heading(title, subtitle), host);
  async function load() {
    host.replaceChildren(loading());
    try {
      const section = maker();
      host.replaceChildren(section.node);
      if (section && section.load) section.load();
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }
  return { node, onMount: load };
}

export function renderCommunityHome(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'rows' });
  const node = page({ wide: true },
    heading(serverName(serverId), 'Choose a channel.'),
    host);
  return { node, onMount() { paint(); } };

  function paint() {
    clear(host);
    const channels = channelsOf(serverId);
    if (!channels.length) {
      host.appendChild(nothing('No channels yet', 'An administrator can make one in settings.'));
      return;
    }
    for (const channel of channels.slice().sort((a, b) => (a.position || 0) - (b.position || 0))) {
      host.appendChild(el('a', { class: 'row-item', href: path('/server/' + serverId + '/channel/' + channel.id) },
        el('span', { class: 'row-item-icon' }, icon(iconFor(channel), { size: 17 })),
        el('div', { class: 'row-item-main' },
          el('div', { class: 'row-item-title' }, channel.name),
          channel.topic ? el('div', { class: 'row-item-sub truncate' }, channel.topic) : null)));
    }
  }
}

function pickServerImage(serverId, kind, done) {
  const input = el('input', { type: 'file', accept: 'image/*', class: 'visually-hidden' });
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    try {
      await Api.setServerImage(serverId, kind, file);
      toast('Image updated.', { type: 'success' });
      if (done) done();
    } catch (error) {
      toast(error.message, { type: 'danger' });
    }
  });
  input.click();
}

async function removeServerImage(serverId, kind, done) {
  try {
    await Api.removeServerImage(serverId, kind);
    toast('Image removed.', { type: 'success' });
    if (done) done();
  } catch (error) {
    toast(error.message, { type: 'danger' });
  }
}

function moderationSection(serverId) {
  const host = el('div', { class: 'stack' });
  async function load() {
    host.replaceChildren(loading('Loading bans'));
    try {
      const out = await Api.bans(serverId);
      const bans = Array.isArray(out) ? out : (out.bans || out.items || []);
      host.replaceChildren();
      if (!bans.length) {
        host.appendChild(empty({ icon: 'ban', title: 'Nobody is banned', text: 'People you ban appear here, and can be unbanned.' }));
        return;
      }
      for (const ban of bans) {
        const id = ban.user_id || ban.userId || ban.id;
        const name = ban.display_name || ban.displayName || ban.username || id;
        host.appendChild(el('div', { class: 'row-item' },
          el('div', { class: 'row-item-main' },
            el('div', { class: 'row-item-title' }, name),
            ban.reason ? el('div', { class: 'row-item-sub' }, ban.reason) : null),
          el('div', { class: 'row-item-actions' },
            button('Unban', { kind: 'default', onClick: () => unbanPerson(serverId, id, load) }))));
      }
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }
  load();
  return { node: host, load };
}

// -- Community Memory ------------------------------------------------------
//
// Curated knowledge that outlives chat history. Any member may read; writing
// needs the MEMORIZE permission. Revisions are append-only: editing creates a
// new revision row, so nothing is ever silently overwritten.

function memorySection(serverId) {
  const host = el('div', { class: 'stack' });
  const entries = el('div', { class: 'stack' });

  async function load() {
    host.replaceChildren(loading('Loading knowledge entries'));
    try {
      const list = await Api.communityMemory(serverId);
      host.replaceChildren(entries);
      if (!list.length) {
        host.appendChild(empty({
          icon: 'book',
          title: 'No knowledge entries yet',
          text: 'Curate community knowledge here. Entries persist beyond chat history.',
          action: el('button', { kind: 'primary', onClick: () => openEditor() }, 'Create entry'),
        }));
        return;
      }
      for (const entry of list) {
        host.appendChild(entryRow(entry));
      }
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }

  function entryRow(entry) {
    const revBadge = el('span', { class: 'badge' }, 'r' + (entry.revisionCount || 1));
    const byline = el('div', { class: 'stack stack--tight' },
      el('div', { class: 'row-item-sub truncate' }, entry.body),
      el('div', { class: 'row-item-actions' },
        el('span', { class: 'prow-sub' }, entry.updatedAt ? relative(entry.updatedAt) : null),
        revBadge));
    return el('div', { class: 'row-item' },
      el('div', { class: 'row-item-main' },
        el('div', { class: 'row-item-title truncate' }, entry.title),
        byline),
      el('div', { class: 'row-item-actions' },
        el('button', { kind: 'default', onClick: () => openEditor(entry) }, 'Edit'),
        el('button', { kind: 'default', onClick: () => openRevisions(entry) }, 'History'),
        el('button', { kind: 'default', onClick: () => del(entry.id) }, 'Delete')));
  }

  function openEditor(entry) {
    const title = el('input', { class: 'input', value: entry ? entry.title : '' });
    const body = el('textarea', { class: 'input', rows: 6, value: entry ? entry.body : '' });
    const form = el('form', { class: 'stack' },
      fieldBlock('Title', 'What this entry is called.', title),
      fieldBlock('Body', 'The knowledge itself.', body),
      el('div', { class: 'stack actions' },
        el('button', { kind: 'primary', type: 'button' }, entry ? 'Save' : 'Create'),
        el('button', { kind: 'ghost', type: 'button', onClick: () => dialog.close() }, 'Cancel')));
    const dialog = openDialog({
      title: entry ? 'Edit knowledge entry' : 'Create knowledge entry',
      body: form,
      onClose: () => { },
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const next = form.querySelector('button[type="button"]:not([kind="ghost"])');
      if (!next) return;
      next.disabled = true;
      try {
        if (entry) {
          await Api.updateCommunityMemory(serverId, entry.id, { title: title.value.trim(), body: body.value.trim() });
        } else {
          await Api.createCommunityMemory(serverId, { title: title.value.trim(), body: body.value.trim() });
        }
        dialog.close();
        load();
      } catch (error) { errorToast(error); } finally { next.disabled = false; }
    });
  }

  function openRevisions(entry) {
    const list = el('div', { class: 'stack' });
    async function loadRevs() {
      list.replaceChildren(loading('Loading revision history'));
      try {
        const revs = await Api.communityMemoryRevisions(serverId, entry.id);
        list.replaceChildren();
        if (!revs.length) {
          list.appendChild(empty({ icon: 'book', title: 'No revisions yet' }));
          return;
        }
        for (const rev of revs) {
          list.appendChild(el('div', { class: 'row-item' },
            el('div', { class: 'row-item-main' },
              el('div', { class: 'row-item-title truncate' }, 'Revision ' + rev.revision),
              el('div', { class: 'row-item-sub truncate' }, rev.body)),
            el('div', { class: 'row-item-actions' },
              el('span', { class: 'prow-sub' }, rev.createdAt ? relative(rev.createdAt) : null))));
        }
      } catch (error) {
        list.replaceChildren(failure(error, loadRevs));
      }
    }
    openDialog({
      title: 'Revision history',
      sub: entry.title,
      body: list,
      onClose: () => { },
    });
    loadRevs();
  }

  function del(id) {
    confirmDialog({
      title: 'Delete entry?',
      body: 'This removes the entry and its revision history. It cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    }).then(async (yes) => {
      if (!yes) return;
      try {
        await Api.deleteCommunityMemory(serverId, id);
        load();
      } catch (error) { errorToast(error); }
    });
  }

  load();
  return { node: host, load };
}

export default {
  renderChannel,
  renderChannelPins,
  renderMembersPage,
  renderRolesPage,
  renderInvitesPage,
  renderCategoriesPage,
  renderCommunitySettings,
  renderCommunityHome,
  membersSection,
  rolesSection,
  invitesSection,
  channelsSection,
  categoriesSection,
  overviewSection,
  appearanceSection,
  moderationSection,
  ownershipSection,
  integrationsSection,
  analyticsSection,
  memorySection,
};

// The phone's half of the action tables.
//
// One table for each kind of thing lives in the platform's actions module;
// the desk supplies its handlers, and this supplies the phone's. What each
// action does here is a sheet or a confirm; which actions are offered is the
// table's business, filtered by the permission the reader holds.

import Api from '../../packages/api.js';
import { el } from '../../packages/dom.js';
import { path, navigate } from '../../packages/nav.js';
import { State, isMuted, refreshMutes } from '../../packages/store.js';
import { CHANNEL_ACTIONS, CATEGORY_ACTIONS, MEMBER_ACTIONS } from '../../packages/actions.js';
import { sheet, closeSheet, confirm, field, failed, toast } from './ui.js';

function items(table, handlers, drop) {
  const out = [];
  for (const action of table) {
    if (drop(action)) continue;
    const handler = handlers[action.id];
    if (!handler) continue;
    out.push({ label: action.label, icon: action.icon, danger: action.danger, onClick: handler });
  }
  return out;
}

async function toggleMute(channelId) {
  try {
    if (isMuted(channelId)) await Api.unmuteChannel(channelId);
    else await Api.muteChannel(channelId);
    await refreshMutes();
  } catch (e) { failed(e); }
}

/** The actions on a channel, on the phone. */
export function channelActions(serverId, channel, options = {}) {
  const canManage = !!options.canManageChannels;
  const route = '/server/' + serverId + '/channel/' + channel.id;
  const muted = options.muted !== undefined ? options.muted : isMuted(channel.id);

  const handlers = {
    open: () => navigate(path(route)),
    'copy-link': async () => {
      try { await navigator.clipboard.writeText(window.location.origin + path(route)); toast('Link copied', { type: 'success' }); }
      catch { toast('This device will not copy.', { type: 'danger' }); }
    },
    mute: () => toggleMute(channel.id),
    unmute: () => toggleMute(channel.id),
    'copy-topic': async () => {
      try { await navigator.clipboard.writeText(channel.topic || ''); toast('Topic copied', { type: 'success' }); }
      catch { toast('This device will not copy.', { type: 'danger' }); }
    },
    edit: () => renameChannelSheet(serverId, channel),
    copy: async () => {
      try { await Api.createChannel(serverId, { name: channel.name + '-copy', type: channel.type, categoryId: channel.categoryId || channel.category_id }); toast('Channel copied', { type: 'success' }); if (options.onChange) options.onChange(); }
      catch (e) { failed(e); }
    },
    'move-up': () => moveChannel(serverId, channel, -1, options),
    'move-down': () => moveChannel(serverId, channel, 1, options),
    'move-to-category': () => moveCategorySheet(serverId, channel, options),
    settings: () => navigate(path('/server/' + serverId)),
    delete: async () => {
      if (!(await confirm({ title: 'Delete ' + (channel.name || 'this channel') + '?', text: 'The words in it go with it.', confirmLabel: 'Delete', danger: true }))) return;
      try { await Api.deleteChannel(serverId, channel.id); if (options.onChange) options.onChange(); }
      catch (e) { failed(e); }
    },
  };

  return items(CHANNEL_ACTIONS, handlers, (action) => {
    if (action.id === 'mute' && muted) return true;
    if (action.id === 'unmute' && !muted) return true;
    if (action.id === 'copy-topic' && !channel.topic) return true;
    if (action.needs === 'MANAGE_CHANNELS' && !canManage) return true;
    if ((action.id === 'move-up' || action.id === 'move-down') && !canManage) return true;
    return false;
  });
}

/** The actions on a category, on the phone. */
export function categoryActions(serverId, category, options = {}) {
  const canManage = !!options.canManageChannels;
  const handlers = {
    'create-channel': () => createChannelSheet(serverId, category, options),
    rename: () => renameCategorySheet(serverId, category, options),
    delete: async () => {
      if (!(await confirm({ title: 'Delete ' + (category.name || 'this category') + '?', text: 'Its channels come to the top of the place.', confirmLabel: 'Delete', danger: true }))) return;
      try { await Api.deleteCategory(serverId, category.id); if (options.onChange) options.onChange(); }
      catch (e) { failed(e); }
    },
  };
  return items(CATEGORY_ACTIONS, handlers, (action) => (action.needs === 'MANAGE_CHANNELS' && !canManage));
}

/** The actions on a member of a community, on the phone. */
export function memberActions(serverId, member, options = {}) {
  const perms = options.perms || {};
  const handlers = {
    roles: () => rolesSheet(serverId, member, options),
    timeout: async () => {
      const reason = await askReason({ title: 'Timeout ' + (member.displayName || member.username) + '?', note: 'They keep their words but lose their voice for a while.', confirmLabel: 'Timeout', danger: true, fieldLabel: 'Reason', placeholder: 'Why this timeout is in place' });
      if (!reason) return;
      const layer = sheet({ title: 'Timeout ' + (member.displayName || member.username), note: 'They keep their words but lose their voice for a while.' });
      for (const minutes of [10, 60, 1440]) {
        layer.body.appendChild(el('button', {
          class: 'm-row', type: 'button',
          onClick: async () => {
            try {
              await Api.timeoutMember(serverId, member.id, minutes, reason);
              layer.close(); toast('Timed out', { type: 'success' });
              if (options.onChange) options.onChange();
            } catch (e) { failed(e); }
          },
        }, el('div', { class: 'm-row__body' }, el('div', { class: 'm-row__name' },
        minutes === 10 ? 'Ten minutes' : minutes === 60 ? 'An hour' : 'A day'))));
      }
    },
    kick: async () => {
      if (!(await confirm({ title: 'Remove ' + (member.displayName || member.username) + '?', text: 'They may come back by invitation.', confirmLabel: 'Remove', danger: true }))) return;
      const reason = await askReason({ title: 'Why is this removal in place?', note: 'The reason is kept with the action.', confirmLabel: 'Remove', danger: true });
      if (!reason) return;
      try { await Api.kickMember(serverId, member.id, reason); if (options.onChange) options.onChange(); }
      catch (e) { failed(e); }
    },
    ban: async () => {
      if (!(await confirm({ title: 'Ban ' + (member.displayName || member.username) + '?', text: 'The community is closed to them until the ban is lifted.', confirmLabel: 'Ban', danger: true }))) return;
      const reason = await askReason({ title: 'Why is this ban in place?', note: 'The reason is kept with the ban.', confirmLabel: 'Ban', danger: true });
      if (!reason) return;
      try { await Api.banMember(serverId, member.id, reason); if (options.onChange) options.onChange(); }
      catch (e) { failed(e); }
    },
    permissions: async () => {
      try {
        const owned = await Api.memberPermissions(serverId, member.id);
        closeSheet();
        const layer = sheet({ title: 'What may they do here?' });
        const rows = Array.isArray(owned) ? owned : (owned && owned.permissions) || [];
        if (!rows.length) layer.body.appendChild(el('p', { class: 'm-sheet__note' }, 'Nothing special. The place treats them as anyone else.'));
        for (const p of rows) layer.body.appendChild(el('div', { class: 'm-row' }, el('div', { class: 'm-row__name' }, String(p))));
      } catch (e) { failed(e); }
    },
  };
  return items(MEMBER_ACTIONS, handlers, (action) => (action.needs && !perms[action.needs]));
}

// A reason is asked for before an enforcement-shaped action is carried
// out, because a reason is part of the action's own record and the server
// keeps it. The reason flows to the action's own call: a kick carries its
// removal reason, a ban its closure reason, a warn its note.
function askReason(options) {
  const opts = options || {};
  return new Promise((resolve) => {
    const layer = sheet({ title: opts.title || 'A reason', note: opts.note || null });
    const words = el('textarea', {
      class: 'm-area', rows: '4', maxlength: '2000',
      placeholder: opts.placeholder || 'The words that travel with the action',
      'aria-label': opts.fieldLabel || 'Reason',
    });
    const go = el('button', { class: 'm-go m-go--block', type: 'button' }, opts.confirmLabel || 'Save');
    layer.body.appendChild(field(opts.fieldLabel || 'Reason', words));
    layer.body.appendChild(go);
    go.addEventListener('click', async () => {
      const reason = words.value.trim();
      if (!reason) {
        toast('Write the reason first — it is kept with the action.', { type: 'danger' });
        return;
      }
      go.disabled = true;
      try {
        const value = await opts.run ? opts.run(reason) : reason;
        closeSheet();
        resolve(value);
      } catch (error) { failed(error); go.disabled = false; }
    });
  });
}

// --- the sheets the management actions open -----------------------------------

function renameChannelSheet(serverId, channel) {
  const layer = sheet({ title: 'Rename the channel' });
  const input = el('input', { class: 'm-input', type: 'text', value: channel.name || '', 'aria-label': 'Channel name' });
  const go = el('button', { class: 'm-go m-go--block', type: 'button' }, 'Save the name');
  go.addEventListener('click', async () => {
    go.disabled = true;
    try { await Api.updateChannel(serverId, channel.id, { name: input.value.trim() }); layer.close(); toast('Renamed', { type: 'success' }); }
    catch (e) { failed(e); go.disabled = false; }
  });
  layer.body.append(field('Name', input), go);
}

function renameCategorySheet(serverId, category, options) {
  const layer = sheet({ title: 'Rename the category' });
  const input = el('input', { class: 'm-input', type: 'text', value: category.name || '', 'aria-label': 'Category name' });
  const go = el('button', { class: 'm-go m-go--block', type: 'button' }, 'Save the name');
  go.addEventListener('click', async () => {
    go.disabled = true;
    try { await Api.updateCategory(serverId, category.id, { name: input.value.trim() }); layer.close(); if (options.onChange) options.onChange(); }
    catch (e) { failed(e); go.disabled = false; }
  });
  layer.body.append(field('Name', input), go);
}

function createChannelSheet(serverId, category, options) {
  const layer = sheet({ title: 'A new channel in ' + (category.name || 'the category') });
  const input = el('input', { class: 'm-input', type: 'text', placeholder: 'What is it called?', 'aria-label': 'Channel name' });
  const go = el('button', { class: 'm-go m-go--block', type: 'button' }, 'Make it');
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      await Api.createChannel(serverId, { name: input.value.trim(), type: 'text', categoryId: category.id });
      layer.close(); if (options.onChange) options.onChange();
    } catch (e) { failed(e); go.disabled = false; }
  });
  layer.body.append(field('Name', input), go);
}

async function moveChannel(serverId, channel, delta, options) {
  try {
    const ordered = options.orderedIds || [];
    const at = ordered.indexOf(channel.id);
    if (at === -1) return;
    const to = at + delta;
    if (to < 0 || to >= ordered.length) return;
    const next = ordered.slice();
    next[at] = ordered[to];
    next[to] = channel.id;
    await Api.reorderChannels(serverId, next);
    if (options.onChange) options.onChange();
  } catch (e) { failed(e); }
}

function moveCategorySheet(serverId, channel, options) {
  const layer = sheet({ title: 'Move ' + (channel.name || 'the channel') });
  for (const category of options.categories || []) {
    layer.body.appendChild(el('button', {
      class: 'm-row', type: 'button',
      onClick: async () => {
        try {
          await Api.updateChannel(serverId, channel.id, { categoryId: category.id });
          layer.close(); if (options.onChange) options.onChange();
        } catch (e) { failed(e); }
      },
    }, el('div', { class: 'm-row__body' }, el('div', { class: 'm-row__name' }, category.name || 'A category'))));
  }
}

function rolesSheet(serverId, member, options) {
  const layer = sheet({ title: 'The roles of ' + (member.displayName || member.username) });
  layer.body.appendChild(el('p', { class: 'm-sheet__note' }, 'Reading the roles\u2026'));
  Promise.all([Api.roles(serverId), Promise.resolve((member.roles || member.roleIds || []))])
    .then(([roles, owned]) => {
      const have = new Set((owned || []).map((r) => String(r.id || r)));
      const body = layer.body;
      body.textContent = '';
      if (!(roles || []).length) { body.appendChild(el('p', { class: 'm-sheet__note' }, 'This place has no roles yet; the desk makes them.')); return; }
      for (const role of roles) {
        body.appendChild(el('button', {
          class: 'm-row', type: 'button',
          onClick: async () => {
            try {
              if (have.has(String(role.id))) await Api.unassignRole(serverId, role.id, member.id);
              else await Api.assignRole(serverId, role.id, member.id);
              layer.close(); if (options.onChange) options.onChange();
            } catch (e) { failed(e); }
          },
        },
          el('div', { class: 'm-row__body' },
            el('div', { class: 'm-row__name' }, role.name || 'A role'),
            el('div', { class: 'm-row__note' }, have.has(String(role.id)) ? 'worn now' : '')),
          have.has(String(role.id)) ? el('span', { class: 'm-row__chevron' }, 'worn') : null));
      }
    })
    .catch((e) => failed(e));
}

// A report, from wherever a reader can raise one.
//
// The reasons are the server's own vocabulary, and the words are what a
// moderator reads first. The person reported is never told who filed it.
export function reportSheet(options) {
  const opts = options || {};
  const reasons = [
    ['harassment', 'Harassment or abuse'],
    ['spam', 'Spam or a scam'],
    ['impersonation', 'Pretending to be someone else'],
    ['other', 'Something else'],
  ];
  const pick = el('select', { class: 'm-input', 'aria-label': 'Reason' },
    reasons.map(([value, label]) => el('option', { value }, label)));
  const detail = el('textarea', {
    class: 'm-area', rows: '4', maxlength: '2000',
    placeholder: 'What happened? Anything you add helps whoever reads this.',
    'aria-label': 'What happened',
  });
  const send = el('button', { class: 'm-go m-go--block', type: 'button' }, 'Send the report');
  send.addEventListener('click', async () => {
    send.disabled = true;
    try {
      await Api.reports(Object.assign(
        { reason: pick.value, description: detail.value.trim() },
        opts.payload ? opts.payload(pick.value, detail.value.trim()) : {}));
      closeSheet();
      toast('The report is sent. Thank you.', { type: 'success' });
    } catch (error) {
      failed(error);
      send.disabled = false;
    }
  });
  const layer = sheet({
    title: opts.title || 'Send a report',
    note: opts.who
      ? 'This goes to whoever moderates this instance. ' + opts.who + ' is not told who filed it.'
      : 'This goes to whoever moderates this instance. Nobody is told who filed it.',
  });
  layer.body.appendChild(field('Reason', pick));
  layer.body.appendChild(field('What happened', detail));
  layer.body.appendChild(send);
  return layer;
}

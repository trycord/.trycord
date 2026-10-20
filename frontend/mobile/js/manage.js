// Managing a community's channels and categories, on a phone.
//
// These operations live here rather than in the views, because the channel
// list, the categories list and the settings strip all act on the same things
// and the only difference between them is where the control sits. One
// implementation means the settings section and the community's own list cannot
// disagree about what a channel is called or what creating one does.
//
// Every control is permission-aware. The client-side check is a courtesy - the
// server refuses the operation regardless - but a control that cannot work
// should not be offered in the first place.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { can, isOwner, isMuted, refreshMutes, refreshServerTree, channelsOf, categoriesOf } from '../../packages/store.js';
import { navigate, path } from '../../packages/nav.js';
import Api from '../../packages/api.js';
import { sheet, confirm, toast, menu, attachLongPress } from './ui.js';
import { copyText } from './clipboard.js';

export function iconFor(channel) {
  const type = String((channel && channel.type) || '').toLowerCase();
  if (type === 'voice' || type === 'stage') return 'volume';
  if (type === 'announcement') return 'bell';
  if (type === 'forum') return 'list';
  return 'hash';
}

export function canManageChannels(serverId) {
  return can(serverId, 'MANAGE_CHANNELS') || isOwner(serverId);
}

// The tree the client holds: the community's channels in the order the server
// keeps them.
function channelList(serverId) {
  return channelsOf(serverId).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
}

function categoryList(serverId) {
  return categoriesOf(serverId).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
}

/**
 * Put the channels into a new order.
 *
 * The server takes the whole order of the community's channels and refuses a
 * partial one, so nothing is sent when the list in hand is not the whole list.
 * A tree that is out of date is refreshed instead: the reader's move was not
 * wrong, the list they moved on was.
 */
export async function reorderChannels(serverId, orderedIds) {
  const known = channelList(serverId).map((channel) => String(channel.id));
  const given = (orderedIds || []).map(String);
  if (given.length !== known.length || !known.every((id) => given.indexOf(id) !== -1)) {
    await refreshServerTree(serverId, { force: true });
    toast('The order did not name every channel, so nothing was sent. The list has been reloaded.', { type: 'danger' });
    return false;
  }
  try {
    await Api.reorderChannels(serverId, given);
    await refreshServerTree(serverId, { force: true });
    return true;
  } catch (error) {
    toast((error && error.message) || 'That order did not save.', { type: 'danger' });
    return false;
  }
}

/** Put the categories into a new order. */
export async function reorderCategories(serverId, orderedIds) {
  const known = categoryList(serverId).map((category) => String(category.id));
  const given = (orderedIds || []).map(String);
  if (given.length !== known.length || !known.every((id) => given.indexOf(id) !== -1)) {
    await refreshServerTree(serverId, { force: true });
    toast('The order did not name every category, so nothing was sent. The list has been reloaded.', { type: 'danger' });
    return false;
  }
  try {
    await Api.reorderCategories(serverId, given);
    await refreshServerTree(serverId, { force: true });
    return true;
  } catch (error) {
    toast((error && error.message) || 'That order did not save.', { type: 'danger' });
    return false;
  }
}

/**
 * Move a channel one place up or one place down.
 *
 * A phone has no drag handle in a list this small, so the move is an explicit
 * action; the order it writes is the whole order, as the server requires.
 */
export async function moveChannelBy(serverId, channel, delta) {
  const list = channelList(serverId);
  const ids = list.map((entry) => String(entry.id));
  const at = ids.indexOf(String(channel.id));
  const to = at + delta;
  if (at === -1 || to < 0 || to >= ids.length) return false;
  const next = ids.slice();
  const [moved] = next.splice(at, 1);
  next.splice(to, 0, moved);
  return reorderChannels(serverId, next);
}

/** Move a channel into another category. */
export async function moveChannelToCategory(serverId, channel, categoryId) {
  try {
    await Api.updateChannel(serverId, channel.id, {
      name: channel.name,
      topic: channel.topic || '',
      type: channel.type || 'text',
      categoryId: categoryId || null,
    });
    await refreshServerTree(serverId, { force: true });
    toast('Channel moved.', { type: 'success' });
    return true;
  } catch (error) {
    toast((error && error.message) || 'That move did not save.', { type: 'danger' });
    return false;
  }
}

/**
 * Create or edit a channel.
 *
 * The same sheet does both, because the fields are the same and a reader who
 * has just created a channel usually wants to give it a topic next.
 */
export function openChannelEditor(serverId, channel, reload) {
  const editing = !!channel;
  const current = String((channel && channel.type) || 'text').toLowerCase();
  const name = el('input', {
    class: 'm-input', type: 'text', value: channel ? channel.name : '',
    placeholder: 'channel-name', maxlength: '60', 'aria-label': 'Channel name',
  });
  const topic = el('input', {
    class: 'm-input', type: 'text', value: channel ? (channel.topic || '') : '',
    placeholder: 'Topic', maxlength: '200', 'aria-label': 'Channel topic',
  });
  const type = el('select', { class: 'm-input m-input--select', 'aria-label': 'Channel type' },
    el('option', { value: 'text' }, 'Text channel'),
    el('option', { value: 'announcement' }, 'Announcement channel'),
    el('option', { value: 'voice' }, 'Voice channel'),
    el('option', { value: 'stage' }, 'Stage channel'));
  type.value = current;
  const category = el('select', { class: 'm-input m-input--select', 'aria-label': 'Category' },
    el('option', { value: '' }, 'No category'),
    ...categoryList(serverId).map((entry) => el('option', { value: entry.id }, entry.name)));
  category.value = (channel && channel.category_id) || '';

  const layer = sheet({
    title: channel ? 'Edit channel' : 'New channel',
    body: el('div', { class: 'm-stack' },
      el('label', { class: 'm-field' }, el('span', { class: 'm-field__label' }, 'Name'), name),
      el('label', { class: 'm-field' }, el('span', { class: 'm-field__label' }, 'Type'), type),
      el('label', { class: 'm-field' }, el('span', { class: 'm-field__label' }, 'Topic'), topic),
      el('label', { class: 'm-field' }, el('span', { class: 'm-field__label' }, 'Category'), category)),
    footer: el('button', {
      class: 'm-btn m-btn--block m-btn--primary', type: 'button',
      onClick: async (event) => {
        event.currentTarget.disabled = true;
        try {
          const clean = name.value.trim();
          if (!clean) { toast('Give the channel a name.'); event.currentTarget.disabled = false; return; }
          const payload = { name: clean, topic: topic.value, categoryId: category.value || null };
          if (!channel || type.value !== current) payload.type = type.value;
          if (channel) await Api.updateChannel(serverId, channel.id, payload);
          else await Api.createChannel(serverId, payload);
          layer.close();
          toast(channel ? 'Channel saved.' : 'Channel created.', { type: 'success' });
          if (reload) reload();
        } catch (error) {
          toast((error && error.message) || 'That did not save.', { type: 'danger' });
          event.currentTarget.disabled = false;
        }
      },
    }, channel ? 'Save' : 'Create'),
  });
  return layer;
}

export async function deleteChannel(serverId, channel, reload) {
  const last = channelList(serverId).length <= 1;
  const sure = await confirm({
    title: 'Delete #' + channel.name + '?',
    text: last
      ? 'It is the only channel here, and a community must keep one.'
      : 'Its messages go with it. This cannot be undone.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!sure) return false;
  try {
    await Api.deleteChannel(serverId, channel.id);
    await refreshServerTree(serverId, { force: true });
    toast('Channel deleted.', { type: 'success' });
    if (reload) reload();
    return true;
  } catch (error) {
    toast((error && error.message) || 'That channel did not delete.', { type: 'danger' });
    return false;
  }
}

export function openCategoryEditor(serverId, category, reload) {
  const name = el('input', {
    class: 'm-input', type: 'text', value: category ? category.name : '',
    placeholder: 'Category name', maxlength: '60', 'aria-label': 'Category name',
  });
  const layer = sheet({
    title: category ? 'Rename category' : 'New category',
    body: name,
    footer: el('button', {
      class: 'm-btn m-btn--block m-btn--primary', type: 'button',
      onClick: async (event) => {
        event.currentTarget.disabled = true;
        try {
          const value = name.value.trim();
          if (!value) { toast('Give the category a name.'); event.currentTarget.disabled = false; return; }
          if (category) await Api.updateCategory(serverId, category.id, { name: value });
          else await Api.createCategory(serverId, { name: value });
          layer.close();
          toast(category ? 'Category saved.' : 'Category created.', { type: 'success' });
          if (reload) reload();
        } catch (error) {
          toast((error && error.message) || 'That did not save.', { type: 'danger' });
          event.currentTarget.disabled = false;
        }
      },
    }, category ? 'Save' : 'Create'),
  });
  return layer;
}

export async function deleteCategory(serverId, category, reload) {
  const sure = await confirm({
    title: 'Delete "' + category.name + '"?',
    text: 'Its channels are not deleted, just ungrouped.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!sure) return false;
  try {
    await Api.deleteCategory(serverId, category.id);
    await refreshServerTree(serverId, { force: true });
    toast('Category deleted.', { type: 'success' });
    if (reload) reload();
    return true;
  } catch (error) {
    toast((error && error.message) || 'That category did not delete.', { type: 'danger' });
    return false;
  }
}

/**
 * The actions on a channel.
 *
 * Every entry performs: it navigates, it opens a sheet, or it calls the API.
 */
export function channelActions(serverId, channel, reload) {
  const items = [];
  const route = '/server/' + serverId + '/channel/' + channel.id;
  items.push({ label: 'Open', icon: 'arrow-right', onSelect: () => navigate(route) });
  items.push({ label: 'Copy link', icon: 'link', onSelect: () => copyText(window.location.origin + path(route), 'Link') });
  items.push({
    label: isMuted(channel.id) ? 'Unmute channel' : 'Mute channel',
    icon: isMuted(channel.id) ? 'bell' : 'volume-off',
    onSelect: () => toggleMute(channel),
  });
  if (canManageChannels(serverId)) {
    items.push({ separator: true });
    items.push({ label: 'Edit channel', icon: 'edit', onSelect: () => openChannelEditor(serverId, channel, reload) });
    items.push({ label: 'Move up', icon: 'arrow-up', onSelect: () => moveChannelBy(serverId, channel, -1) });
    items.push({ label: 'Move down', icon: 'arrow-down', onSelect: () => moveChannelBy(serverId, channel, 1) });
    items.push({
      label: 'Move to category', icon: 'folder',
      onSelect: () => openMoveSheet(serverId, channel, reload),
    });
    items.push({
      label: 'Delete channel', icon: 'trash', danger: true,
      onSelect: () => deleteChannel(serverId, channel, reload),
    });
  }
  return items;
}

/** Mute or unmute a channel. The state is the server's, so it is read. */
export async function toggleMute(channel) {
  const muted = isMuted(channel.id);
  try {
    if (muted) await Api.unmuteChannel(channel.id);
    else await Api.muteChannel(channel.id);
    await refreshMutes();
    toast(muted ? 'Unmuted.' : 'Muted.', { type: 'success' });
    return true;
  } catch (error) {
    toast((error && error.message) || 'That did not go through.', { type: 'danger' });
    return false;
  }
}

/** The actions on a category. */
export function categoryActions(serverId, category, reload) {
  const items = [{ header: category.name }];
  if (canManageChannels(serverId)) {
    items.push({ label: 'Create a channel here', icon: 'plus', onSelect: () => openChannelEditor(serverId, null, reload) });
    items.push({ separator: true });
    items.push({ label: 'Rename category', icon: 'edit', onSelect: () => openCategoryEditor(serverId, category, reload) });
    items.push({
      label: 'Delete category', icon: 'trash', danger: true,
      onSelect: () => deleteCategory(serverId, category, reload),
    });
  }
  return items;
}

/** Ask which category a channel should live in. */
export function openMoveSheet(serverId, channel, reload) {
  const options = categoryList(serverId);
  const layer = sheet({
    title: 'Move ' + channel.name,
    body: el('div', { class: 'm-stack' },
      el('p', { class: 'm-lede' }, 'The channel keeps its messages and its order.'),
      el('div', { class: 'm-list' },
        el('button', {
          class: 'm-row', type: 'button',
          onClick: () => { layer.close(); moveChannelToCategory(serverId, channel, null); },
        }, el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, 'No category'))),
        ...options.map((entry) => el('button', {
          class: 'm-row', type: 'button',
          onClick: () => { layer.close(); moveChannelToCategory(serverId, channel, entry.id); },
        }, el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, entry.name)))))),
  });
  return layer;
}

/** Show a channel's actions as a sheet. */
export function channelSheet(serverId, channel, reload) {
  return menu({ title: '#' + (channel.name || 'channel'), items: channelActions(serverId, channel, reload) });
}

/** Give a row the long press that raises a channel's actions. */
export function attachChannelMenu(node, serverId, channel, reload) {
  return attachLongPress(node, () => channelActions(serverId, channel, reload), { title: '#' + (channel.name || 'channel') });
}

export default {
  iconFor, canManageChannels, openChannelEditor, deleteChannel, openCategoryEditor,
  deleteCategory, channelActions, categoryActions, channelSheet, attachChannelMenu,
  openMoveSheet, moveChannelBy, moveChannelToCategory, reorderChannels, reorderCategories,
  toggleMute,
};

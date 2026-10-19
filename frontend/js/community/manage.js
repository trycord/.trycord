// Managing a community's channels and categories.
//
// These operations live here rather than in the tree or in the settings page,
// because both act on the same things and the only difference between them is
// where the control sits. One implementation means the tree's "create
// channel" and the settings page's channel list cannot disagree about what a
// channel is called, what creating one does, or which of them is offered.
//
// Every control here is permission-aware. The client-side check is a
// courtesy - the server refuses the operation regardless - but a control that
// cannot work should not be offered in the first place.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { State, refreshServerTree } from '../../packages/store.js';
import { openDialog, confirmDialog, openMenu, toast, errorToast } from '../ui/overlays.js';
import Api from '../../packages/api.js';

// The types the server can actually honour.
//
// `announcement` and `forum` exist in older rows as icons only - a channel of
// those types behaves exactly like a text channel - so they are not offered
// here. Offering one would promise a behaviour that is not there.
const CHANNEL_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'voice', label: 'Voice' },
];

function categoriesOf(serverId) {
  const tree = State.serverTree.get(serverId) || { categories: [] };
  return (tree.categories || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0));
}

/** Refresh the tree and say so. */
async function reload(serverId) {
  await refreshServerTree(serverId, { force: true });
}

/**
 * Create or edit a channel.
 *
 * The same dialog does both, because the fields are the same and a reader
 * who has just created a channel usually wants to give it a topic next.
 */
export function openChannelDialog(serverId, options = {}) {
  const channel = options.channel || null;
  const tree = State.serverTree.get(serverId) || { categories: [], channels: [] };
  const categories = categoriesOf(serverId);

  const name = el('input', {
    class: 'input', type: 'text',
    value: channel ? (channel.name || '') : '',
    'aria-label': 'Channel name',
    placeholder: 'general',
    maxlength: '32',
  });
  const topic = el('input', {
    class: 'input', type: 'text',
    value: channel ? (channel.topic || '') : '',
    'aria-label': 'Channel topic',
    placeholder: 'What is this channel for? (optional)',
    maxlength: '200',
  });
  const type = el('select', { class: 'input', 'aria-label': 'Channel type' },
    CHANNEL_TYPES.map((t) => el('option', { value: t.value }, t.label)));
  type.value = channel ? (channel.type || 'text') : 'text';

  // The category the channel will live in. A channel can also live in no
  // category at all, which is what the tree shows under "Other" - so the
  // choice is a real one rather than a required field.
  const category = el('select', { class: 'input', 'aria-label': 'Category' },
    el('option', { value: '' }, 'No category'),
    categories.map((c) => el('option', { value: c.id }, c.name)));
  const current = channel ? (channel.category_id || '') : (options.categoryId || '');
  category.value = categories.some((c) => c.id === current) ? current : '';

  const save = async (event) => {
    event.preventDefault();
    const clean = name.value.trim();
    if (!clean) { name.focus(); return; }
    const body = {
      name: clean,
      topic: topic.value.trim(),
      type: type.value,
      categoryId: category.value || null,
    };
    try {
      const saved = channel
        ? await Api.updateChannel(serverId, channel.id, body)
        : await Api.createChannel(serverId, body);
      dialog.close();
      await reload(serverId);
      // The server normalises a channel name - lower case, no punctuation - so
      // the name that is now in force is the one it returned, not the one that
      // was typed. Saying so is better than letting the tree disagree with
      // the box the reader just filled in.
      toast(channel ? 'Channel updated.' : 'Channel created.', { type: 'success' });
      if (options.onDone) options.onDone(saved);
    } catch (e) { errorToast(e); }
  };

  const dialog = openDialog({
    title: channel ? 'Edit ' + channel.name : 'New channel',
    sub: channel ? null : 'It starts in the category you choose, and you can move it later.',
    body: el('form', { class: 'fold', onSubmit: save },
      el('label', { class: 'field' },
        el('span', { class: 'field-label' }, 'Name'),
        name),
      el('label', { class: 'field' },
        el('span', { class: 'field-label' }, 'Topic'),
        topic),
      el('label', { class: 'field' },
        el('span', { class: 'field-label' }, 'Type'),
        type),
      el('label', { class: 'field' },
        el('span', { class: 'field-label' }, 'Category'),
        category),
      el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, channel ? 'Save' : 'Create channel')),
  });
  name.focus();
  return dialog;
}

/** Create or rename a category. */
export function openCategoryDialog(serverId, options = {}) {
  const category = options.category || null;
  const name = el('input', {
    class: 'input', type: 'text',
    value: category ? (category.name || '') : '',
    'aria-label': 'Category name',
    placeholder: 'Discussion',
    maxlength: '32',
  });
  const save = async (event) => {
    event.preventDefault();
    const clean = name.value.trim();
    if (!clean) { name.focus(); return; }
    try {
      if (category) await Api.updateCategory(serverId, category.id, { name: clean });
      else await Api.createCategory(serverId, { name: clean });
      dialog.close();
      await reload(serverId);
      toast(category ? 'Category renamed.' : 'Category created.', { type: 'success' });
      if (options.onDone) options.onDone();
    } catch (e) { errorToast(e); }
  };
  const dialog = openDialog({
    title: category ? 'Rename the category' : 'New category',
    sub: category ? null : 'A category groups channels. The channels in it keep their order.',
    body: el('form', { class: 'fold', onSubmit: save },
      el('label', { class: 'field' },
        el('span', { class: 'field-label' }, 'Name'),
        name),
      el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, category ? 'Save' : 'Create category')),
  });
  name.focus();
  return dialog;
}

export async function createChannel(serverId, categoryId) {
  openChannelDialog(serverId, { categoryId: categoryId || '' });
}

export async function renameChannel(serverId, channel) {
  openChannelDialog(serverId, { channel });
}

export async function createCategory(serverId) {
  openCategoryDialog(serverId, {});
}

export async function renameCategory(serverId, category) {
  openCategoryDialog(serverId, { category });
}

/**
 * Delete a channel.
 *
 * The messages in it go with it, and that is not reversible, so it is asked
 * for rather than assumed.
 */
export async function deleteChannel(serverId, channel) {
  const sure = await confirmDialog({
    title: 'Delete ' + channel.name + '?',
    body: 'The messages in it are deleted with it. This cannot be undone.',
    confirmLabel: 'Delete channel',
    danger: true,
  });
  if (!sure) return false;
  try {
    await Api.deleteChannel(serverId, channel.id);
    await reload(serverId);
    toast('Channel deleted.', { type: 'success' });
    return true;
  } catch (e) { errorToast(e); return false; }
}

/**
 * Delete a category.
 *
 * The channels in it are not deleted - they move out of it and are listed
 * under "Other" - because losing a category should not lose conversations.
 */
export async function deleteCategory(serverId, category) {
  const tree = State.serverTree.get(serverId) || { channels: [] };
  const inside = (tree.channels || []).filter((c) => c.category_id === category.id).length;
  const sure = await confirmDialog({
    title: 'Delete ' + category.name + '?',
    body: inside
      ? 'The ' + inside + ' channel' + (inside === 1 ? '' : 's') + ' in it are kept and move out of the category.'
      : 'The category is empty.',
    confirmLabel: 'Delete category',
    danger: true,
  });
  if (!sure) return false;
  try {
    await Api.deleteCategory(serverId, category.id);
    await reload(serverId);
    toast('Category deleted.', { type: 'success' });
    return true;
  } catch (e) { errorToast(e); return false; }
}

/**
 * Move a channel into another category.
 *
 * The server takes the whole order of the community's channels, so the move
 * is computed as a new order over all of them rather than a partial one - a
 * partial order is refused, and refusing it here would be a poor experience.
 */
export async function moveChannel(serverId, channel, categoryId) {
  const tree = State.serverTree.get(serverId) || { channels: [] };
  const all = (tree.channels || []).slice();
  const index = all.findIndex((c) => c.id === channel.id);
  if (index === -1) return false;
  const next = all.slice();
  next[index] = Object.assign({}, next[index], { category_id: categoryId || null });
  try {
    await Api.updateChannel(serverId, channel.id, {
      name: channel.name,
      topic: channel.topic || '',
      type: channel.type || 'text',
      categoryId: categoryId || null,
    });
    await reload(serverId);
    toast('Channel moved.', { type: 'success' });
    return true;
  } catch (e) { errorToast(e); return false; }
}

/** Put the channels into a new order. The server takes the whole list. */
export async function reorderChannels(serverId, orderedIds) {
  try {
    await Api.reorderChannels(serverId, orderedIds);
    await reload(serverId);
  } catch (e) { errorToast(e); }
}

/** Put the categories into a new order. */
export async function reorderCategories(serverId, orderedIds) {
  try {
    await Api.reorderCategories(serverId, orderedIds);
    await reload(serverId);
  } catch (e) { errorToast(e); }
}

/**
 * The channel's menu.
 *
 * The management entries are only here for a reader who may actually do them.
 */
export function channelMenuItems(serverId, channel, options = {}) {
  const items = [];
  const canManage = !!options.canManageChannels;
  const canEdit = !!options.canEditChannel;

  if (canEdit) {
    items.push({ label: 'Open', icon: 'arrow-right', onSelect: () => options.onOpen && options.onOpen() });
  }
  items.push({ label: 'Copy link', icon: 'link', onSelect: () => options.onCopyLink && options.onCopyLink() });
  if (options.onToggleMute) {
    items.push({
      label: options.muted ? 'Unmute' : 'Mute',
      icon: 'bell',
      onSelect: () => options.onToggleMute(),
    });
  }
  if (channel.topic && options.onCopyTopic) {
    items.push({ label: 'Copy topic', icon: 'copy', onSelect: () => options.onCopyTopic() });
  }

  if (canManage) {
    items.push({ separator: true });
    items.push({ label: 'Edit channel', icon: 'edit', onSelect: () => renameChannel(serverId, channel) });
    if (options.onMove) {
      items.push({ label: 'Move to category', icon: 'folder', onSelect: () => options.onMove() });
    }
    items.push({
      label: 'Channel permissions', icon: 'shield',
      onSelect: () => options.onPermissions && options.onPermissions(),
    });
    items.push({
      label: 'Delete channel', icon: 'trash', danger: true,
      onSelect: () => deleteChannel(serverId, channel),
    });
  }
  return items;
}

/** The category's menu. */
export function categoryMenuItems(serverId, category, options = {}) {
  const items = [{ header: category.name }];
  if (options.onCreateChannel) {
    items.push({ label: 'Create channel', icon: 'plus', onSelect: () => options.onCreateChannel() });
  }
  if (options.canManageChannels) {
    items.push({ separator: true });
    items.push({ label: 'Rename category', icon: 'edit', onSelect: () => renameCategory(serverId, category) });
    items.push({
      label: 'Delete category', icon: 'trash', danger: true,
      onSelect: () => deleteCategory(serverId, category),
    });
  }
  return items;
}

/** Open a menu at a point, for a right-click. */
export function menuAt(x, y, items) {
  return openMenu({ x, y, items });
}

export { icon };

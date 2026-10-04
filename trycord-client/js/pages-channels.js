import Api from './api.js';
import State from './state.js';

import { can, setViewRefresh } from './state.js';
import { clear, confirmDialog, el, openModal, toast } from './ui.js';
import { emptyState } from './components.js';
import { renderContextHeader } from './shell.js';
import { openOverrideEditor } from './permission-overrides.js';
import { ensureServer } from './workspace-shared.js';
import { channelPath } from './links.js';
import { navigate } from './nav.js';

function openChannelEditor(serverId, ch, cats, onDone) {
  const name = el('input', { class: 'input', type: 'text', maxlength: 32, value: ch.name || '' });
  const topic = el('input', { class: 'input', type: 'text', maxlength: 200, value: ch.topic || '' });
  const catSel = el('select', { class: 'input' });
  catSel.appendChild(el('option', { value: '' }, 'No category'));
  for (const c of cats) {
    const o = el('option', { value: String(c.id) }, c.name || 'Category');
    if (String(ch.category_id) === String(c.id)) o.selected = true;
    catSel.appendChild(o);
  }
  const err = el('div', { class: 'form-error', hidden: true });
  const cancel = el('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
  const save = el('button', { class: 'btn primary', type: 'button' }, 'Save channel');
  const modal = openModal({
    title: 'Edit channel',
    body: el('div', {}, err,
      el('div', { class: 'field' }, el('label', {}, 'Name'), name),
      el('div', { class: 'field' }, el('label', {}, 'Topic'), topic),
      el('div', { class: 'field' }, el('label', {}, 'Category'), catSel)),
    footer: [cancel, save],
  });
  cancel.addEventListener('click', () => modal.close());
  save.addEventListener('click', async () => {
    err.hidden = true;
    try {
      await Api.updateChannel(serverId, ch.id, {
        name: name.value.trim(), topic: topic.value.trim(), categoryId: catSel.value || null,
      });
      modal.close();
      toast('Channel updated.', 'ok');
      await onDone();
    } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Could not update channel.'; }
  });
}


async function renderNewChannel(container, serverId) {
  clear(container);
  try { await ensureServer(serverId); } catch { /* toast below */ }
  if (!can('MANAGE_CHANNELS')) {
    renderContextHeader({ title: 'New channel' });
    container.appendChild(el('div', { class: 'form-error' }, 'You need permission to manage channels in this community.'));
    return;
  }
  renderContextHeader({ title: 'New channel' });
  const wrap = el('div', { class: 'auth-wrap' });
  const card = el('div', { class: 'card card--auth' });
  const err = el('div', { class: 'form-error', hidden: true });
  const name = el('input', { class: 'input', type: 'text', placeholder: 'channel-name', maxlength: 32, required: true });
  const topic = el('input', { class: 'input', type: 'text', placeholder: 'Topic (optional)', maxlength: 200 });
  const catSelect = el('select', { class: 'select' });
  catSelect.appendChild(el('option', { value: '' }, 'No category'));
  for (const c of (State.channels.categories || [])) catSelect.appendChild(el('option', { value: c.id }, c.name));
  const createBtn = el('button', { class: 'btn primary block', type: 'submit' }, 'Create channel');

  const form = el('form', {}, err,
    el('div', { class: 'field' }, el('label', {}, 'Channel name'), name),
    el('div', { class: 'field' }, el('label', {}, 'Topic'), topic),
    el('div', { class: 'field' }, el('label', {}, 'Category'), catSelect),
    createBtn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const ch = await Api.createChannel(serverId, {
        name: name.value.trim(),
        topic: topic.value.trim() || undefined,
        categoryId: catSelect.value || undefined,
      });
      toast('Channel created.', 'ok');
      navigate(channelPath(serverId, ch.id));
    } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Failed'; }
  });

  card.appendChild(el('h1', {}, 'Create a channel'));
  card.appendChild(el('p', { class: 'auth-sub' }, 'Channels are how your community talks.'));
  card.appendChild(form);
  wrap.appendChild(card);
  container.appendChild(wrap);
}


function openCategoryRename(serverId, cat, onDone) {
  const name = el('input', { class: 'input', type: 'text', maxlength: 32, value: cat.name || '' });
  const err = el('div', { class: 'form-error', hidden: true });
  const cancel = el('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
  const save = el('button', { class: 'btn primary', type: 'button' }, 'Rename');
  const modal = openModal({
    title: 'Rename category',
    body: el('div', {}, err, el('div', { class: 'field' }, el('label', {}, 'Name'), name)),
    footer: [cancel, save],
  });
  cancel.addEventListener('click', () => modal.close());
  save.addEventListener('click', async () => {
    err.hidden = true;
    try {
      await Api.renameCategory(serverId, cat.id, name.value.trim());
      modal.close();
      toast('Category renamed.', 'ok');
      await onDone();
    } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Could not rename category.'; }
  });
}

async function renderServerCategories(container, serverId) {
  clear(container);
  let server;
  try { ({ detail: server } = await ensureServer(serverId)); }
  catch (ex) { container.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot open this community')); return; }
  renderContextHeader({ title: 'Categories', sub: server.name });
  const wrap = el('div', { class: 'page community-manager' });
  if (!can('MANAGE_CHANNELS')) { wrap.appendChild(el('div', { class: 'form-error' }, 'You need Manage Channels permission to edit categories.')); container.appendChild(wrap); return; }
  const createRow = el('div', { class: 'community-manager__toolbar' });
  const input = el('input', { class: 'input', type: 'text', maxlength: 64, placeholder: 'New category name' });
  const add = el('button', { class: 'btn primary', type: 'button' }, 'Add category');
  createRow.append(input, add); wrap.appendChild(createRow);
  const list = el('div', { class: 'community-list' }); wrap.appendChild(list);
  const reload = async () => { await ensureServer(serverId); paint(); };
  setViewRefresh(() => { reload().catch(() => {}); });
  const paint = () => {
    clear(list);
    const cats = [...(State.channels.categories || [])].sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
    const allChannels = [...(State.channels.channels || [])].sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
    if (!cats.length && !allChannels.length) {
      list.appendChild(emptyState('list', 'No categories', 'Channels without a category appear under Text channels.'));
    }
    cats.forEach((cat, idx) => {
      const channels = allChannels.filter((c) => String(c.category_id) === String(cat.id));
      const row = el('article', { class: 'community-category-card' });
      const main = el('div', { class: 'community-category-card__main' });
      main.appendChild(el('strong', {}, cat.name || 'Category'));
      main.appendChild(el('span', { class: 'muted small' }, channels.length + ' channel' + (channels.length === 1 ? '' : 's')));
      row.appendChild(main);
      const actions = el('div', { class: 'card--list__actions' });
      const rename = el('button', { class: 'btn sm', type: 'button' }, 'Rename');
      rename.addEventListener('click', () => openCategoryRename(serverId, cat, reload));
      const up = el('button', { class: 'btn sm', type: 'button', title: 'Move up', disabled: idx === 0 }, '▲');
      up.addEventListener('click', async () => {
        const ids = cats.map((c) => String(c.id));
        [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]];
        try { await Api.reorderCategories(serverId, ids); await reload(); }
        catch (ex) { toast(ex.message || 'Could not reorder categories.', 'error'); }
      });
      const down = el('button', { class: 'btn sm', type: 'button', title: 'Move down', disabled: idx === cats.length - 1 }, '▼');
      down.addEventListener('click', async () => {
        const ids = cats.map((c) => String(c.id));
        [ids[idx], ids[idx + 1]] = [ids[idx + 1], ids[idx]];
        try { await Api.reorderCategories(serverId, ids); await reload(); }
        catch (ex) { toast(ex.message || 'Could not reorder categories.', 'error'); }
      });
      const del = el('button', { class: 'btn danger sm', type: 'button' }, 'Delete');
      del.addEventListener('click', () => {
        confirmDialog({
          title: 'Delete category?',
          message: (cat.name || 'Category') + ' will be removed. Its ' + channels.length + ' channel(s) become uncategorized — channels are never deleted with it.',
          danger: true, confirmText: 'Delete',
          onConfirm: async () => {
            try { await Api.deleteCategory(serverId, cat.id); await reload(); toast('Category deleted.', 'ok'); }
            catch (ex) { toast(ex.message || 'Could not delete category.', 'error'); }
          },
        });
      });
      const perms = el('button', { class: 'btn sm', type: 'button' }, 'Permissions');
      perms.addEventListener('click', () => openOverrideEditor({
        kind: 'category', serverId, entityId: cat.id, entityName: cat.name || 'Category',
      }));
      actions.append(perms, rename, up, down, del);
      row.appendChild(actions);
      list.appendChild(row);
      for (const ch of channels) {
        const chRow = el('div', { class: 'community-channel-row' });
        chRow.appendChild(el('span', { class: 'ch-prefix' }, '#'));
        chRow.appendChild(el('span', { class: 'ch-name' }, ch.name || 'channel'));
        if (ch.topic) chRow.appendChild(el('span', { class: 'row-sub' }, ch.topic));
        chRow.appendChild(el('span', { class: 'spacer' }));
        const edit = el('button', { class: 'btn sm', type: 'button' }, 'Edit');
        edit.addEventListener('click', () => openChannelEditor(serverId, ch, cats, reload));
        const chPerms = el('button', { class: 'btn sm', type: 'button' }, 'Permissions');
        chPerms.addEventListener('click', () => openOverrideEditor({
          kind: 'channel', serverId, entityId: ch.id, entityName: '#' + (ch.name || 'channel'),
        }));
        const chDel = el('button', { class: 'btn danger sm', type: 'button' }, 'Delete');
        chDel.addEventListener('click', () => {
          confirmDialog({
            title: 'Delete channel?',
            message: '#' + (ch.name || 'channel') + ' and its messages will be permanently deleted.',
            danger: true, confirmText: 'Delete',
            onConfirm: async () => {
              try { await Api.deleteChannel(serverId, ch.id); await reload(); toast('Channel deleted.', 'ok'); }
              catch (ex) { toast(ex.message || 'Could not delete channel.', 'error'); }
            },
          });
        });
        chRow.append(chPerms, edit, chDel);
        list.appendChild(chRow);
      }
    });
    const ungrouped = allChannels.filter((c) => !c.category_id);
    if (ungrouped.length) {
      list.appendChild(el('div', { class: 'section-label' }, 'Text channels'));
      for (const ch of ungrouped) {
        const chRow = el('div', { class: 'community-channel-row' });
        chRow.appendChild(el('span', { class: 'ch-prefix' }, '#'));
        chRow.appendChild(el('span', { class: 'ch-name' }, ch.name || 'channel'));
        if (ch.topic) chRow.appendChild(el('span', { class: 'row-sub' }, ch.topic));
        chRow.appendChild(el('span', { class: 'spacer' }));
        const edit = el('button', { class: 'btn sm', type: 'button' }, 'Edit');
        edit.addEventListener('click', () => openChannelEditor(serverId, ch, cats, reload));
        const chPerms = el('button', { class: 'btn sm', type: 'button' }, 'Permissions');
        chPerms.addEventListener('click', () => openOverrideEditor({
          kind: 'channel', serverId, entityId: ch.id, entityName: '#' + (ch.name || 'channel'),
        }));
        const chDel = el('button', { class: 'btn danger sm', type: 'button' }, 'Delete');
        chDel.addEventListener('click', () => {
          confirmDialog({
            title: 'Delete channel?',
            message: '#' + (ch.name || 'channel') + ' and its messages will be permanently deleted.',
            danger: true, confirmText: 'Delete',
            onConfirm: async () => {
              try { await Api.deleteChannel(serverId, ch.id); await reload(); toast('Channel deleted.', 'ok'); }
              catch (ex) { toast(ex.message || 'Could not delete channel.', 'error'); }
            },
          });
        });
        chRow.append(chPerms, edit, chDel);
        list.appendChild(chRow);
      }
    }
  };
  add.addEventListener('click', async () => {
    const n = input.value.trim(); if (!n) return;
    try { await Api.createCategory(serverId, { name: n }); input.value = ''; await reload(); toast('Category created.', 'ok'); }
    catch (ex) { toast(ex.message || 'Could not create category.', 'error'); }
  });
  paint(); container.appendChild(wrap);
}

export { renderNewChannel, renderServerCategories };

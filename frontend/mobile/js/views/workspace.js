// The files a place keeps, on the phone.
//
// The desk's workspace studio holds spaces, documents, boards and the rest;
// the phone answers with the store of files — the part a hand needs on the
// go — and links to the rest through the place itself.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import { Workspace, mayPost } from '../../../packages/workspace.js';
import { State, serverById } from '../../../packages/store.js';
import { fileSize } from '../../../packages/format.js';
import { attachLongPress, failed, toast, confirm, emptyState, hold, failure, field } from '../ui.js';
import { nameOf, normalizeUser } from '../../../packages/store.js';

export function renderWorkspace(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'm-stack' });
  let version = 0;

  async function load() {
    const mine = ++version;
    const rows = await Workspace.files(serverId);
    if (mine !== version) return;
    paint(Array.isArray(rows) ? rows : (rows && rows.items) || []);
  }

  function fileRow(file) {
    const who = file.uploadedBy ? normalizeUser(file.uploadedBy) : null;
    const url = '/api/servers/' + serverId + '/files/' + file.id;
    const row = el('a', { class: 'm-row', href: url, target: '_blank', rel: 'noopener noreferrer' },
      el('span', { class: 'm-row__chevron' }, icon('hard-drive', { size: 18 })),
      el('div', { class: 'm-row__body' },
        el('div', { class: 'm-row__name' }, file.name || 'A file'),
        el('div', { class: 'm-row__note' },
          (file.size ? fileSize(file.size) : '') + (who ? ' · kept by ' + nameOf(who) : ''))),
      el('span', { class: 'm-row__time' }, file.createdAt || file.created_at ? new Date(file.createdAt || file.created_at).toLocaleDateString() : ''));
    attachLongPress(row, () => [
      { label: 'Open the file', icon: 'external', onClick: () => { window.open(url, '_blank', 'noopener,noreferrer'); } },
      { label: 'Copy the address', icon: 'edit', onClick: async () => {
        try { await navigator.clipboard.writeText(new URL(url, location.origin).href); toast('Copied', { type: 'success' }); }
        catch { toast('This device will not copy.', { type: 'danger' }); }
      } },
      { label: 'Delete it from the store', icon: 'trash', danger: true, onClick: async () => {
        if (!(await confirm({ title: 'Delete ' + (file.name || 'this file') + '?', text: 'The community loses the file for good.', confirmLabel: 'Delete', danger: true }))) return;
        try { await Workspace.deleteFile(serverId, file.id); toast('Deleted', { type: 'success' }); load(); }
        catch (e) { failed(e); }
      } },
    ]);
    return row;
  }

  function paint(rows) {
    clear(host);
    if (!rows.length) {
      host.appendChild(emptyState('hard-drive', 'No files yet',
        'The files a community keeps live here once somebody uploads them.'));
    } else {
      host.appendChild(el('div', { class: 'm-kicker' }, 'The store'));
      host.appendChild(el('div', { class: 'm-card' }, rows.map(fileRow)));
    }

    if (mayPost(serverId)) {
      const input = el('input', { type: 'file', hidden: true, 'aria-label': 'Upload a file' });
      input.addEventListener('change', async () => {
        const file = (input.files || [])[0];
        input.value = '';
        if (!file) return;
        try { await Api.uploadWorkspaceFile(serverId, file, () => {}); toast('Uploaded ' + file.name, { type: 'success' }); load(); }
        catch (e) { failed(e); }
      });
      host.appendChild(el('button', { class: 'm-go m-go--quiet m-go--block', type: 'button', onClick: () => input.click() }, icon('plus', { size: 18 }), 'Upload a file'));
      host.appendChild(input);
    }
  }

  host.appendChild(hold());
  load().catch((e) => { clear(host); host.appendChild(failure(e, load)); });

  return {
    node: host,
    head: { back: true, title: (serverById(serverId) || {}).name || 'Files', sub: 'The files this place keeps' },
    door: '/communities',
    onMount: load,
    cleanup() { version += 1; },
  };
}

// Invite management for a community: create, copy, revoke.
import Api from '../api.js';

import { can } from '../state.js';
import { attachContextMenu, clear, copyText, el, relTime, toast } from '../ui.js';
import { emptyState } from '../components.js';
import { renderContextHeader } from '../shell.js';
import { TrycordConfig } from '../config.js';
import { ensureServer } from '../workspace-shared.js';

async function renderInvites(container, serverId) {
  clear(container);
  let server;
  try { ({ detail: server } = await ensureServer(serverId)); }
  catch (ex) { container.appendChild(el('div', { class: 'form-error' }, ex.message)); return; }
  if (!can('MANAGE_INVITES')) {
    renderContextHeader({ title: 'Invites', sub: server.name });
    container.appendChild(el('div', { class: 'form-error' }, 'You need permission to manage invites in this community.'));
    return;
  }
  renderContextHeader({ title: 'Invites', sub: server.name });
  const wrap = el('div', { class: 'page community-manager' });

  const createBtn = el('button', { class: 'btn primary', type: 'button' }, 'Create invite');
  const maxUses = el('input', { class: 'input', type: 'number', min: 1, max: 100, value: '1', style: { width: '70px' }, title: 'Max uses' });
  const hours = el('input', { class: 'input', type: 'number', min: 1, max: 720, value: '48', style: { width: '80px' }, title: 'Hours valid' });
  const createRow = el('div', { class: 'row-line' },
    el('span', { class: 'muted small' }, 'Uses'), maxUses,
    el('span', { class: 'muted small' }, 'Hours'), hours, createBtn);
  wrap.appendChild(createRow);

  const listPane = el('div', { class: 'stack' });
  wrap.appendChild(listPane);

  async function reload() {
    clear(listPane);
    let invites = [];
    try { invites = await Api.invites(serverId); } catch { /* ignore */ }
    if (!invites.length) {
      listPane.appendChild(emptyState('compass', 'No invites yet', 'Create one above to share a link.'));
      return;
    }
    for (const inv of invites) {
      const link = TrycordConfig.backendUrl().replace(/\/+$/, '') + '/#/invite/' + inv.code;
      const row = el('div', { class: 'row' });
      // A revoked invite is already spent, so it offers no actions. Saying so
      attachContextMenu(row, () => (inv.revoked ? [
        { label: 'Revoked invite', disabled: true, desc: 'This link can no longer be used' },
        { label: 'Copy invite code', onSelect: () => copyText(String(inv.code), 'Invite code copied.') },
      ] : [
        { label: 'Copy invite link', onSelect: () => copyText(link, 'Invite link copied.') },
        { label: 'Copy invite code', onSelect: () => copyText(String(inv.code), 'Invite code copied.') },
        { sep: true },
        { label: 'Revoke invite', danger: true, onSelect: async () => {
          try { await Api.deleteInvite(serverId, inv.id); await reload(); }
          catch (ex) { toast(ex.message || 'Failed', 'error'); }
        } },
      ]), { target: () => ({ type: 'invite', id: String(inv.id) }) });
      const m = el('div', { class: 'row-main' });
      // instance, not at whatever is rendering this screen. location.origin is
      m.appendChild(el('div', { class: 'row-title mono' }, inv.code));
      m.appendChild(el('div', { class: 'row-sub' },
        inv.uses + ' uses' +
        (inv.max_uses ? '/' + inv.max_uses : '') +
        (inv.expires_at ? ' · expires ' + relTime(inv.expires_at) : '') +
        (inv.revoked ? ' · REVOKED' : '')));
      row.appendChild(m);
      const copyBtn = el('button', { class: 'btn sm', type: 'button' }, 'Copy link');
      copyBtn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(link); toast('Invite link copied.', 'ok'); }
        catch { toast(link, 'info'); }
      });
      const delBtn = el('button', { class: 'btn danger sm', type: 'button' }, 'Revoke');
      delBtn.addEventListener('click', async () => {
        try { await Api.deleteInvite(serverId, inv.id); await reload(); } catch (ex) { toast(ex.message || 'Failed', 'error'); }
      });
      row.appendChild(copyBtn);
      row.appendChild(delBtn);
      listPane.appendChild(row);
    }
  }

  createBtn.addEventListener('click', async () => {
    try {
      await Api.createInvite(serverId, { maxUses: parseInt(maxUses.value, 10) || null, expiresInHours: parseInt(hours.value, 10) || 48 });
      await reload();
      toast('Invite created.', 'ok');
    } catch (ex) { toast(ex.message || 'Failed', 'error'); }
  });

  container.appendChild(wrap);
  await reload();
}


// hash-routed sections) instead of inventing a second navigation pattern, and
// Sections are gated on the permission that already authorises the thing they
// describe, so the nav never offers a destination that would immediately

export { renderInvites };

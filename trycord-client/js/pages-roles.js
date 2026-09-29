// The role hierarchy: ordering, permissions, and the per-channel /
// per-category permission override editor.
import Api from './api.js';
import State from './state.js';

import { can, setViewRefresh } from './state.js';
import { clear, confirmDialog, copyText, el, toast, attachContextMenu } from './ui.js';
import { renderContextHeader } from './shell.js';
import { groupPermissions, humanizePerm } from './permission-groups.js';
import { assignableRoleTest, myTopPosition, openRoleAssignModal } from './role-assignment.js';
import { ensureServer } from './workspace-shared.js';
import { serverPath } from './links.js';

function roleColor(role) {
  return /^#[0-9a-f]{6}$/i.test((role && role.color) || '') ? role.color : null;
}

// Grouped permission toggles, built from whatever the server reports.
// Presentation only: `all` decides which permissions exist and `descriptions`
// supplies their text, so the client never keeps its own copy of either. A
// permission the server adds later lands in the "Other" group automatically

function permissionEditor(allPerms, descriptions, initial) {
  const current = new Set(initial || []);
  const checks = new Map();
  const node = el('div', { class: 'perm-groups' });
  for (const g of groupPermissions(allPerms, descriptions)) {
    const box = el('div', { class: 'perm-group' });
    box.appendChild(el('div', { class: 'perm-group__head' },
      el('span', { class: 'perm-group__title' }, g.title),
      el('span', { class: 'muted small' }, g.blurb)));
    const grid = el('div', { class: 'permission-grid' });
    for (const item of g.items) {
      const input = el('input', { type: 'checkbox' });
      input.checked = current.has(item.key);
      input.dataset.perm = item.key;
      checks.set(item.key, input);
      grid.appendChild(el('label', {
        class: 'permission-item',
        title: item.key + (item.description ? ' - ' + item.description : ''),
      }, input, el('span', { class: 'permission-item__text' },
        el('span', { class: 'permission-item__name' }, humanizePerm(item.key)),
        item.description ? el('span', { class: 'permission-item__desc' }, item.description) : null)));
    }
    box.appendChild(grid);
    node.appendChild(box);
  }
  if (!allPerms.length) {
    node.appendChild(el('div', { class: 'muted small' }, 'This server did not report any permissions.'));
  }
  return {
    node,
    checks,
    selected: () => [...checks.entries()].filter(([, i]) => i.checked).map(([k]) => k),
  };
}
async function renderServerRoles(container, serverId) {
  clear(container);
  let server;
  try { ({ detail: server } = await ensureServer(serverId)); }
  catch (ex) { container.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot open this community')); return; }
  renderContextHeader({ title: 'Roles', sub: server.name });

  const permsInfo = await Api.serverPermissions(serverId).catch(() => ({ all: [], descriptions: {} }));
  const allPerms = Array.isArray(permsInfo.all) ? permsInfo.all : [];
  const descriptions = permsInfo.descriptions || {};
  const isOwner = !!permsInfo.is_owner;
  const mayManage = can('MANAGE_ROLES');
  const top = myTopPosition();
  const test = assignableRoleTest(top);

  const ordered = () => [...(State.roles || [])].sort((a, b) => Number(b.position || 0) - Number(a.position || 0));
  const canManage = (role) => mayManage && test(String(role.id));
  const canReorder = () => mayManage && (isOwner || !ordered().some((r) => top <= Number(r.position || 0)));
  const memberCount = (roleId) =>
    (State.members || []).filter((m) => (m.roles || []).some((r) => String(r.id) === String(roleId))).length;

  const wrap = el('div', { class: 'page roles-page' });

  const roleActions = (role, { manageable, mayManage: canManageAny }) => {
    const items = [];
    const pick = () => { selectedId = String(role.id); paint(); paintDetail(); };

    if (manageable) {
      items.push({ label: 'Edit role', desc: 'Name, colour and permissions', onSelect: pick });
    } else {
      items.push({
        label: 'Edit role', disabled: true,
        desc: canManageAny ? 'This role ranks at or above your own' : 'You need Manage Roles',
      });
    }

    if (mayManage) {
      items.push({
        label: 'Manage members', desc: 'Assign or remove this role',
        onSelect: () => { location.hash = serverPath(serverId, 'members'); },
      });
    }

    items.push({ label: 'Copy role ID', onSelect: () => copyText(String(role.id), 'Role ID copied.') });

    if (role.is_default) {
      items.push({ sep: true });
      items.push({
        label: 'Protected role', disabled: true,
        desc: '@everyone always exists and cannot be deleted or renamed',
      });
    } else if (manageable) {
      items.push({ sep: true });
      items.push({ label: 'Delete role', danger: true, onSelect: () => confirmDeleteRole(role, n_for(role)) });
    }

    return items;
  };

  const n_for = (role) => (State.members || [])
    .filter((m) => (m.roles || []).some((r) => String(r.id) === String(role.id))).length;

  const confirmDeleteRole = (role, holders) => {
    confirmDialog({
      title: 'Delete ' + (role.name || 'role') + '?',
      message: holders > 0
        ? 'This role is on ' + holders + ' member' + (holders === 1 ? '' : 's')
          + '. Deleting it removes it from all of them. This cannot be undone.'
        : 'This role is not assigned to anyone. It cannot be undone.',
      danger: true, confirmText: 'Delete role',
      onConfirm: async () => {
        try {
          await Api.deleteRole(serverId, role.id);
          if (selectedId === String(role.id)) selectedId = null;
          await reload();
          paint();
          paintDetail();
          toast('Role deleted.', 'ok');
        } catch (ex) {
          toast(ex.message || 'Could not delete that role.', 'error');
        }
      },
    });
  };

  const head = el('div', { class: 'roles-head' });
  const headText = el('div', { class: 'roles-head__text' });
  headText.appendChild(el('h1', { class: 'page-title' }, 'Roles'));
  headText.appendChild(el('p', { class: 'muted small' },
    (State.roles || []).length + ' role' + ((State.roles || []).length === 1 ? '' : 's') +
    ' · highest first. Position decides what each member can manage.'));
  head.appendChild(headText);
  if (mayManage) {
    const newBtn = el('button', { class: 'btn primary', type: 'button' }, 'New role');
    newBtn.addEventListener('click', () => { selectedId = NEW_ROLE; paint(); paintDetail(); });
    head.appendChild(newBtn);
  }
  wrap.appendChild(head);

  if (!mayManage) {
    wrap.appendChild(el('div', { class: 'form-error' },
      'You need Manage Roles permission to change roles. The hierarchy below is still shown.'));
  } else {
    wrap.appendChild(el('p', { class: 'roles-hint' }, isOwner
      ? 'As the owner you can manage every role and set any order.'
      : 'You can manage roles below your own highest role. Roles at or above it are locked.'));
  }

  const listCol = el('div', { class: 'roles-list-col' });
  const detailCol = el('div', { class: 'roles-detail-col' });
  wrap.appendChild(el('div', { class: 'roles-grid' }, listCol, detailCol));

  const list = el('div', { class: 'role-hierarchy' });
  listCol.appendChild(el('div', { class: 'section-label' }, 'Hierarchy'));
  listCol.appendChild(list);

  const detail = el('div', { class: 'role-detail' });
  detailCol.appendChild(el('div', { class: 'section-label' }, 'Role details'));
  detailCol.appendChild(detail);

  const NEW_ROLE = '__new__';
  let selectedId = null;
  let dragId = null;

  const reload = async () => { await ensureServer(serverId); };
  setViewRefresh(() => { reload().catch(() => {}); });

  const paint = () => {
    clear(list);
    // The owner outranks every role and is not a role row, so it gets a
    const ownerName = (State.serverDetail && (State.serverDetail.owner_username || State.serverDetail.owner_name)) || 'Owner';
    list.appendChild(el('div', { class: 'role-row role-row--owner' },
      el('span', { class: 'role-row__handle' }),
      el('span', { class: 'role-row__rank' }, 'OWNER'),
      el('span', { class: 'role-row__name' }, ownerName),
      el('span', { class: 'role-row__meta' }, 'Highest · not reorderable')));

    const all = ordered();
    all.forEach((role, idx) => {
      const manageable = canManage(role);
      const selected = String(role.id) === String(selectedId);
      const row = el('div', {
        class: 'role-row' + (selected ? ' is-selected' : '') + (manageable ? '' : ' is-locked'),
        'data-role-id': String(role.id),
        draggable: manageable && canReorder() ? 'true' : null,
        tabindex: '0',
        role: 'listitem',
        'aria-label': (role.name || 'Role') + ', position ' + (all.length - idx) + ' of ' + all.length,
      });

      row.appendChild(el('span', {
        class: 'role-row__handle',
        title: manageable && canReorder() ? 'Drag to reorder' : 'Reordering unavailable',
        'aria-hidden': 'true',
      }, manageable && canReorder() ? '⠿' : ''));
      row.appendChild(el('span', { class: 'role-row__rank' }, String(all.length - idx)));

      const nameCell = el('span', { class: 'role-row__name' });
      const colour = roleColor(role);
      if (colour) nameCell.appendChild(el('span', { class: 'role-color-dot', style: { background: colour } }));
      const nameEl = el('span', {}, role.name || 'Role');
      if (colour) nameEl.style.color = colour;
      nameCell.appendChild(nameEl);
      if (role.is_default) nameCell.appendChild(el('span', { class: 'role-badge' }, '@everyone'));
      row.appendChild(nameCell);

      const n = memberCount(role.id);
      const p = (role.permissions || []).length;
      row.appendChild(el('span', { class: 'role-row__meta' },
        n + ' member' + (n === 1 ? '' : 's') + ' · ' + p + ' perm' + (p === 1 ? '' : 's')));
      if (!manageable) row.appendChild(el('span', { class: 'role-row__lock' }, 'locked'));

      row.addEventListener('click', () => { selectedId = String(role.id); paint(); paintDetail(); });
      attachContextMenu(row, () => roleActions(role, { manageable, mayManage }), {
        target: () => ({ type: 'role', id: String(role.id) }),
      });
      row.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        selectedId = String(role.id);
        paint();
        paintDetail();
      });

      if (manageable && canReorder()) {
        row.addEventListener('dragstart', (e) => {
          dragId = String(role.id);
          row.classList.add('is-dragging');
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', dragId); } catch { /* older engines */ }
          }
        });
        row.addEventListener('dragend', () => {
          dragId = null;
          row.classList.remove('is-dragging');
          list.querySelectorAll('.is-drop-target').forEach((n2) => n2.classList.remove('is-drop-target'));
        });
        row.addEventListener('dragover', (e) => {
          if (!dragId || dragId === String(role.id)) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
          row.classList.add('is-drop-target');
        });
        row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'));
        row.addEventListener('drop', async (e) => {
          e.preventDefault();
          row.classList.remove('is-drop-target');
          const from = dragId;
          const to = String(role.id);
          dragId = null;
          if (!from || from === to) return;
          const ids = ordered().map((r) => String(r.id));
          const a = ids.indexOf(from);
          const b = ids.indexOf(to);
          if (a < 0 || b < 0) return;
          ids.splice(a, 1);
          ids.splice(b, 0, from);
          try {
            await Api.reorderRoles(serverId, ids);
            await reload();
            paint();
            toast('Roles reordered.', 'ok');
          } catch (ex) {
            toast(ex.message || 'Could not reorder roles.', 'error');
            paint();
          }
        });
      }
      list.appendChild(row);
    });

    if (!all.length) {
      list.appendChild(el('div', { class: 'role-detail__empty' }, 'No roles yet.'));
    }
  };

  const paintDetail = () => {
    clear(detail);
    if (selectedId === NEW_ROLE) {
      detail.appendChild(buildCreateForm());
      return;
    }
    const role = (State.roles || []).find((r) => String(r.id) === String(selectedId));
    if (!role) {
      detail.appendChild(el('div', { class: 'role-detail__empty' },
        el('p', { class: 'muted small' }, 'Select a role to edit it, or create a new one.')));
      return;
    }
    detail.appendChild(buildRoleForm(role));
  };

  const buildCreateForm = () => {
    const box = el('div', { class: 'role-detail__form' });
    if (!mayManage) {
      box.appendChild(el('div', { class: 'muted small' }, 'You need Manage Roles permission to create roles.'));
      return box;
    }
    const name = el('input', { class: 'input', type: 'text', maxlength: 32, placeholder: 'Role name' });
    const colour = el('input', { type: 'color', class: 'input', value: '#ff8a24', title: 'Role color' });
    const perms = permissionEditor(allPerms, descriptions, []);
    const err = el('div', { class: 'form-error', hidden: true });
    const create = el('button', { class: 'btn primary', type: 'button' }, 'Create role');
    box.append(err,
      el('div', { class: 'field' }, el('label', {}, 'Role name'), name),
      el('div', { class: 'field' }, el('label', {}, 'Color'), colour),
      el('div', { class: 'section-label' }, 'Permissions'), perms.node, create);
    create.addEventListener('click', async () => {
      err.hidden = true;
      const value = name.value.trim();
      if (!value) { err.hidden = false; err.textContent = 'Enter a role name.'; return; }
      create.disabled = true;
      try {
        const made = await Api.createRole(serverId, {
          name: value, color: colour.value, permissions: perms.selected(),
        });
        await reload();
        selectedId = String(made.id);
        paint();
        paintDetail();
        toast('Role created.', 'ok');
      } catch (ex) {
        err.hidden = false;
        err.textContent = ex.message || 'Could not create role.';
      } finally { create.disabled = false; }
    });
    return box;
  };

  const buildRoleForm = (role) => {
    const box = el('div', { class: 'role-detail__form' });
    const n = memberCount(role.id);
    const p = (role.permissions || []).length;
    const summary = el('div', { class: 'role-detail__summary' },
      el('span', {}, 'Position ' + Number(role.position || 0)),
      el('span', {}, n + ' member' + (n === 1 ? '' : 's')),
      el('span', {}, p + ' permission' + (p === 1 ? '' : 's')));

    if (!mayManage || !canManage(role)) {
      box.append(
        el('div', { class: 'form-error' }, mayManage
          ? 'This role is at or above your own highest role, so you cannot change it.'
          : 'You need Manage Roles permission to change this role.'),
        el('div', { class: 'field' }, el('label', {}, 'Name'),
          el('input', { class: 'input', type: 'text', value: role.name || '', disabled: true })),
        summary);
      if (!mayManage) {
        const perms = permissionEditor(allPerms, descriptions, role.permissions || []);
        perms.checks.forEach((i) => { i.disabled = true; });
        box.appendChild(el('div', { class: 'section-label' }, 'Permissions'), perms.node);
      }
      return box;
    }

    const name = el('input', { class: 'input', type: 'text', maxlength: 32, value: role.name || '' });
    const colourRow = el('div', { class: 'row-line' });
    const colour = el('input', { type: 'color', class: 'input', value: roleColor(role) || '#ff8a24' });
    const clearColour = el('button', { class: 'btn ghost sm', type: 'button' }, 'No color');
    let useColour = !!roleColor(role);
    const paintColour = () => { colour.disabled = !useColour; clearColour.textContent = useColour ? 'No color' : 'Use color'; };
    clearColour.addEventListener('click', () => { useColour = !useColour; paintColour(); });
    paintColour();
    colourRow.append(colour, clearColour);

    const perms = permissionEditor(allPerms, descriptions, role.permissions || []);
    const err = el('div', { class: 'form-error', hidden: true });

    const holders = (State.members || []).filter((m) => (m.roles || []).some((r) => String(r.id) === String(role.id)));
    const memberSection = el('div', { class: 'role-members' });
    memberSection.appendChild(el('div', { class: 'section-label' }, 'Members with this role (' + holders.length + ')'));
    if (!holders.length) {
      memberSection.appendChild(el('div', { class: 'muted small' }, 'Nobody has this role yet.'));
    }
    for (const m of holders.slice(0, 12)) {
      const rowEl = el('div', { class: 'role-holder' },
        el('span', { class: 'role-holder__name' }, m.nickname || m.display_name || m.username || 'Unknown'),
        el('span', { class: 'muted small' }, '@' + (m.username || '')));
      const manage = el('button', { class: 'btn ghost sm', type: 'button' }, 'Manage');
      manage.addEventListener('click', () => {
        openRoleAssignModal({ serverId, member: m, onChanged: async () => { await reload(); paint(); } });
      });
      rowEl.appendChild(manage);
      memberSection.appendChild(rowEl);
    }
    if (holders.length > 12) {
      memberSection.appendChild(el('div', { class: 'muted small' }, '+ ' + (holders.length - 12) + ' more'));
    }

    const actions = el('div', { class: 'card-actions' });
    const save = el('button', { class: 'btn primary', type: 'button' }, 'Save changes');
    save.addEventListener('click', async () => {
      err.hidden = true;
      save.disabled = true;
      const patch = { color: useColour ? colour.value : null, permissions: perms.selected() };
      if (name.value.trim() !== String(role.name || '')) patch.name = name.value.trim();
      try {
        await Api.updateRole(serverId, role.id, patch);
        await reload();
        paint();
        paintDetail();
        toast('Role updated.', 'ok');
      } catch (ex) {
        err.hidden = false;
        err.textContent = ex.message || 'Could not update role.';
      } finally { save.disabled = false; }
    });
    actions.appendChild(save);

    if (role.is_default) {
      box.appendChild(el('div', { class: 'role-protected' },
        el('strong', {}, '@everyone is protected'),
        el('span', { class: 'muted small' },
          'Every member has this role, so it always exists. Its permissions and colour can be edited, but it cannot be renamed or deleted.')));
    } else {
      const del = el('button', { class: 'btn danger', type: 'button' }, 'Delete role');
      del.addEventListener('click', () => confirmDeleteRole(role, n_for(role)));
      actions.appendChild(del);
    }

    box.append(err, summary,
      el('div', { class: 'field' }, el('label', {}, 'Name'), name),
      el('div', { class: 'field' }, el('label', {}, 'Color'), colourRow),
      el('div', { class: 'section-label' }, 'Permissions'), perms.node,
      memberSection, actions);
    return box;
  };

  paint();
  paintDetail();
  container.appendChild(wrap);
}

export { renderServerRoles };

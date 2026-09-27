// Role assignment for a single member.
//
// Shared by the member management page and the user action menu so there is one
// assignment flow rather than a second, slightly different one. The server
// remains the authority: `assertAssignable` refuses any role at or above the
// actor's own rank, and `assignable` below is the client mirroring that same
// rule so the UI can grey out what would be rejected instead of offering it and
// eating an error.
import Api from './api.js';
import State, { can, refreshServerView } from './state.js';
import { el, clear, toast, openModal } from './ui.js';

function colorOf(role) {
  return /^#[0-9a-f]{6}$/i.test((role && role.color) || '') ? role.color : null;
}

// The one role pill, used by the member page, the role detail pane and the
// assignment dialog. It lived in pages-workspace.js until the assignment flow
// needed it too, and importing it back from there would have been a cycle -
// so it moved here rather than being written a second time.
export function rolePill(r, { removable = false, onRemove = null } = {}) {
  const pill = el('span', { class: 'role-pill' },
    colorOf(r) ? el('span', { class: 'role-color-dot', style: { background: r.color } }) : null,
    el('span', {}, r.name || 'Role'));
  if (colorOf(r)) { pill.style.color = r.color; pill.style.borderColor = r.color; }
  if (!removable) return pill;
  const x = el('button', {
    class: 'role-unassign', type: 'button',
    title: 'Remove role', 'aria-label': 'Remove role ' + (r.name || ''),
  }, '×');
  if (onRemove) x.addEventListener('click', onRemove);
  return el('span', { class: 'role-pill-wrap' }, pill, x);
}

// A row of role chips for a member, each removable when the viewer is allowed
// to remove it. Renders read-only when they are not.
export function rolePills(member, { serverId, assignable, onChanged } = {}) {
  const wrap = el('div', { class: 'role-pills' });
  const held = Array.isArray(member.roles) ? member.roles : [];
  if (!held.length) {
    wrap.appendChild(el('span', { class: 'muted small' }, 'No roles'));
    return wrap;
  }
  for (const role of held.slice().sort((a, b) => Number(b.position || 0) - Number(a.position || 0))) {
    const removable = assignable ? assignable(String(role.id)) : false;
    const chip = rolePill(role, {
      removable,
      onRemove: async () => {
        try {
          await Api.unassignRole(serverId, role.id, member.user_id || member.id);
          await refreshServerView();
          toast('Removed ' + (role.name || 'role') + '.', 'ok');
          if (onChanged) await onChanged();
        } catch (ex) {
          toast(ex.message || 'Could not remove that role.', 'error');
        }
      },
    });
    wrap.appendChild(chip);
  }
  return wrap;
}

// Roles the signed-in user may hand out: strictly below their own top role,
// which is exactly what assertAssignable allows. Owners may assign anything.
export function assignableRoleTest(topPosition) {
  const isOwner = (State.permissions || []).includes('*');
  return (roleId) => {
    if (!can('MANAGE_ROLES')) return false;
    if (isOwner) return true;
    const role = (State.roles || []).find((r) => String(r.id) === String(roleId));
    if (!role) return false;
    return topPosition > Number(role.position || 0);
  };
}

// Highest position the signed-in member holds. -1 when they hold nothing, which
// correctly makes every role unassignable.
export function myTopPosition() {
  const me = State.me;
  if (!me) return -1;
  const row = (State.members || []).find((m) => String(m.user_id || m.id) === String(me.id));
  const mine = (row && row.roles) || [];
  return mine.length ? Math.max(...mine.map((r) => Number(r.position || 0))) : -1;
}

export function openRoleAssignModal({ serverId, member, onChanged }) {
  const memberId = String(member.user_id || member.id);
  const isOwner = (State.permissions || []).includes('*');
  const myTop = myTopPosition();
  const test = assignableRoleTest(myTop);

  const held = new Set(((member.roles) || []).map((r) => String(r.id)));
  const candidates = (State.roles || [])
    .filter((r) => !held.has(String(r.id)))
    .filter((r) => test(String(r.id)));

  const search = el('input', {
    class: 'input', type: 'search', placeholder: 'Search roles…',
    'aria-label': 'Search roles to add',
  });
  const results = el('div', { class: 'role-add-list' });
  const status = el('div', { class: 'muted small', 'aria-live': 'polite' });

  const body = el('div', { class: 'role-assign' });
  const head = el('div', { class: 'role-assign__head' },
    el('div', { class: 'role-assign__member' },
      el('span', { class: 'muted small' }, 'Member'),
      el('strong', {}, member.nickname || member.display_name || member.username || 'Unknown')));
  body.appendChild(head);
  body.appendChild(el('div', { class: 'section-label' }, 'Current roles'));
  const pillsHost = el('div', {});
  body.appendChild(pillsHost);
  body.appendChild(el('div', { class: 'section-label' }, 'Add a role'));
  body.append(search, status, results);

  const done = el('button', { class: 'btn primary', type: 'button' }, 'Done');
  const modal = openModal({
    title: 'Manage roles',
    closable: true,
    body,
    footer: [done],
  });
  done.addEventListener('click', () => modal.close());

  const repaintPills = () => {
    clear(pillsHost);
    const fresh = (State.members || []).find((m) => String(m.user_id || m.id) === memberId);
    pillsHost.appendChild(rolePills(fresh || member, { serverId, assignable: test, onChanged }));
  };
  repaintPills();

  const paintResults = () => {
    clear(results);
    const q = search.value.trim().toLowerCase();
    const matches = candidates.filter((r) => !q || String(r.name || '').toLowerCase().includes(q));
    if (!matches.length) {
      results.appendChild(el('div', { class: 'muted small' },
        q ? 'No role matches that name.' : 'No other roles you can assign.'));
      return;
    }
    for (const role of matches) {
      const row = el('div', { class: 'role-add-row' });
      row.appendChild(rolePill(role));
      const add = el('button', { class: 'btn sm', type: 'button' }, 'Add');
      add.addEventListener('click', async () => {
        add.disabled = true;
        status.textContent = 'Assigning ' + (role.name || 'role') + '…';
        try {
          await Api.assignRole(serverId, role.id, memberId);
          await refreshServerView();
          status.textContent = (role.name || 'Role') + ' assigned.';
          repaintPills();
          if (onChanged) await onChanged();
        } catch (ex) {
          status.textContent = '';
          toast(ex.message || 'Could not assign that role.', 'error');
        } finally {
          add.disabled = false;
        }
      });
      row.appendChild(add);
      results.appendChild(row);
    }
  };
  paintResults();
  search.addEventListener('input', paintResults);

  if (!isOwner) {
    body.appendChild(el('p', { class: 'muted small' },
      'You can only assign roles below your own highest role.'));
  }
  return modal;
}

export default { rolePill, rolePills, openRoleAssignModal, assignableRoleTest, myTopPosition };

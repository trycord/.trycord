// Row menus. Together on purpose: a menu that works for a pointer and not a
// keyboard, or here and not there, is the bug this grouping prevents.

import { repaintChrome } from './repaint.js';
import { el, clear, qs, toast, relTime, confirmDialog, openModal, openReportDialog, attachMenu, attachContextMenu, showUserCard, copyText, announce } from '../ui.js';
import Api from '../api.js';
import State, { isAuthed, currentServerId, can, peerPresence, refreshServers, leaveServerContext, clearSession, refreshDms, refreshFriends, refreshNotifications, mustVerifyToPost, refreshServerView } from '../state.js';
import { channelPath, serverPath } from '../links.js';
import { navigate, route } from '../nav.js';

// Right-click and overflow menus for rows in the chrome.
// 
// All of it in one place on purpose: a menu that exists for a pointer and not for a
// keyboard, or on one surface and not another, is the failure this file exists to
// prevent. The actions are permission-shaped, so an action the viewer cannot
// perform is not offered rather than offered and refused.

// wiring, so a menu can never exist on one input method and be missing on
// another. Menus are permission-shaped here: an action the viewer cannot perform

export function serverChipMenuFor(s) {
  return () => {
    const sid = String(s.id);
    const isCurrent = sid === String(currentServerId());
    const mayManage = (isCurrent && can('MANAGE_SERVER')) || (s.is_owner && !isCurrent);
    return [
      { label: 'Open community', desc: s.name || '', onSelect: () => { navigate(serverPath(sid)); } },
      {
        label: 'Community settings', desc: mayManage ? undefined : 'Requires Manage Community',
        disabled: !mayManage,
        onSelect: () => { navigate(serverPath(sid, 'settings')); },
      },
      { label: 'Copy community link', onSelect: () => copyText(sid, 'Community ID copied.') },
      { label: 'Copy community ID', onSelect: () => copyText(sid, 'Community ID copied.') },
      { sep: true },
      {
        label: 'Leave community', danger: true,
        onSelect: () => {
          if (s.is_owner) { toast('You own this community. Transfer or delete it first.', 'warn'); return; }
          confirmDialog({
            title: 'Leave ' + (s.name || 'community') + '?',
            message: 'You can rejoin later with a new invite.',
            danger: true, confirmText: 'Leave',
            onConfirm: async () => {
              try {
                await Api.leaveServer(sid);
                await refreshServers();
                if (isCurrent) leaveServerContext();
                navigate('/home');
              } catch (ex) { toast(ex.message || 'Failed', 'error'); }
            },
          });
        },
      },
    ];
  };
}

export function roleAssignable(roleId) {
  if (!can('MANAGE_ROLES')) return false;
  if ((State.permissions || []).includes('*')) return true;
  const role = (State.roles || []).find((r) => String(r.id) === String(roleId));
  if (!role) return false;
  return myTopPosition() > Number(role.position || 0);
}

export function myTopPosition() {
  const me = State.me;
  if (!me) return -1;
  const row = (State.members || []).find((m) => String(m.user_id || m.id) === String(me.id));
  const mine = (row && row.roles) || [];
  return mine.length ? Math.max(...mine.map((r) => Number(r.position || 0))) : -1;
}

export function memberMenu(m) {
  return () => memberActions(m);
}

/**
 * Actions for one conversation in the sidebar.
 *
 * Everything here is something the DM routes already serve or something that is
 * purely local to this device. There is no "delete conversation" because the
 * server has no such route - offering one would be a button that either does
 * nothing or removes the conversation for both people, which is not what a
 * reader clicking it would expect.
 */
export function dmRowActions(dm, peer, name) {
  const items = [
    { label: 'Open conversation', onSelect: () => { navigate('/dms/' + dm.id); } },
    { label: 'Copy conversation ID', onSelect: () => copyText(String(dm.id), 'Conversation ID copied.') },
  ];
  if (peer && peer.id) {
    items.push({ sep: true });
    items.push({
      label: 'View profile',
      desc: name,
      onSelect: () => { navigate('/users/' + peer.id); },
    });
    items.push({
      label: 'Mark as read',
      onSelect: async () => {
        try {
          await Api.dmRead(dm.id);
          toast('Marked as read.', 'ok');
          refreshDms().catch(() => {});
        } catch (ex) {
          toast(ex.message || 'Could not mark that read.', 'error');
        }
      },
    });
  }
  return items;
}

// The action list for one member, permission-shaped. Exported so the member
export function memberActions(m) {
  const id = m.user_id || m.id;
  const sid = currentServerId();
  const name = m.nickname || m.display_name || m.username || 'Unknown';
  const mine = String(id) === String(State.me && State.me.id);
  const canMod = !m.is_owner && !mine && !!sid;
  const modTimeout = () => {
    const dur = el('select', { class: 'input' });
    [['60', '1 hour'], ['1440', '1 day'], ['10080', '7 days']].forEach(([v, label]) => {
      dur.appendChild(el('option', { value: v }, label));
    });
    const err = el('div', { class: 'form-error', hidden: true });
    const cancel = el('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
    const go = el('button', { class: 'btn danger', type: 'button' }, 'Time out');
    const modal = openModal({
      title: 'Time out @' + (m.username || ''),
      body: el('div', {}, el('div', { class: 'field' }, el('label', {}, 'Duration'), dur), err),
      footer: el('div', { class: 'row-line' }, cancel, go),
    });
    cancel.addEventListener('click', () => modal.close());
    go.addEventListener('click', async () => {
      try {
        await Api.timeoutMember(sid, id, Number(dur.value));
        modal.close();
        toast('Member timed out.', 'ok');
        repaintChrome();
      } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Could not time out.'; }
    });
  };

  // offered. There is deliberately no "assign to yourself" path anywhere.
  const held = new Set(((m.roles) || []).map((r) => String(r.id)));
  const assignable = (State.roles || []).filter((r) => !held.has(String(r.id)) && roleAssignable(String(r.id)));
  const removable = ((m.roles) || []).filter((r) => roleAssignable(String(r.id)));

  const rolesSubmenu = () => {
    if (!sid || mine) return null;
    if (!can('MANAGE_ROLES')) return null;
    const items = [];
    if (assignable.length) {
      items.push({ heading: 'Add role' });
      for (const r of assignable) {
        items.push({
          label: r.name || 'Role',
          desc: r.color ? 'Coloured' : undefined,
          onSelect: async () => {
            try {
              await Api.assignRole(sid, r.id, id);
              toast('Added ' + (r.name || 'role') + '.', 'ok');
              await refreshServerView();
              repaintChrome();
            } catch (ex) { toast(ex.message || 'Could not add that role.', 'error'); }
          },
        });
      }
    }
    if (removable.length) {
      if (items.length) items.push({ sep: true });
      items.push({ heading: 'Remove role' });
      for (const r of removable) {
        items.push({
          label: r.name || 'Role',
          onSelect: async () => {
            try {
              await Api.unassignRole(sid, r.id, id);
              toast('Removed ' + (r.name || 'role') + '.', 'ok');
              await refreshServerView();
              repaintChrome();
            } catch (ex) { toast(ex.message || 'Could not remove that role.', 'error'); }
          },
        });
      }
    }
    if (!items.length) return null;
    return { label: 'Roles', desc: 'Assign or remove', items };
  };

  const modSubmenu = () => {
    if (!canMod) return null;
    const items = [];
    if (can('BAN_MEMBERS')) items.push({ label: 'Timeout', onSelect: modTimeout });
    if (can('KICK_MEMBERS')) {
      items.push({
        label: 'Kick', danger: true, onSelect: () => confirmDialog({
          title: 'Remove member?', message: '@' + (m.username || '') + ' will leave this community immediately.',
          danger: true, confirmText: 'Remove',
          onConfirm: async () => {
            try { await Api.kickMember(sid, id); toast('Member removed.', 'ok'); repaintChrome(); }
            catch (ex) { toast(ex.message || 'Could not remove member.', 'error'); }
          },
        }),
      });
    }
    if (can('BAN_MEMBERS')) {
      items.push({
        label: 'Ban', danger: true, onSelect: () => confirmDialog({
          title: 'Ban @' + (m.username || '') + '?', message: 'They will be removed and blocked from rejoining.',
          danger: true, confirmText: 'Ban',
          onConfirm: async () => {
            try { await Api.banMember(sid, id, {}); toast('Member banned.', 'ok'); repaintChrome(); }
            catch (ex) { toast(ex.message || 'Could not ban member.', 'error'); }
          },
        }),
      });
    }
    if (!items.length) return null;
    return { label: 'Moderation', items };
  };

  const actions = [
    { label: 'View profile', onSelect: () => { navigate('/users/' + id); } },
    ...(mine ? [] : [{ label: 'Message', onSelect: () => messageMember(id) }]),
    { label: 'Copy user ID', onSelect: () => copyText(String(id), 'User ID copied.') },
  ];
  const roles = rolesSubmenu();
  if (roles) actions.push(roles);
  const mod = modSubmenu();
  if (mod) actions.push(mod);
  if (!mine) {
    actions.push({ sep: true });
    actions.push({
      label: 'Add friend', onSelect: async () => {
        try { await Api.sendFriendRequest(id); toast('Friend request sent.', 'ok'); }
        catch (ex) { toast(ex.message || 'Could not send request.', 'error'); }
      },
    });
    actions.push({
      label: 'Report user', onSelect: () => openReportDialog({
        targetType: 'user', targetId: id, title: 'Report user', subtitle: '@' + (m.username || 'unknown'),
        onSubmit: ({ category, extra }) => Api.reportContent('user', id, category, extra || undefined),
      }),
    });
  }
  return actions;
}

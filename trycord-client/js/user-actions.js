// in three places that disagreed. Every action is gated on a real permission

import Api from './api.js';
import State, { can, currentServerId, isAuthed, isBlocked, refreshBlocks } from './state.js';
import { el, toast, confirmDialog, showUserCard, showContextMenu, closeContextMenu } from './ui.js';
import { avatar, avatarUrlOf, bannerUrlOf } from './components.js';
import { openRoleAssignModal } from './role-assignment.js';
import { navigate } from './nav.js';

export function userNameButton(user, opts = {}) {
  const { serverId, className = 'msg-author', self = false, onCard, label } = opts;
  const id = user && (user.id || user.user_id);
  const name = label || user.nickname || displayNameOf(user);
  const btn = el('button', {
    class: className,
    type: 'button',
    'data-user-id': id ? String(id) : '',
    title: 'View ' + name,
  }, name);
  if (!id) { btn.disabled = true; return btn; }
  const ctx = { user, serverId, self: self || String(id) === String(State.me && State.me.id) };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = btn.getBoundingClientRect();
    openUserCard({ ...ctx, x: r.left, y: r.bottom + 6, onCard });
  });
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openUserMenu({ ...ctx, x: e.clientX, y: e.clientY });
  });
  return btn;
}

export function displayNameOf(user) {
  if (!user) return 'Unknown';
  return user.displayName || user.display_name || user.username || 'Unknown';
}

/**
 * Right-click menu for a user. Shares buildUserActions with the click card so
 * the two can never drift - same actions, same permission gates, same order.
 * A card and a menu are different affordances for the same question, so they
 * get one answer.
 */
export function openUserMenu({ user, x, y, serverId, self = false }) {
  const id = user && (user.id || user.user_id);
  if (!id) return;
  const sid = serverId || currentServerId();
  const name = displayNameOf(user);
  const isSelf = self || String(id) === String(State.me && State.me.id);
  const actions = buildUserActions({ user, id, name, sid, isSelf, blocked: isBlocked(id) });
  return showContextMenu(x, y, actions.map((a) => ({
    label: a.label,
    danger: a.danger,
    onSelect: a.onSelect,
  })));
}

export function openUserCard({ user, x, y, serverId, self = false, onCard = null }) {
  const id = user && (user.id || user.user_id);
  if (!id) return;
  const sid = serverId || currentServerId();
  const name = displayNameOf(user);
  const isSelf = self || String(id) === String(State.me && State.me.id);

  const av = avatar(
    { id, username: user.username, displayName: user.display_name || user.displayName, avatarUrl: avatarUrlOf(user) },
    { size: 'lg' }
  );

  const actions = buildUserActions({ user, id, name, sid, isSelf, blocked: isBlocked(id) });

  const sub = user.username && user.username !== name ? '@' + user.username : null;
  const roles = Array.isArray(user.roles) && user.roles.length
    ? user.roles.map((r) => r.name).filter(Boolean).join(', ')
    : null;
  const statusLine = roles || (user.status_text ? user.status_text : null);

  const card = showUserCard(x, y, {
    avatarEl: av, title: name, sub, statusLine, actions,
    bannerUrl: bannerUrlOf(user),
  });
  if (onCard) {
    try { onCard(card); } catch { /* customisation must not break the card */ }
  }
  return card;
}

export function buildUserActions({ user, id, name, sid, isSelf, blocked = false }) {
  const out = [];
  const authed = isAuthed();

  if (!authed) {
    out.push({ label: 'View profile', primary: true, onSelect: () => { navigate('/users/' + id); } });
    return out;
  }

  out.push({ label: 'View profile', onSelect: () => { navigate('/users/' + id); } });

  // Direct message. Never offer this to yourself, and never offer it to someone
  // the reader has blocked: the server refuses with NOT_ACCEPTING_DMS, so the
  // menu item would only ever exist to fail.
  if (!isSelf && !blocked) {
    out.push({
      label: 'Send message',
      primary: true,
      onSelect: async () => {
        try {
          const conv = await Api.openDm(id);
          const cid = conv && (conv.id || conv.conversationId);
          if (cid) navigate('/dms/' + cid);
        } catch (ex) { toast(ex.message || 'Could not open a conversation.', 'error'); }
      },
    });
  }

  if (sid && !isSelf && can('MANAGE_ROLES')) {
    out.push({
      label: 'Manage roles',
      onSelect: async () => {
        try {
          // the current row rather than trusting whatever the caller had. The
          const roster = await Api.serverMembers(sid, { limit: 500 });
          const rows = roster && Array.isArray(roster.items) ? roster.items : [];
          const row = rows.find((m) => String(m.user_id || m.id) === String(id));
          openRoleAssignModal({ serverId: sid, member: row || { id, username: user.username } });
        } catch (ex) {
          toast(ex.message || 'Could not open role management.', 'error');
        }
      },
    });
  }

  // Moderation. Each is gated on the permission that the server enforces.
  if (sid && !isSelf) {
    if (can('KICK_MEMBERS') || can('BAN_MEMBERS')) {
      out.push({
        label: 'Remove from community',
        danger: true,
        onSelect: () => confirmDialog({
          title: 'Remove ' + name + '?',
          message: 'They will lose access to this community. You can ban them instead to block them from rejoining.',
          danger: true,
          confirmText: 'Remove',
          onConfirm: async () => {
            try { await Api.kickMember(sid, id); toast(name + ' was removed.', 'ok'); }
            catch (ex) { toast(ex.message || 'Could not remove that member.', 'error'); }
          },
        }),
      });
    }
    if (can('BAN_MEMBERS')) {
      out.push({
        label: 'Ban',
        danger: true,
        onSelect: () => confirmDialog({
          title: 'Ban ' + name + '?',
          message: 'They will be blocked from rejoining this community.',
          danger: true,
          confirmText: 'Ban',
          onConfirm: async () => {
            try { await Api.banMember(sid, id); toast(name + ' was banned.', 'ok'); }
            catch (ex) { toast(ex.message || 'Could not ban that member.', 'error'); }
          },
        }),
      });
    }
  }

  // Blocking is a decision about your own account, not an act against theirs,
  // so it sits with Report rather than under the moderation gate above. The
  // server enforces it regardless of permissions; this is only the control.
  if (!isSelf) {
    if (blocked) {
      out.push({
        label: 'Unblock',
        onSelect: async () => {
          closeContextMenu();
          try {
            await Api.unblockUser(id);
            toast(name + ' can reach you again.', 'ok');
            await refreshBlocks();
          } catch (ex) { toast(ex.message || 'Could not unblock.', 'error'); }
        },
      });
      // Not returned here: blocking is a personal boundary, not moderation. A
      // blocked person can still be removed from a community or reported, and
      // hiding those would make blocking look like it did more than it does.
    } else {
    out.push({
      label: 'Block',
      danger: true,
      onSelect: () => {
        closeContextMenu();
        import('./ui.js').then(({ openModal, el: el2 }) => {
          const body = el2('div', { class: 'stack' });
          body.appendChild(el2('p', {}, 'Block ' + name + '?'));
          body.appendChild(el2('p', { class: 'set-note set-note--warn' },
            'They will not be able to message you or send you a friend request. Any friendship ends now, and they are not told why.'));
          const reason = el2('input', {
            class: 'input', type: 'text', maxlength: '500',
            placeholder: 'Reason (optional, for you)',
            'aria-label': 'Reason for blocking ' + name,
          });
          body.appendChild(reason);
          const row = el2('div', { class: 'row-line' });
          const cancel = el2('button', { class: 'btn ghost sm', type: 'button' }, 'Cancel');
          const go = el2('button', { class: 'btn danger sm', type: 'button' }, 'Block ' + name);
          const close = openModal({ title: 'Block ' + name, body, footer: row });
          cancel.addEventListener('click', () => close && close());
          go.addEventListener('click', async () => {
            go.disabled = true;
            try {
              await Api.blockUser(id, reason.value.trim() || undefined);
              toast(name + ' can no longer reach you.', 'ok');
              close && close();
              await refreshBlocks();
            } catch (ex) {
              toast(ex.message || 'Could not block.', 'error');
              go.disabled = false;
            }
          });
          row.append(go, cancel);
        }).catch(() => { toast('Could not open the block form.', 'error'); });
      },
    });
    }
  }

  // does not need a permission.
  out.push({
    label: 'Report',
    danger: true,
    onSelect: () => {
      closeContextMenu();
      // that was never sent.
      import('./ui.js').then(({ openReportDialog }) => {
        openReportDialog({
          targetType: 'user',
          targetId: id,
          title: 'Report ' + name,
          subtitle: 'Reports go to this instance’s moderators.',
          onSubmit: ({ category, extra }) => Api.reportContent('user', id, category, extra || undefined),
        });
      }).catch(() => { toast('Could not open the report form.', 'error'); });
    },
  });

  return out;
}

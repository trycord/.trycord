// Clickable usernames and contextual user actions.
//
// One module owns "what can I do about this person, here", because the answer
// is the same in a channel, a DM and the member list and previously existed
// in three places that disagreed. Every action is gated on a real permission
// check, and the client gate is only ever a mirror - the server re-checks
// each one.
//
// Rendering: a username is a <button>, not a <span>. It has to be reachable
// by keyboard and announced as interactive, and an <a href="#/users/id"> would
// be a lie because it navigates away from the message you were reading.

import Api from './api.js';
import State, { can, currentServerId, isAuthed } from './state.js';
import { el, toast, confirmDialog, showUserCard, showContextMenu, closeContextMenu } from './ui.js';
import { avatar, avatarUrlOf, bannerUrlOf } from './components.js';
import { openRoleAssignModal } from './role-assignment.js';

/**
 * A clickable username.
 *
 * @param {object} user  needs at least { id, username, displayName?, avatarUrl? }
 * @param {object} opts
 *  - serverId   community context, for role/moderation actions
 *  - className  extra classes on the button
 *  - self       true for "this is you", which suppresses self-targeted actions
 *  - onCard     called with the card position if you want to customise
 */
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
  // Right-click is the shortcut to the actions themselves, not a detour
  // through the card.
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
  const actions = buildUserActions({ user, id, name, sid, isSelf });
  return showContextMenu(x, y, actions.map((a) => ({
    label: a.label,
    danger: a.danger,
    onSelect: a.onSelect,
  })));
}

/**
 * Build and open the contextual card for a user.
 */
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

  const actions = buildUserActions({ user, id, name, sid, isSelf });

  const sub = user.username && user.username !== name ? '@' + user.username : null;
  const roles = Array.isArray(user.roles) && user.roles.length
    ? user.roles.map((r) => r.name).filter(Boolean).join(', ')
    : null;
  const statusLine = roles || (user.status_text ? user.status_text : null);

  // Banner comes from the same normalised accessor as the avatar, so a
  // member row (snake_case) and a /me payload (camelCase) both show it.
  const card = showUserCard(x, y, {
    avatarEl: av, title: name, sub, statusLine, actions,
    bannerUrl: bannerUrlOf(user),
  });
  if (onCard) {
    try { onCard(card); } catch { /* customisation must not break the card */ }
  }
  return card;
}

/**
 * The action list. Split out so other surfaces (member rows, message context
 * menus) can reuse the exact same set instead of inventing their own.
 */
export function buildUserActions({ user, id, name, sid, isSelf }) {
  const out = [];
  const authed = isAuthed();

  if (!authed) {
    out.push({ label: 'View profile', primary: true, onSelect: () => { location.hash = '#/users/' + id; } });
    return out;
  }

  // Profile is always safe and always first.
  out.push({ label: 'View profile', onSelect: () => { location.hash = '#/users/' + id; } });

  // Direct message. Never offer this to yourself.
  if (!isSelf) {
    out.push({
      label: 'Send message',
      primary: true,
      onSelect: async () => {
        try {
          const conv = await Api.openDm(id);
          const cid = conv && (conv.id || conv.conversationId);
          if (cid) location.hash = '#/dms/' + cid;
        } catch (ex) { toast(ex.message || 'Could not open a conversation.', 'error'); }
      },
    });
  }

  // Role assignment opens the real assignment dialog for this member. It used
  // to only link to the member list, which meant the only way to give someone a
  // role was to find them in a list of everyone - and the list carried no way
  // to remove a role at all.
  if (sid && !isSelf && can('MANAGE_ROLES')) {
    out.push({
      label: 'Manage roles',
      onSelect: async () => {
        try {
          // The roster is the only place a member's roles are known, so read
          // the current row rather than trusting whatever the caller had.
          const roster = await Api.serverMembers(sid);
          const row = (Array.isArray(roster) ? roster : [])
            .find((m) => String(m.user_id || m.id) === String(id));
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

  // Reporting is available to any member and is the only action here that
  // does not need a permission.
  out.push({
    label: 'Report',
    danger: true,
    onSelect: () => {
      closeContextMenu();
      import('./ui.js').then(({ openReportDialog }) => {
        openReportDialog({
          targetType: 'user',
          targetId: id,
          title: 'Report ' + name,
          subtitle: 'Reports go to this instance’s moderators.',
        });
      }).catch(() => { /* ui module always available in practice */ });
    },
  });

  return out;
}

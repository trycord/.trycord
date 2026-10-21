// What can be done to a thing.
//
// One table for each kind of thing, and both shells draw from it.
//
// The table says *what* the action is - its name, its glyph, whether it is a
// dangerous one, and the permission it needs - and never *how* it is carried
// out. The desktop opens a dialog and the phone opens a sheet; the reader is
// owed the same set of actions either way, and a menu that grows on one
// shell and not the other is a menu that lies about the software.
//
// So the two shells build their menus from these tables and supply the
// behaviour, and the check asks the question that keeps them honest: does
// every action in the table have a handler in both shells?
//
// An action is offered when the reader holds the permission it names. The
// permission is here rather than in the shell, so the two shells cannot
// disagree about who may do what.

/** The actions on a channel. */
export const CHANNEL_ACTIONS = [
  { id: 'open', label: 'Open', icon: 'arrow-right' },
  { id: 'copy-link', label: 'Copy link', icon: 'link' },
  { id: 'mute', label: 'Mute', icon: 'bell' },
  { id: 'unmute', label: 'Unmute', icon: 'bell' },
  { id: 'copy-topic', label: 'Copy topic', icon: 'copy' },
  { id: 'edit', label: 'Edit channel', icon: 'edit', needs: 'MANAGE_CHANNELS' },
  { id: 'copy', label: 'Copy channel', icon: 'copy', needs: 'MANAGE_CHANNELS' },
  { id: 'move-up', label: 'Move up', icon: 'arrow-up', needs: 'MANAGE_CHANNELS' },
  { id: 'move-down', label: 'Move down', icon: 'arrow-down', needs: 'MANAGE_CHANNELS' },
  { id: 'move-to-category', label: 'Move to category', icon: 'folder', needs: 'MANAGE_CHANNELS' },
  { id: 'settings', label: 'Channel settings', icon: 'shield', needs: 'MANAGE_CHANNELS' },
  { id: 'delete', label: 'Delete channel', icon: 'trash', danger: true, needs: 'MANAGE_CHANNELS' },
];

/** The actions on a category. */
export const CATEGORY_ACTIONS = [
  { id: 'create-channel', label: 'Create channel', icon: 'plus', needs: 'MANAGE_CHANNELS' },
  { id: 'rename', label: 'Rename category', icon: 'edit', needs: 'MANAGE_CHANNELS' },
  { id: 'delete', label: 'Delete category', icon: 'trash', danger: true, needs: 'MANAGE_CHANNELS' },
];

/** The actions on a member of a community. */
export const MEMBER_ACTIONS = [
  { id: 'roles', label: 'Edit roles', icon: 'shield', needs: 'MANAGE_ROLES' },
  { id: 'timeout', label: 'Timeout', icon: 'clock', needs: 'TIMEOUT_MEMBERS' },
  { id: 'kick', label: 'Remove from community', icon: 'logout', danger: true, needs: 'KICK_MEMBERS' },
  { id: 'ban', label: 'Ban from community', icon: 'ban', danger: true, needs: 'BAN_MEMBERS' },
  { id: 'permissions', label: 'What may they do here?', icon: 'shield' },
];

/** Every table, by the thing it belongs to. */
export const ACTION_MATRIX = {
  channel: CHANNEL_ACTIONS,
  category: CATEGORY_ACTIONS,
  member: MEMBER_ACTIONS,
};

/**
 * The action with this id, in this table.
 *
 * @param {object[]} table
 * @param {string} id
 * @returns {object|null}
 */
export function actionOf(table, id) {
  return (table || []).find((action) => action.id === id) || null;
}

/**
 * The ids in a table, in order.
 *
 * @param {object[]} table
 * @returns {string[]}
 */
export function actionIds(table) {
  return (table || []).map((action) => action.id);
}

export default {
  CHANNEL_ACTIONS, CATEGORY_ACTIONS, MEMBER_ACTIONS, ACTION_MATRIX, actionOf, actionIds,
};

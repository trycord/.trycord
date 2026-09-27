// Permission override editor.
//
// One component serves both channels and categories: the difference is only
// which API pair it calls, and the shape of the data is identical
// (a map of every known permission -> inherit | allow | deny).
//
// The editor is deliberately explicit about tri-state. A permission that is
// merely absent from every role looks identical to one that was explicitly
// denied, and those two mean very different things, so each row shows all
// three options with the inherited one preselected. That is the difference
// between a permission editor people can reason about and a grid of
// checkboxes that silently lies.

import Api from './api.js';
import { el, clear, toast } from './ui.js';

const EFFECTS = [
  { id: 'inherit', label: 'Inherit', hint: 'Use what roles grant' },
  { id: 'allow', label: 'Allow', hint: 'Always allow here' },
  { id: 'deny', label: 'Deny', hint: 'Always deny here' },
];

// Human labels for the permission registry. The registry is the source of
// truth for *which* permissions exist; this only prettifies the names.
const PERM_LABEL = {
  MANAGE_SERVER: 'Manage community settings',
  MANAGE_CHANNELS: 'Manage channels and categories',
  MANAGE_ROLES: 'Manage roles',
  MANAGE_INVITES: 'Manage invites',
  KICK_MEMBERS: 'Kick members',
  BAN_MEMBERS: 'Ban members',
  MANAGE_MESSAGES: 'Manage any message here',
  SEND_MESSAGES: 'Send messages',
};

function effectRow(perm, current, onPick, disabled) {
  const row = el('div', { class: 'perm-override-row' });
  const label = el('div', { class: 'perm-override-row__label' }, PERM_LABEL[perm] || perm);
  const group = el('div', { class: 'perm-override-row__opts', role: 'radiogroup', 'aria-label': PERM_LABEL[perm] || perm });
  for (const e of EFFECTS) {
    const id = 'ovr-' + perm + '-' + e.id;
    const input = el('input', { type: 'radio', name: 'ovr-' + perm, id, value: e.id });
    input.checked = current === e.id;
    input.disabled = !!disabled;
    input.addEventListener('change', () => { if (input.checked) onPick(perm, e.id); });
    group.appendChild(el('label', { class: 'perm-override-opt', for: id, title: e.hint }, input, el('span', {}, e.label)));
  }
  row.appendChild(label);
  row.appendChild(group);
  return row;
}

/**
 * Build the editor.
 *
 * @param {object} opts
 *  - kind: 'channel' | 'category'
 *  - serverId, entityId
 *  - permissions: string[]  authoritative list from the server
 *  - readOnly: boolean      viewer lacks MANAGE_CHANNELS
 *  - inherited: object      optional map of the parent level, shown as context
 */
export function permissionOverrideEditor(opts) {
  const {
    kind, serverId, entityId, permissions = [], readOnly = false, inherited = null,
  } = opts;

  const root = el('div', { class: 'perm-overrides' });
  root.appendChild(el('p', { class: 'muted small' },
    'Inherit uses whatever community roles grant. Allow and Deny override every role for this '
    + (kind === 'channel' ? 'channel' : 'category') + '.'));

  const body = el('div', { class: 'perm-overrides__list' });
  root.appendChild(body);
  const status = el('div', { class: 'muted small', role: 'status' });
  root.appendChild(status);

  let current = {};

  const set = async (perm, effect) => {
    if (readOnly) return;
    const prev = current[perm];
    current[perm] = effect;           // optimistic
    paint();
    status.textContent = 'Saving...';
    try {
      const res = kind === 'channel'
        ? await Api.setChannelOverride(serverId, entityId, perm, effect)
        : await Api.setCategoryOverride(serverId, entityId, perm, effect);
      current = res.overrides || current;
      status.textContent = 'Saved';
    } catch (ex) {
      current[perm] = prev;           // roll back so the UI never lies
      paint();
      status.textContent = '';
      toast(ex.message || 'Could not save that override.', 'error');
    }
  };

  function paint() {
    clear(body);
    for (const perm of permissions) {
      body.appendChild(effectRow(perm, current[perm] || 'inherit', set, readOnly));
    }
  }

  return {
    el: root,
    // Load the current state. Returns the map so a caller can also seed other
    // UI from it.
    async load() {
      try {
        const res = kind === 'channel'
          ? await Api.channelOverrides(serverId, entityId)
          : await Api.categoryOverrides(serverId, entityId);
        if (Array.isArray(res.all) && res.all.length) permissions.length = 0, permissions.push(...res.all);
        current = res.overrides || {};
        if (inherited && res.categoryOverrides && kind === 'channel') {
          // Show what the parent category contributes, so "inherit" is not a
          // black box when a category override is in play.
          root.insertBefore(
            el('p', { class: 'muted small' },
              'Inheriting also picks up the category'
              + (res.categoryId ? ' this channel is in.' : ' (this channel is uncategorised).')),
            status
          );
        }
        paint();
        return current;
      } catch (ex) {
        clear(body);
        body.appendChild(el('div', { class: 'form-error' }, ex.message || 'Could not load permission overrides.'));
        return null;
      }
    },
    get value() { return current; },
  };
}

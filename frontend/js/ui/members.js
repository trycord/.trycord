// The member roster.
//
// One roster, wherever it is shown: the community's members page and the
// inspector beside a channel draw the same rows, read the same way and offer
// the same actions. That is why it is here and not in either of them.
//
// Three things the roster has to do properly:
//
//   - It shows presence. A member who is here and a member who left an hour
//     ago look the same in a list of names, and the reader has to be able to
//     tell them apart.
//   - It pages. The server answers with { items, total, hasMore }, so a large
//     community is a first page and a button, not a truncated list that claims
//     to be the whole thing.
//   - It searches. `?q=` is the server's own filter, so the list narrows
//     server-side rather than in the browser.
//
// Every row opens the person sheet on a click and carries the person menu on a
// right-click, with the community's moderation entries added when the reader
// holds the permission that allows them.

import { el, replaceChildren } from '../../packages/dom.js';
import Api from '../../packages/api.js';
import {
  nameOf, presenceOf, refreshPresence, can, isOwner, on as onStore,
} from '../../packages/store.js';
import { on as onRealtime, EVENTS } from '../../packages/realtime.js';
import { avatarUrlOf } from '../../packages/identity.js';
import { roleChips } from '../../packages/roles.js';
import { MEMBER_ACTIONS } from '../../packages/actions.js';
import { avatar } from './primitives.js';
import { icon } from '../../packages/icons.js';
import { row, blank, card, fault, fold, hold } from './page.js';
import { personSheet, personContextMenu } from './person.js';
import { confirmDialog, errorToast, toast, openDialog } from './overlays.js';

const PAGE_SIZE = 50;

export const PRESENCE_LABEL = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do not disturb',
  offline: 'Offline',
};

export function presenceLabel(status) {
  return PRESENCE_LABEL[status] || PRESENCE_LABEL.offline;
}

// The moderation entries a reader may use on a member of this community. They
// are the community's own actions, so they are built here rather than in the
// person sheet, which knows nothing about communities.
export function memberActions(serverId, member, repaint) {
  const items = [];
  const name = nameOf(member) || member.username;

  // What each action does, on this shell. The table says which actions there
  // are and what they are called; this says what they do here.
  const handlers = {
    timeout: () => {
      Api.timeoutMember(serverId, member.id, 10)
        .then(() => { toast('Timed out for 10 minutes.', { type: 'success' }); repaint(); })
        .catch((e) => errorToast(e));
    },
    kick: () => {
      confirmDialog({
        title: 'Remove ' + name + '?',
        body: 'They can come back if there is a place for them.',
        confirmLabel: 'Remove',
        danger: true,
      }).then((yes) => {
        if (!yes) return;
        Api.kickMember(serverId, member.id)
          .then(() => { toast('Removed.', { type: 'success' }); repaint(); })
          .catch((e) => errorToast(e));
      });
    },
    ban: () => {
      confirmDialog({
        title: 'Ban ' + name + '?',
        body: 'A ban keeps them out until it is lifted on purpose.',
        confirmLabel: 'Ban',
        danger: true,
      }).then((yes) => {
        if (!yes) return;
        Api.banMember(serverId, member.id, '')
          .then(() => { toast('Banned.', { type: 'success' }); repaint(); })
          .catch((e) => errorToast(e));
      });
    },
    permissions: () => showPermissions(serverId, member, name),
  };

  for (const action of MEMBER_ACTIONS) {
    if (action.needs && !can(serverId, action.needs)) continue;
    // The owner cannot be timed out, kicked or banned by the menu.
    if ((action.id === 'kick' || action.id === 'ban' || action.id === 'timeout')
      && (member.isOwner || member.is_owner)) continue;
    const handler = handlers[action.id];
    if (!handler) continue;
    items.push({ label: action.label, icon: action.icon, onSelect: handler, danger: action.danger });
  }
  return items;
}

// What a member may actually do in a community.
//
// The answer has three parts, and the third is the one that matters: the
// roles they hold, what those roles give, and the places where an override
// makes the community different from the default. A person who may post
// everywhere except in the quiet channel is not a person who may post
// everywhere, and only the override says so.
export async function showPermissions(serverId, member, name) {
  const host = el('div', { class: 'fold' });
  const dialog = openDialog({
    title: 'What ' + (name || 'this person') + ' may do here',
    body: host,
  });
  host.replaceChildren(hold('Reading what this person may do'));
  let preview;
  try {
    preview = await Api.memberPermissions(serverId, member.id);
  } catch (error) {
    host.replaceChildren(fault(error, null));
    return;
  }

  // The roles they hold.
  const roles = el('div', { class: 'rowlist' });
  if (!preview.roles.length) {
    roles.replaceChildren(blank({
      glyph: 'shield',
      title: 'No roles',
      text: 'This person holds no role in this community.',
    }));
  } else {
    roles.replaceChildren(...preview.roles.map((role) => row({
      lead: el('span', { class: 'role-dot' }, icon('shield', { size: 15 })),
      title: role.name,
      sub: role.permissions.length
        ? role.permissions.join(' · ')
        : 'Grants nothing on its own',
    })));
  }

  // What the roles give, across the community.
  const wide = el('div', { class: 'rowlist' });
  if (preview.isOwner) {
    wide.replaceChildren(blank({
      glyph: 'crown',
      title: 'They hold everything',
      text: 'The owner of a community may do everything in it.',
    }));
  } else if (!preview.permissions.length) {
    wide.replaceChildren(blank({
      glyph: 'shield',
      title: 'Nothing',
      text: 'Their roles grant nothing across the community.',
    }));
  } else {
    wide.replaceChildren(...preview.permissions.map((permission) => row({
      lead: el('span', { class: 'role-dot' }, icon('check', { size: 15 })),
      title: permission,
      sub: 'Across the community',
    })));
  }

  // Where the community is different from that.
  const over = el('div', { class: 'rowlist' });
  if (!preview.overrides.length) {
    over.replaceChildren(blank({
      glyph: 'hash',
      title: 'Nowhere different',
      text: 'No channel or category here changes what they may do.',
    }));
  } else {
    over.replaceChildren(...preview.overrides.map((entry) => row({
      lead: el('span', { class: 'role-dot' }, icon('hash', { size: 15 })),
      title: entry.channelName,
      sub: entry.changed
        .map((change) => change.permission + ' ' + (change.effect === 'deny' ? 'is refused here' : 'is allowed here'))
        .join(' · '),
    })));
  }

  host.replaceChildren(fold([
    el('p', { class: 'lede' },
      'These are the permissions the server enforces for this person right now.'),
    card({ label: 'The roles they hold', glyph: 'shield', body: roles, flush: true }),
    card({ label: 'What that gives', glyph: 'check', body: wide, flush: true }),
    card({ label: 'Where it is different', glyph: 'hash', body: over, flush: true }),
  ]));
}

// One member, drawn. The presence is written twice - as the dot on the face and
// as the word beside the name - because a dot is a colour and a colour is not a
// sentence for a reader who cannot see it.
export function memberRow(serverId, member, repaint) {
  const user = {
    id: member.id,
    username: member.username,
    displayName: member.display_name || member.displayName || member.username,
    nickname: member.nickname || null,
    avatarUrl: avatarUrlOf(member),
    statusText: member.status_text || null,
  };
  const status = presenceOf(member.id);
  const label = presenceLabel(status);

  const node = row({
    class: 'member-row',
    link: true,
    lead: avatar(user, { size: 'sm', rounded: true, presence: status }),
    title: nameOf(user),
    // The roles, in the colours the community gave them.
    //
    // The roster answered with the roles of every member, and the row read a
    // field that was never there - so a member's roles were never shown at
    // all, and the colour of a role was a colour nothing drew.
    sub: roleChips(member) || (member.isOwner || member.is_owner
      ? 'Community owner' : '@' + (member.username || '')),
    meta: el('span', {
      class: 'member-presence', dataset: { presence: status },
    }, label),
    onClick: () => personSheet(node, user, {
      roles: member.roles || [],
      extra: memberActions(serverId, member, repaint),
    }),
  });

  personContextMenu(node, user, {
    roles: member.roles || [],
    extra: memberActions(serverId, member, repaint),
  });
  return node;
}

/**
 * The roster itself.
 *
 * `options.searchable` puts a search box above the list; `options.limit` is the
 * page size. The returned object carries the node and a cleanup, because the
 * roster listens for presence and must stop when the page goes away.
 */
export function memberList(serverId, options) {
  const opts = options || {};
  const limit = opts.limit || PAGE_SIZE;
  const body = el('div', { class: 'rowlist member-list' });
  const more = el('div', { class: 'member-more' });
  const count = el('span', { class: 'member-count' });

  const search = opts.searchable === false ? null : el('input', {
    class: 'input member-search', type: 'search',
    placeholder: 'Search members', 'aria-label': 'Search the members of this community',
    autocomplete: 'off', spellcheck: 'false',
  });

  const items = [];
  let total = 0;
  let hasMore = false;
  let query = '';
  let loading = false;
  let generation = 0;

  const repaint = () => paint();

  function paint() {
    if (!items.length) {
      replaceChildren(body, query
        ? blank({
          glyph: 'search',
          title: 'Nobody by that name',
          text: 'The search is the server\'s own, over names and nicknames.',
        })
        : blank({
          glyph: 'users',
          title: 'No one else is here',
          text: 'An invite is the way in - open the invites page to make one.',
        }));
      count.textContent = '';
      replaceChildren(more);
      return;
    }
    replaceChildren(body, ...items.map((member) => memberRow(serverId, member, repaint)));
    count.textContent = total
      ? items.length + ' of ' + total
      : items.length + (items.length === 1 ? ' member' : ' members');
    replaceChildren(more, hasMore
      ? el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        onClick: () => loadMore(),
      }, 'Load more members')
      : null);
  }

  async function fetchPage(offset) {
    const params = { limit };
    if (offset) params.offset = offset;
    if (query) params.q = query;
    const page = await Api.serverMembers(serverId, params);
    return {
      items: (page && page.items) || [],
      total: (page && page.total) || 0,
      hasMore: !!(page && page.hasMore),
    };
  }

  async function load() {
    const mine = ++generation;
    loading = true;
    replaceChildren(body, hold('Reading the roster'));
    replaceChildren(more);
    try {
      const page = await fetchPage(0);
      if (mine !== generation) return;
      items.length = 0;
      for (const member of page.items) items.push(member);
      total = page.total;
      hasMore = page.hasMore;
      paint();
      // The presence of the people on this page is asked for once; the rest
      // arrives on the realtime channel.
      refreshPresence(items.map((member) => member.id)).catch(() => {});
    } catch (error) {
      if (mine !== generation) return;
      replaceChildren(body, fault(error, load));
    } finally {
      if (mine === generation) loading = false;
    }
  }

  async function loadMore() {
    if (loading || !hasMore) return;
    loading = true;
    replaceChildren(more, el('p', { class: 'holdline' }, 'Reading more'));
    try {
      const page = await fetchPage(items.length);
      for (const member of page.items) {
        if (!items.some((known) => String(known.id) === String(member.id))) items.push(member);
      }
      total = page.total;
      hasMore = page.hasMore;
      paint();
      refreshPresence(page.items.map((member) => member.id)).catch(() => {});
    } catch (error) {
      replaceChildren(more, fault(error, loadMore));
    } finally {
      loading = false;
    }
  }

  // The search is the server's. Every keystroke replaces the list, so the
  // requests are debounced rather than one per letter.
  let searchTimer = null;
  if (search) {
    search.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        query = search.value.trim();
        load();
      }, 220);
    });
  }

  // Presence changes on their own: the realtime channel says who arrived and
  // who left, and the rows are redrawn rather than left claiming the old state.
  const offStore = onStore('presence', paint);
  const offRealtime = onRealtime(EVENTS.PRESENCE, () => paint());

  const node = el('div', { class: 'member-panel' },
    el('div', { class: 'member-head' },
      search,
      count),
    body,
    more);

  return {
    node,
    load,
    cleanup() {
      if (searchTimer) clearTimeout(searchTimer);
      offStore();
      offRealtime();
    },
  };
}

export default { memberList, memberRow, memberActions, presenceLabel, PRESENCE_LABEL };

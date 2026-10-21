// Direct messages.
//
// The list is a screen; opening one is the same scroll a channel uses, so the
// conversation engine is shared and this file only supplies its scope and the
// bar around it.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { avatar, empty, loading, failure, badge } from '../components.js';
import {
  State, dmPeer, dmName, dmPeople, nameOf, refreshDms, refreshFriends, presenceOf, on as onStore,
} from '../../../packages/store.js';
import { path, navigate } from '../../../packages/nav.js';
import { relativeTime } from '../../../packages/format.js';
import Api from '../../../packages/api.js';
import { avatarUrlOf } from '../../../packages/identity.js';
import { screen, section } from './util.js';
import { attachLongPress, sheet, confirm, toast } from '../ui.js';
import { personActions } from '../person.js';
import { renderConversation } from './messages.js';
import { setAppBar } from '../shell.js';

async function newGroup() {
  let friends = (State.friends || []).slice();
  if (!friends.length) {
    try { friends = await refreshFriends(); }
    catch (error) { showError(error); return; }
  }
  if (!friends.length) {
    toast('Add a friend before starting a group.');
    return;
  }

  const name = el('input', {
    class: 'm-input', type: 'text', maxlength: '120',
    placeholder: 'What is this group for?', 'aria-label': 'Group name',
  });
  const chosen = new Set();
  const list = el('div', { class: 'm-list' });
  const count = el('p', { class: 'm-section__note' });

  function paint() {
    count.textContent = chosen.size
      ? chosen.size + (chosen.size === 1 ? ' person selected' : ' people selected')
      : 'Choose who to invite.';
    list.replaceChildren(...friends.map((friend) => {
      const id = String(friend.id);
      const selected = chosen.has(id);
      return el('button', {
        class: 'm-row' + (selected ? ' is-active' : ''), type: 'button',
        'aria-pressed': String(selected),
        onClick: () => { selected ? chosen.delete(id) : chosen.add(id); paint(); },
      },
      el('span', { class: 'm-row__lead' }, avatar(friend, { size: 'sm', decorative: true })),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title truncate' }, nameOf(friend)),
        el('span', { class: 'm-row__sub truncate' }, '@' + (friend.username || ''))),
      el('span', { class: 'm-row__side' }, selected ? icon('check', { size: 18 }) : null));
    }));
  }
  paint();

  let layer;
  layer = sheet({
    title: 'New group',
    body: el('div', { class: 'm-stack' }, name, count, list),
    footer: el('div', { class: 'm-actions' },
      el('button', {
        class: 'm-btn m-btn--sm m-btn--primary', type: 'button',
        onClick: async () => {
          if (!name.value.trim()) { toast('Give the group a name.'); return; }
          if (!chosen.size) { toast('Choose at least one person.'); return; }
          try {
            const group = await Api.createDmGroup({ name: name.value.trim(), userIds: [...chosen] });
            layer.close();
            try { await refreshDms(); } catch { /* the conversation can load itself */ }
            toast('Group created.');
            navigate('/dms/' + group.id);
          } catch (error) { showError(error); }
        },
      }, 'Create group')),
  });
}

function peerOf(dm) {
  const peer = dmPeer(dm);
  if (peer) return peer;
  const users = (dm && (dm.users || dm.participants)) || [];
  const other = users.find((u) => !State.user || u.id !== State.user.id) || users[0] || null;
  if (!other) return null;
  return {
    id: other.id,
    username: other.username,
    displayName: other.display_name || other.displayName || other.username,
    avatarUrl: avatarUrlOf(other),
  };
}

function preview(dm) {
  const last = dm.lastMessage;
  if (!last) return 'No messages yet';
  const who = last.author_name || last.authorName || '';
  const text = String(last.content || '').replace(/\s+/g, ' ').trim();
  return (who ? who + ': ' : '') + text;
}

function showError(error) {
  toast(error && error.message ? error.message : 'Could not save that change. Try again.', { type: 'danger' });
}

export function renderDms() {
  const host = el('div', { class: 'm-stack' });
  const node = screen(
    el('div', { class: 'm-hero m-hero--quiet' },
      el('h1', { class: 'm-hero__title' }, 'Direct messages'),
      el('div', { class: 'm-hero__sub' }, 'Your one-to-one and group conversations.')),
    el('div', { class: 'm-actions' },
      el('button', {
        class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
        onClick: () => navigate('/friends'),
      }, icon('plus', { size: 16 }), 'New message'),
      el('button', {
        class: 'm-btn m-btn--sm m-btn--primary', type: 'button',
        onClick: newGroup,
      }, icon('users', { size: 16 }), 'New group')),
    host,
  );

  // A conversation read elsewhere clears its badge without a reload.
  let ready = false;
  const offDms = onStore('dms', () => { if (ready) paint(); });

  async function load() {
    host.replaceChildren(loading('Loading your conversations'));
    ready = true;
    try {
      await refreshDms();
      paint();
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }

  function paint() {
    host.replaceChildren();
    if (!State.dms.length) {
      host.appendChild(empty({
        icon: 'message',
        title: 'No conversations yet',
        text: 'Pick someone from your friends and send the first message.',
        action: el('a', { class: 'm-btn m-btn--primary', href: path('/friends') }, 'Go to friends'),
      }));
      return;
    }
    const list = el('div', { class: 'm-list' });
    for (const dm of State.dms) list.appendChild(rowFor(dm));
    host.appendChild(section('Conversations', list, { note: String(State.dms.length) }));
  }

  function rowFor(dm) {
    const peer = peerOf(dm);
    // A group is called by its name and has no single person on the other
    // side, so it is shown by a mark rather than a face.
    const group = !!(dm && dm.isGroup);
    const name = group ? dmName(dm) : (peer ? nameOf(peer) : 'Conversation');
    const updated = dm.updatedAt || dm.updated_at
      || (dm.lastMessage && (dm.lastMessage.created_at || dm.lastMessage.createdAt));
    const unread = Number(dm.unreadCount) || 0;
    const node = el('a', {
      class: 'm-row' + (unread ? ' is-unread' : ''),
      href: path('/dms/' + dm.id),
    },
      el('span', { class: 'm-row__lead' }, peer && !group
        ? avatar(peer, { size: 'md', presence: true, decorative: true })
        : el('span', { class: 'm-avatar m-avatar--md' }, icon(group ? 'users' : 'message', { size: 16 }))),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title truncate' }, name),
        el('span', { class: 'm-row__sub truncate' }, group
          ? String(dm.memberCount || 0) + ' people · ' + preview(dm)
          : preview(dm))),
      el('span', { class: 'm-row__trailing' },
        badge(unread),
        updated ? el('span', { class: 'm-row__time' }, relativeTime(updated)) : null));
    // A conversation is one of the things a person can be asked for, so the row
    // carries that person's actions on a long press.
    if (peer && !group) attachLongPress(node, () => personActions(peer), { title: name });
    return node;
  }

  return { node, head: { title: 'Messages' }, onMount: load, cleanup() { offDms(); } };
}

export function renderDm(ctx) {
  const id = ctx.params.id;
  const scope = {
    kind: 'dm',
    id,
    placeholder: 'Message',
    emptyTitle: 'No messages yet',
    emptyText: 'Say hello.',
    icon: 'message',
  };
  const conversation = renderConversation(ctx, scope);

  let peer = null;
  let dmRecord = null;
  let mounted = false;
  let loadGeneration = 0;
  function head() {
    const group = !!(dmRecord && dmRecord.isGroup);
    const people = group ? dmPeople(dmRecord) : [];
    if (group) {
      const count = Number(dmRecord.memberCount) || people.length + 1;
      return {
        lead: 'back',
        title: dmName(dmRecord),
        sub: count + (count === 1 ? ' person' : ' people'),
        mark: el('span', { class: 'm-avatar m-avatar--sm' }, icon('users', { size: 16 })),
        actions: [el('button', {
          class: 'm-iconbtn', type: 'button', 'aria-label': 'Open group details',
          onClick: openGroupDetails,
        }, icon('users', { size: 20 }))],
      };
    }
    if (!peer) return { lead: 'back', title: 'Conversation' };
    return {
      lead: 'back',
      title: nameOf(peer),
      sub: '@' + peer.username + ' · ' + presenceOf(peer.id),
      mark: avatar(peer, { size: 'sm', decorative: true }),
      actions: [el('button', {
        class: 'm-iconbtn', type: 'button',
        'aria-label': 'Open their profile',
        onClick: () => navigate('/users/' + peer.id),
      }, icon('user', { size: 20 }))],
    };
  }

  async function updateGroup() {
    try {
      await refreshDms();
      const fresh = await Api.dm(id);
      if (fresh && mounted) {
        dmRecord = fresh;
        peer = peerOf(fresh);
        setAppBar(head());
      }
    } catch {
      toast('The change saved, but this group did not refresh. Reopen it to see the latest details.', { type: 'danger' });
      return false;
    }
    return true;
  }

  function renameGroup() {
    const name = el('input', {
      class: 'm-input', maxlength: '120', value: dmRecord.name || '',
      'aria-label': 'Group name',
    });
    let layer;
    layer = sheet({
      title: 'Rename group',
      body: name,
      footer: el('div', { class: 'm-actions' },
        el('button', {
          class: 'm-btn m-btn--sm m-btn--primary', type: 'button',
          onClick: async () => {
            if (!name.value.trim()) { toast('Give the group a name.'); return; }
            try {
              await Api.renameDmGroup(id, name.value.trim());
              layer.close();
              if (await updateGroup()) toast('Group renamed.');
            } catch (error) { showError(error); }
          },
        }, 'Save name')),
    });
  }

  function addToGroup() {
    const existing = new Set(dmPeople(dmRecord).map((person) => String(person.id)));
    const candidates = (State.friends || []).filter((friend) => !existing.has(String(friend.id)));
    if (!candidates.length) { toast('There is nobody else to add yet.'); return; }
    let layer;
    const rows = el('div', { class: 'm-list' });
    layer = sheet({
      title: 'Add somebody',
      body: rows,
    });
    rows.replaceChildren(...candidates.map((friend) => el('button', {
      class: 'm-row', type: 'button',
      onClick: async () => {
        try {
          await Api.addDmGroupMember(id, friend.id);
          layer.close();
          if (await updateGroup()) toast(nameOf(friend) + ' joined the group.');
        } catch (error) { showError(error); }
      },
    },
    el('span', { class: 'm-row__lead' }, avatar(friend, { size: 'sm', decorative: true })),
    el('span', { class: 'm-row__body' },
      el('span', { class: 'm-row__title truncate' }, nameOf(friend)),
      el('span', { class: 'm-row__sub truncate' }, '@' + (friend.username || ''))))));
  }

  function openGroupDetails() {
    if (!dmRecord) return;
    const people = dmPeople(dmRecord);
    const allPeople = State.user ? [State.user, ...people] : people;
    const list = el('div', { class: 'm-list' }, allPeople.map((person) => {
      const self = State.user && String(person.id) === String(State.user.id);
      return el('div', { class: 'm-row' },
        el('span', { class: 'm-row__lead' }, avatar(person, { size: 'sm', decorative: true })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title truncate' }, nameOf(person)),
          el('span', { class: 'm-row__sub truncate' }, self ? 'You' : '@' + (person.username || ''))),
        !self ? el('button', {
          class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
          'aria-label': 'Remove ' + nameOf(person) + ' from the group',
          onClick: async () => {
            const yes = await confirm({
              title: 'Remove ' + nameOf(person) + '?',
              text: 'They will no longer see new messages in this group.',
              confirmLabel: 'Remove', danger: true,
            });
            if (!yes) return;
            try {
              await Api.removeDmGroupMember(id, person.id);
              details.close();
              if (await updateGroup()) {
                toast(nameOf(person) + ' was removed.');
                openGroupDetails();
              }
            } catch (error) { showError(error); }
          },
        }, 'Remove') : null);
    }));
    let details;
    details = sheet({
      title: dmName(dmRecord),
      body: el('div', { class: 'm-stack' },
        el('div', { class: 'm-actions' },
          el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => { details.close(); renameGroup(); } }, 'Rename'),
          el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => { details.close(); addToGroup(); } }, 'Add somebody')),
        section('People', list)),
      footer: el('div', { class: 'm-actions' },
        el('button', {
          class: 'm-btn m-btn--sm m-btn--danger', type: 'button',
          onClick: async () => {
            const yes = await confirm({
              title: 'Leave this group?',
              text: 'You will stop receiving new messages here.',
              confirmLabel: 'Leave group', danger: true,
            });
            if (!yes) return;
            try {
              await Api.leaveDmGroup(id);
              details.close();
              toast('You left the group.');
              refreshDms().catch(() => {});
              navigate('/dms');
            } catch (error) { showError(error); }
          },
        }, 'Leave group')),
    });
  }

  async function load() {
    const mine = loadGeneration;
    let dm = State.dms.find((d) => d.id === id) || null;
    let fetched = false;
    if (!dm) {
      try {
        dm = await Api.dm(id);
        fetched = !!dm;
      } catch { dm = null; }
    }
    if (!mounted || mine !== loadGeneration) return;
    if (fetched) State.dms = State.dms.concat([dm]);
    dmRecord = dm;
    peer = dm ? peerOf(dm) : null;
    // The bar is re-set once the peer is known, keeping the module's own shell
    // the only thing that draws it.
    setAppBar(head());
  }

  return {
    head: { lead: 'back', title: 'Conversation' },
    node: conversation.node,
    composer: conversation.composer,
    onMount() {
      if (mounted) return;
      mounted = true;
      loadGeneration += 1;
      conversation.onMount();
      load();
    },
    cleanup() {
      mounted = false;
      loadGeneration += 1;
      conversation.cleanup();
    },
  };
}

export default { renderDms, renderDm };

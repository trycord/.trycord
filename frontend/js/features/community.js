// The community.
//
// One module owns every community surface that is not the settings studio:
// a channel with its conversation, the pins of a channel, and the four access
// pages - members, roles, invites, categories. The settings sections live in
// communitySettings.js and are dispatched to from here by the rest of the URL,
// so /server/:id/settings/appearance and /server/:id/settings answer to one
// renderer without guessing.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { EVENTS, on, joinChannel, leaveChannel } from '../../packages/realtime.js';
import {
  State, refreshServerTree, refreshServerRoles, can, isOwner, serverById, channelById,
} from '../../packages/store.js';
import { path, navigate } from '../../packages/nav.js';
import { head, card, row, blank, fault, fold, hold } from '../ui/page.js';
import { conversationSurface, asMessage, messageRow, copyText } from '../ui/chat.js';
import * as encrypted from '../ui/encrypted.js';
import { memberList } from '../ui/members.js';
import {
  openCategoryDialog, createChannel, renameCategory, deleteCategory,
  categoryMenuItems, reorderCategories, orderAfterDrop, attachDragOrder,
} from '../community/manage.js';
import { communitySettingsSections } from './communitySettings.js';
import { roleDot, roleColourField, memberRoleDot, roleChips } from '../../packages/roles.js';
import { renderVoiceRoom } from '../voice/room.js';
import { errorToast, toast, openDialog } from '../ui/overlays.js';
import { communityIdentity } from '../ui/communityIdentity.js';

function renderSettingsSection(ctx, section) {
  const table = communitySettingsSections();
  let render = table.get(section) || null;
  if (typeof render !== 'function') {
    // The access sections are real pages in their own right; the registry below
    // is how the settings addresses reach the same renderers.
    const access = new Map([
      ['members', () => renderMembers(ctx)],
      ['roles', () => renderRoles(ctx)],
      ['invites', () => renderInvites(ctx)],
      ['categories', () => renderCategories(ctx)],
    ]);
    render = access.get(section);
  }
  if (typeof render !== 'function') {
    return {
      node: fold([
        head({ kicker: 'Community', title: 'Settings' }),
        blank({
          glyph: 'settings',
          title: 'Nothing to read here',
          text: 'The section is not one of the settings the community offers.',
        }),
      ]),
    };
  }
  return render(ctx);
}

// -- the channel conversation -------------------------------------------------

export function renderChannelView(ctx) {
  const serverId = ctx.serverId;
  const channel = ctx.channel || channelById(serverId, ctx.params.channel) || null;
  const channelId = channel ? channel.id : ctx.params.channel;
  const server = serverById(serverId) || State.serverDetail.get(serverId) || { id: serverId, name: 'This community' };
  const isPins = ctx.page.id === 'community.channelPins';

  // The conversation view and the pins view each carry their own header, so the
  // technology between them is one instance: a node appended a second time moves
  // rather than stays, and the earlier holder loses it.
  const channelTitlePrefix = isPins ? 'Pins in #' : (channel && (channel.type === 'voice' || channel.type === 'stage') ? '' : '#');
  const makeHead = () => {
    const room = channel && (channel.type === 'voice' || channel.type === 'stage');
    return head({
      // Which community this is. The channel is where the conversation is, and
      // the community is the place it happens, so the place says its name.
      identity: communityIdentity(server),
      kicker: server.name,
      title: channelTitlePrefix + (channel ? channel.name : 'channel'),
      lede: channel && channel.topic
        ? channel.topic
        : room
          ? 'A room whose audio runs member to member.'
          : (isPins ? 'The messages saved for this channel.' : 'The conversation of this channel.'),
      actions: room ? el('div', { class: 'pagehead-actions' }) : el('div', { class: 'pagehead-actions' },
        isPins
          ? el('a', {
            class: 'btn btn--ghost btn--sm',
            href: path('/server/' + serverId + '/channel/' + channelId),
          }, icon('message', { size: 14 }), 'Back to the channel')
          : can(serverId, 'MANAGE_MESSAGES')
            ? el('a', {
              class: 'btn btn--ghost btn--sm',
              href: path('/server/' + serverId + '/channel/' + channelId + '/pins'),
            }, icon('pin', { size: 14 }), 'Pins')
            : null,
        // Whether this conversation is encrypted, and the way to make it so.
        //
        // The key is **not** published automatically. The server refuses text
        // in a conversation it reports as encrypted, so a client that
        // published a key for every conversation it opened would break the
        // ordinary path for anybody whose encryption could not be set up. It is
        // a decision the reader takes, and the button says what it does.
        encryptionControl(serverId, channelId)),
    });
  };

  // The encryption control for a conversation: the state, and the way to turn
  // it on. Repaints the head when the state changes.
  function encryptionControl(serverId, channelId) {
    const holder = el('span', { class: 'pagehead-actions' });
    const paint = () => {
      const answer = encrypted.knownState(channelId);
      const known = encrypted.isKnown(answer);
      const mark = encrypted.badge(answer);
      const label = mark.getAttribute('title') || 'Encryption';
      const button = el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        'aria-label': 'Encryption: ' + label,
        title: known
          ? label
          : 'The server has not said yet whether this conversation is encrypted.',
        onClick: async () => {
          try {
            await encrypted.turnOn(channelId);
          } catch (error) {
            errorToast(error);
          }
          paint();
        },
      }, icon('lock', { size: 14 }), label);
      holder.replaceChildren(button);
    };
    paint();
    // The state arrives from the server, so the control says so until it
    // does rather than claiming "not encrypted" before it knows.
    encrypted.conversationState(channelId)
      .then(paint)
      .catch(() => { /* the state is unknown, and the badge says that */ });
    return holder;
  }

  if (!channel) {
    return {
      node: fold([
        makeHead(),
        blank({
          glyph: 'hash',
          title: 'No such channel',
          text: 'The link points at a channel that is not here. The list in the column has what is.',
        }),
      ]),
    };
  }

  // A voice or stage channel is a room rather than a thread: no composer, no
  // history, one roster and the way in.
  if (channel.type === 'voice' || channel.type === 'stage') {
    if (isPins) {
      return {
        node: fold([
          makeHead(),
          blank({
            glyph: 'pin',
            title: 'A voice channel has no pins',
            text: 'Messages are where pins live; this room speaks instead.',
          }),
        ]),
      };
    }
    const room = renderVoiceRoom(channel, serverId);
    return {
      node: el('div', { class: 'convo-page' },
        el('div', { class: 'convo-scroll fold fold--tight' }, makeHead(), room.node)),
      cleanup() { room.cleanup(); },
    };
  }

  // The panel beside a channel: who is here, and what this channel is. It is
  // the same roster the members page draws, so a reader who has seen one knows
  // the other.
  const roster = memberList(serverId);
  const inspector = {
    kind: 'channel',
    tabs: [
      {
        id: 'members', label: 'Members', icon: 'users',
        render: () => roster.load().then(() => roster.node),
      },
      {
        id: 'about', label: 'About', icon: 'info',
        render: () => el('div', { class: 'inspector-note' },
          el('p', {}, channel.topic || 'This channel has no topic.'),
          el('p', {}, (channel.type || 'text') + ' channel in ' + server.name + '.')),
      },
    ],
    dispose() { roster.cleanup(); },
  };

  const surface = conversationSurface({
    kind: 'channel',
    scopeId: channelId,
    serverId: serverId,
    composerLabel: 'Message #' + channel.name,
    composerHint: 'Message #' + channel.name,
    canManage: can(serverId, 'MANAGE_MESSAGES'),
    loadOlder: async (anchor) => {
      const page = await Api.messages(channelId, { before: anchor, limit: 40 });
      return { messages: Array.isArray(page) ? page : (page && page.messages) || [] };
    },
    send: (payload) => encrypted.send(channelId, payload, (body) => Api.sendMessage(channelId, body)),
    edit: (messageId, content) => Api.updateMessage(channelId, messageId, { content }),
    del: (messageId) => Api.deleteMessage(channelId, messageId),
    reactTo: (messageId, emoji) => Api.reactChannel(channelId, messageId, emoji),
    unreactFrom: (messageId, emoji) => Api.unreactChannel(channelId, messageId, emoji),
    pin: async (messageId, pinned) => {
      const out = pinned
        ? await Api.pinMessage(serverId, channelId, messageId)
        : await Api.unpinMessage(serverId, channelId, messageId);
      // The row is updated from the server's answer rather than from a
      // realtime event: the gateway does not announce pins, so waiting for one
      // would leave the row saying it is unpinned after it was pinned.
      surface.api.pinned(messageId, pinned);
      if (isPins) open();
      return out;
    },
    threadOf: (messageId) => Api.thread('channel', channelId, messageId),
    upload: (file, onProgress) => encrypted.upload(
      channelId,
      file,
      (plainFile) => Api.uploadAttachment(channelId, plainFile, onProgress),
    ).then((out) => { if (onProgress) onProgress(1); return out; }),
    copyHref: () => path('/server/' + serverId + '/channel/' + channelId),
    emptyHint: { title: 'This channel is quiet', text: 'The first message starts it.' },
  });

  // -- pins -----------------------------------------------------------------
  const pinsHost = el('div', { class: 'rowlist' });

  const pinsPage = el('div', { class: 'convo-page' },
    el('div', { class: 'convo-scroll fold fold--tight' },
      makeHead(),
      pinsHost));
  const page = el('div', { class: 'convo-page' },
    el('div', { class: 'convo-scroll' }, makeHead(), surface.node),
    surface.typing,
    surface.composer.node);
  const host = el('div', { class: 'convo-host' }, page);

  let generation = 0;
  const open = async () => {
    generation += 1;
    const mine = generation;
    if (isPins) {
      try {
        const pins = await Api.listPins(serverId, channelId);
        const rows = (Array.isArray(pins) ? pins : (pins && pins.items) || []).map(asMessage);
        if (mine !== generation) return;
        pinsHost.replaceChildren(...(rows.length ? rows.map((m) => pinRow(m)) : [blank({
          glyph: 'pin',
          title: 'Nothing pinned',
          text: 'Pin a message to keep it at hand.',
        })]));
      } catch (e) {
        if (mine !== generation) return;
        pinsHost.replaceChildren(fold([fault(e, open)]));
      }
      return;
    }

    try {
      const page = await Api.messages(channelId, { limit: 50 });
      if (mine !== generation) return;
      // The rows are opened before they are drawn. An encrypted row carries no
      // text from the server - the server holds none - so it has to be opened
      // here or it is drawn as an empty message.
      const rows = await encrypted.readRows(
        Array.isArray(page) ? page : (page && page.messages) || [], channelId);
      if (mine !== generation) return;
      surface.api.paint(rows.map(asMessage),
        { hasOlder: rows.length >= 50 });
      surface.wireScroller();
      joinChannel(channelId);
    } catch (e) {
      if (mine !== generation) return;
      surface.cleanup();
      host.replaceChildren(fold([
        makeHead(),
        fault(e, () => open()),
      ]));
    }
  };

  // A pin event about another channel says nothing about this one. The event
  // names its channel when it carries one; when it does not, the message id
  // decides, because the surface only knows this channel's messages.
  const isThisChannel = (event) => {
    const id = event.channel_id || event.channelId || event.channel;
    return !id || String(id) === String(channelId);
  };

  const unsubs = [
    // The row is opened before it is shown. An encrypted message arrives as
    // an envelope with no text, and the text is in the envelope - so a row
    // that is drawn as it arrives is an empty bubble.
    on(EVENTS.MESSAGE, async (event) => {
      if (String(event.channel_id || event.channelId) !== String(channelId)) return;
      surface.api.created(await encrypted.readRow(event, channelId));
    }),
    on(EVENTS.MESSAGE_UPDATED, async (event) => {
      if (String(event.channel_id || event.channelId) !== String(channelId)) return;
      surface.api.updated(await encrypted.readRow(event, channelId));
    }),
    on(EVENTS.MESSAGE_DELETED, (event) => {
      if (String(event.channel_id || event.channelId) !== String(channelId)) return;
      surface.api.deleted(event.id);
    }),
    on(EVENTS.MESSAGE_REACTION, (event) => {
      if (String(event.channel_id || event.channelId) !== String(channelId)) return;
      surface.api.reaction(event.id, event.reactions || []);
    }),
    on(EVENTS.MESSAGE_EMBEDS, (event) => {
      if (String(event.channel_id || event.channelId) !== String(channelId)) return;
      surface.api.embeds(event.messageId, event.embeds || []);
    }),
    on(EVENTS.MESSAGE_PINNED, (event) => {
      if (!isThisChannel(event)) return;
      surface.api.pinned(event.id, true);
      if (isPins) open();
    }),
    on(EVENTS.MESSAGE_UNPINNED, (event) => {
      if (!isThisChannel(event)) return;
      surface.api.pinned(event.id, false);
      if (isPins) open();
    }),
  ];

  return {
    node: isPins ? pinsPage : host,
    inspector,
    onMount: open,
    cleanup() {
      generation += 1;
      for (const off of unsubs) off();
      if (!isPins) leaveChannel();
      surface.cleanup();
      roster.cleanup();
    },
  };
}

// The pins of a channel reuse the read-only message row the engine draws.

export function pinRow(m) {
  const node = messageRow(m, { continued: false });
  node.classList.add('msg--standalone');
  return el('article', { class: 'card card--flat card--dashed pin-row' },
    el('div', { class: 'pin-row-main' }, node));
}

// -- the four access pages -----------------------------------------------------

export function renderMembers(ctx) {
  const serverId = ctx.serverId;
  const server = serverById(serverId) || State.serverDetail.get(serverId) || { name: 'Community' };
  const roster = memberList(serverId);

  return {
    node: fold([
      head({
        kicker: server.name,
        title: 'Members',
        lede: 'Everyone here, and who is about.',
        actions: can(serverId, 'MANAGE_ROLES')
          ? el('a', { class: 'btn btn--ghost btn--sm', href: path('/server/' + serverId + '/roles') },
            icon('shield', { size: 14 }), 'Roles')
          : null,
      }),
      card({ label: 'Roster', glyph: 'users', body: roster.node, flush: true }),
    ]),
    onMount: () => roster.load(),
    cleanup() { roster.cleanup(); },
  };
}

// -- roles, invites, categories ------------------------------------------------

export function renderRoles(ctx) {
  const serverId = ctx.serverId;
  const server = serverById(serverId) || { name: 'Community' };
  const body = el('div', { class: 'rowlist' });
  const canManage = can(serverId, 'MANAGE_ROLES') || isOwner(serverId);

  const paint = () => {
    const roles = State.serverRoles.get(serverId) || [];
    if (!roles.length) {
      body.replaceChildren(blank({
        glyph: 'shield',
        title: 'No roles yet',
        text: 'A role is a set of permissions with a name; create one below.',
      }));
      return;
    }
    body.replaceChildren(...roles.map((role) => row({
      lead: roleDot(role),
      title: role.name,
      sub: role.permissions && role.permissions.length
        ? role.permissions.map((permission) => permission).slice(0, 3).join(', ')
        : 'No permissions',
      side: canManage ? el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        'aria-label': 'Edit the ' + role.name + ' role',
        onClick: () => roleEditor(serverId, role, paint),
      }, icon('edit', { size: 14 })) : null,
    })));
  };

  paint();

  return {
    node: fold([
      head({
        kicker: server.name,
        title: 'Roles',
        lede: 'What each role may manage.',
        actions: canManage ? el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          onClick: () => roleEditor(serverId, null, paint),
        }, icon('plus', { size: 14 }), 'New role') : null,
      }),
      card({ label: 'Roles', glyph: 'shield', body, flush: true }),
    ]),
    onMount: async () => {
      if (State.serverRoles.get(serverId)) { paint(); return; }
      try {
        await refreshServerRoles(serverId);
        paint();
      } catch (e) {
        body.replaceChildren(fold([fault(e, null)]));
      }
    },
    cleanup() {},
  };
}

// -- invites --------------------------------------------------------------------

export function renderInvites(ctx) {
  const serverId = ctx.serverId;
  const server = serverById(serverId) || State.serverDetail.get(serverId) || { name: 'Community' };
  const body = el('div', { class: 'rowlist' });
  const canManage = can(serverId, 'MANAGE_INVITES') || isOwner(serverId);

  const paint = (rows) => {
    if (!rows || !rows.length) {
      body.replaceChildren(blank({
        glyph: 'mail',
        title: 'No invites open',
        text: 'Make one; it is a door others can walk through.',
      }));
      return;
    }
    body.replaceChildren(...rows.map((invite) => {
      const code = invite.code || invite.id;
      const link = path('/invite/' + code);
      return row({
        lead: el('span', { class: 'role-dot role-dot--invite' }, icon('mail', { size: 15 })),
        title: (invite.uses !== undefined ? invite.uses : (invite.use_count || 0)) + ' use(s)',
        sub: code,
        side: canManage ? el('span', { class: 'rowtools' },
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            'aria-label': 'Copy the invite link ' + code,
            onClick: () => copyText(link, 'Invite link'),
          }, 'Copy'),
          el('button', {
            class: 'btn btn--danger btn--sm', type: 'button',
            'aria-label': 'Revoke the invite ' + code,
            onClick: async () => {
              try {
                await Api.deleteInvite(serverId, invite.id);
                toast('Invite revoked');
                paint(await Api.invites(serverId));
              } catch (e) { errorToast(e); }
            },
          }, 'Revoke')) : null,
      });
    }));
  };

  return {
    node: fold([
      head({
        kicker: server.name,
        title: 'Invites',
        lede: 'Codes that let someone in.',
        actions: canManage ? el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          onClick: async () => {
            try {
              await Api.createInvite(serverId, {});
              paint(await Api.invites(serverId));
            } catch (e) { errorToast(e); }
          },
        }, icon('plus', { size: 14 }), 'New invite') : null,
      }),
      card({ label: 'Open invites', glyph: 'mail', body, flush: true }),
    ]),
    onMount: async () => {
      try {
        paint(await Api.invites(serverId));
      } catch (e) {
        body.replaceChildren(fold([fault(e, null)]));
      }
    },
    cleanup() {},
  };
}

// -- categories -----------------------------------------------------------------

export function renderCategories(ctx) {
  const serverId = ctx.serverId;
  const server = serverById(serverId) || State.serverDetail.get(serverId) || { name: 'Community' };
  const canManage = can(serverId, 'MANAGE_CHANNELS') || isOwner(serverId);
  const body = el('div', { class: 'rowlist' });

  const read = () => {
    const tree = State.serverTree.get(serverId) || { categories: [], channels: [] };
    const categories = (tree.categories || []).slice()
      .sort((a, b) => (a.position || 0) - (b.position || 0));
    if (!categories.length) {
      body.replaceChildren(blank({
        glyph: 'layers',
        title: 'No categories',
        text: 'Categories group channels; add one to give the column order.',
      }));
      return;
    }
    body.replaceChildren(...categories.map((category) => {
      const count = (tree.channels || []).filter((channel) =>
        channel.category_id === category.id || channel.categoryId === category.id).length;
      const node = row({
        class: 'category-row',
        link: true,
        lead: el('span', { class: 'role-dot' }, icon('layers', { size: 15 })),
        title: category.name,
        sub: count + ' channel' + (count === 1 ? '' : 's'),
        menu: () => categoryMenuItems(serverId, category, {
          canManageChannels: canManage,
          onCreateChannel: () => createChannel(serverId, category.id),
        }),
        side: canManage ? el('span', { class: 'rowtools' },
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            'aria-label': 'Rename the ' + category.name + ' category',
            onClick: (event) => { event.stopPropagation(); renameCategory(serverId, category); },
          }, icon('edit', { size: 14 })),
          el('button', {
            class: 'btn btn--danger btn--sm', type: 'button',
            'aria-label': 'Delete the ' + category.name + ' category',
            onClick: (event) => { event.stopPropagation(); deleteCategory(serverId, category); },
          }, 'Delete')) : null,
      });
      if (canManage) {
        attachDragOrder(node, {
          id: category.id,
          onDrop: (movedId, targetId) => {
            const order = orderAfterDrop(categories, movedId, targetId);
            if (order) reorderCategories(serverId, order);
          },
        });
      }
      return node;
    }));
  };

  read();

  return {
    node: fold([
      head({
        kicker: server.name,
        title: 'Categories',
        lede: 'The order of the column. Drag a category onto another to move it.',
        actions: canManage ? el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          onClick: () => openCategoryDialog(serverId, { onDone: read }),
        }, icon('plus', { size: 14 }), 'New category') : null,
      }),
      card({ label: 'Categories', glyph: 'layers', body, flush: true }),
    ]),
    onMount: async () => {
      try {
        await refreshServerTree(serverId, { force: true });
        read();
      } catch (e) {
        body.replaceChildren(fold([fault(e, null)]));
      }
    },
    cleanup() {},
  };
}

// -- the settings dispatch ------------------------------------------------------
//
// The community settings address (/server/:id/settings and its <section>
// suffixes) resolves here through ctx.rest; the section renderer lives in
// communitySettings.js. A bare community with no channels lands here too, so
// the reader always has somewhere to go next.

export function renderCommunity(ctx) {
  const rest = ctx.rest || [];
  const pageId = ctx.page.id || '';
  // The settings addresses arrive two ways: through the legacy route, whose
  // rest swallows the section, and through the settings route itself, whose
  // rest is empty and whose page id names the section.
  if (rest[0] === 'settings' || pageId === 'community.settings' || pageId.startsWith('community.settings.')) {
    const fromPageId = pageId.startsWith('community.settings.') ? pageId.slice('community.settings.'.length) : '';
    return renderSettingsSection(ctx, rest[1] || fromPageId || 'overview');
  }
  if (rest[0] === 'channels') return renderSettingsSection(ctx, 'channels');

  // The bare community: a lander that routes on. With a channel tree, open it;
  // without one, say what the place has.
  const serverId = ctx.serverId;
  const server = serverById(serverId) || State.serverDetail.get(serverId) || { name: 'Community' };
  const tree = State.serverTree.get(serverId) || { channels: [] };
  const first = (tree.channels || [])[0];
  if (first) {
    navigate('/server/' + serverId + '/channel/' + first.id, { replace: true });
    // The redirect is asynchronous, so the in-between is a real view: the
    // community it is, and the way to the conversation it is becoming.
    return {
      node: fold([
        head({
          kicker: 'Community',
          title: server.name || 'A community',
          lede: 'Opening the first conversation.',
          actions: el('a', {
            class: 'btn btn--default btn--sm',
            href: path('/server/' + serverId + '/channel/' + first.id),
          }, icon('hash', { size: 14 }), 'Open #' + (first.name || 'channel')),
        }),
        hold('Opening the channel'),
      ]),
    };
  }
  return {
    node: fold([
      head({
        kicker: server.name,
        title: 'Nothing is built yet',
        lede: 'This community has no channels; give it some and it opens up.',
        actions: can(serverId, 'MANAGE_CHANNELS') || isOwner(serverId)
          ? el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            onClick: () => navigate('/server/' + serverId + '/settings/channels'),
          }, icon('hash', { size: 14 }), 'Make a channel') : null,
      }),
      blank({
        glyph: 'grid',
        title: 'No channels',
        text: 'The first channel is where every conversation starts.',
      }),
    ]),
  };
}

// -- role editor -----------------------------------------------------------------

function roleEditor(serverId, role, refresh) {
  const name = el('input', {
    class: 'input', type: 'text', value: role ? (role.name || '') : '',
    'aria-label': 'Role name',
    placeholder: 'A name the members will read',
  });
  // The colour of the role. It is a display hint the community chooses, and
  // it is saved with the role through the same call that saves the name.
  const colour = roleColourField({ role });
  const save = async (event) => {
    event.preventDefault();
    if (!name.value.trim()) { name.focus(); return; }
    const chosen = colour.read();
    if (chosen === undefined) {
      // The value in the field is not a colour. The field says so; the save
      // does not go ahead with something the server would refuse.
      return;
    }
    try {
      if (role) await Api.updateRole(serverId, role.id, { name: name.value.trim(), color: chosen });
      else await Api.createRole(serverId, { name: name.value.trim(), color: chosen });
      close();
      await refreshServerRoles(serverId);
      refresh();
    } catch (e) { errorToast(e); }
  };
  const close = () => dialog.close();
  const dialog = openDialog({
    title: role ? 'Edit ' + role.name : 'New role',
    body: el('form', { onSubmit: save, class: 'fold' },
      name,
      colour.node,
      el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Save')),
  });
  name.focus();
}

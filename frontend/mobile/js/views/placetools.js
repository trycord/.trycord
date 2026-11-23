// The community's working screens on the phone.
//
// The roles a place manages, the invitations it hands out, the categories
// that order its channels, the pins a channel keeps, the form that starts a
// new place, the welcome a place asks its new members, and a place that
// lives on another instance. Each screen does the real work through the same
// API the desk uses; what changes is only the shape - a list instead of a
// column, a sheet instead of a dialog.

import {
  el, clear, icon, Api, confirm, toast, failed, hold, failure, emptyState,
  items, when, row, cardOf, fact, wordsSheet, formSheet, consoleScreen,
} from './kit.js';
import { navigate, path } from '../../../packages/nav.js';
import {
  State, nameOf, serverById, refreshServerRoles, refreshServerTree,
} from '../../../packages/store.js';
import { request } from '../../../packages/api.js';
import { can, isOwner } from '../../../packages/store.js';
import { avatar } from '../../../js/ui/primitives.js';

// -- roles --------------------------------------------------------------------

async function roles(host, ctx) {
  const serverId = ctx.serverId;
  const mayManage = can(serverId, 'MANAGE_ROLES') || isOwner(serverId);
  const card = cardOf('Roles', []);
  host.appendChild(card);

  const paint = async () => {
    card.replaceChildren(el('div', { class: 'm-kicker' }, 'Roles'), hold());
    try {
      if (!State.serverRoles.get(serverId)) await refreshServerRoles(serverId);
      const roles = State.serverRoles.get(serverId) || [];
      card.replaceChildren(el('div', { class: 'm-kicker' }, 'Roles'),
        ...(roles.length ? roles.map((role) => row({
          lead: role.color ? el('span', { class: 'm-row__chevron', style: { color: role.color } }, icon('shield', { size: 16 })) : null,
          title: role.name || 'A role',
          sub: (role.permissions && role.permissions.length
            ? role.permissions.slice(0, 3).join(', ')
            : 'No permissions'),
          side: mayManage ? el('button', {
            class: 'm-go m-go--quiet', type: 'button', 'aria-label': 'Edit the role',
            onClick: () => roleEditor(serverId, role, paint),
          }, 'Edit') : null,
        })) : [emptyState('shield', 'No roles yet', 'A role is a set of permissions with a name.')]));

      if (mayManage) {
        card.appendChild(row({
          title: 'New role', lead: el('span', { class: 'm-row__chevron' }, icon('plus', { size: 16 })), chevron: true,
          onClick: () => roleEditor(serverId, null, paint),
        }));
        const ordered = roles.map((role) => role.id);
        card.appendChild(row({
          title: 'Put the roles in order', lead: el('span', { class: 'm-row__chevron' }, icon('list', { size: 16 })), chevron: true,
          onClick: async () => {
            // Highest first is how the server reads the order; the reader
            // types the names top to bottom in the order they should sit.
            const names = await new Promise((done) => wordsSheet({
              title: 'The order',
              note: 'One role name per line, highest first. Roles not named keep their place.',
              fieldLabel: 'The names in order', confirmLabel: 'Save the order', required: false,
            }, done));
            if (!names) return;
            const byName = new Map(roles.map((role) => [String(role.name || '').toLowerCase(), role.id]));
            const wanted = String(names).split('\n').map((line) => line.trim().toLowerCase()).filter(Boolean)
              .map((line) => byName.get(line)).filter(Boolean);
            try {
              await Api.reorderRoles(serverId, wanted.concat(ordered.filter((id) => wanted.indexOf(id) === -1)));
              toast('The order is saved');
              await refreshServerRoles(serverId, { force: true });
              await paint();
            } catch (error) { failed(error); }
          },
        }));
      }
    } catch (error) {
      card.replaceChildren(failure(error, paint));
    }
  };
  await paint();
}

async function roleEditor(serverId, role, onDone) {
  let catalog = [];
  try {
    const answer = await Api.rolePermissions(serverId);
    catalog = Array.isArray(answer) ? answer : (answer && answer.permissions) || [];
  } catch { /* the editor still opens: the name and colour save without it */ }
  const name = el('input', { class: 'm-input', type: 'text', maxlength: '40', value: role ? (role.name || '') : '', 'aria-label': 'The name of the role' });
  const color = el('input', { class: 'm-input', type: 'text', maxlength: '9', value: role ? (role.color || '') : '', placeholder: '#FF4D24', 'aria-label': 'The colour of the role' });
  const boxes = catalog.map((permission) => {
    const names = typeof permission === 'string' ? permission : (permission.name || permission.key || permission.id);
    const box = el('input', { class: 'm-input', type: 'checkbox', 'aria-label': 'May ' + names });
    box.value = names;
    box.checked = !!(role && role.permissions && role.permissions.indexOf(names) !== -1);
    return box;
  });
  const layer = formSheet({ title: role ? 'Change ' + (role.name || 'the role') : 'A new role', confirmLabel: role ? 'Save the role' : 'Make the role' }, [
    ['Name', name],
    ['Colour', color],
  ], async () => {
    const permissions = boxes.filter((box) => box.checked).map((box) => box.value);
    const body = { name: name.value.trim(), permissions };
    if (color.value.trim()) body.color = color.value.trim();
    if (role) await Api.updateRole(serverId, role.id, body);
    else await Api.createRole(serverId, body);
    toast(role ? 'Saved' : 'The role is made');
    await refreshServerRoles(serverId, { force: true });
    await onDone();
  });
  if (catalog.length) {
    const list = el('div', { class: 'm-card' }, boxes.map((box, i) => row({
      title: 'May ' + (typeof catalog[i] === 'string' ? catalog[i] : (catalog[i].name || catalog[i].key || catalog[i].id)),
      lead: box,
    })));
    list.insertBefore(el('div', { class: 'm-kicker' }, 'What the role may manage'), list.firstChild);
    layer.body.appendChild(list);
  }
  if (role) {
    layer.body.appendChild(el('button', {
      class: 'm-go m-go--danger m-go--block', type: 'button',
      onClick: async () => {
        if (!(await confirm({ title: 'Delete the role?', text: 'The people holding it lose what it allowed.', confirmLabel: 'Delete', danger: true }))) return;
        try {
          await Api.deleteRole(serverId, role.id);
          toast('The role is gone');
          await refreshServerRoles(serverId, { force: true });
          await onDone();
        } catch (error) { failed(error); }
      },
    }, 'Delete the role'));
  }
}

// -- invites ------------------------------------------------------------------

async function invites(host, ctx) {
  const serverId = ctx.serverId;
  const mayManage = can(serverId, 'MANAGE_SERVER') || isOwner(serverId);
  const card = cardOf('Invitations', []);
  host.appendChild(card);

  const paint = async () => {
    card.replaceChildren(el('div', { class: 'm-kicker' }, 'Invitations'), hold());
    try {
      const rows = items(await Api.invites(serverId));
      card.replaceChildren(el('div', { class: 'm-kicker' }, 'Invitations'),
        ...(rows.length ? rows.map((invite) => row({
          lead: el('span', { class: 'm-row__chevron' }, icon('mail', { size: 16 })),
          title: invite.code || 'An invitation',
          sub: (invite.uses != null ? 'used ' + invite.uses : 'never used')
            + (invite.maxUses != null ? ' of ' + invite.maxUses : '')
            + (invite.expiresAt ? ' · ends ' + when(invite.expiresAt) : ''),
          side: mayManage ? el('button', {
            class: 'm-go m-go--quiet', type: 'button', 'aria-label': 'Delete the invitation',
            onClick: async () => {
              if (!(await confirm({ title: 'Delete this invitation?', text: 'Nobody new comes in by it.', confirmLabel: 'Delete', danger: true }))) return;
              try {
                await Api.deleteInvite(serverId, invite.id);
                toast('The invitation is gone');
                await paint();
              } catch (error) { failed(error); }
            },
          }, 'Delete') : null,
        })) : [emptyState('mail', 'No invitations', 'An invitation brings somebody in with a word.')]));

      if (mayManage) {
        card.appendChild(row({
          title: 'New invitation', lead: el('span', { class: 'm-row__chevron' }, icon('plus', { size: 16 })), chevron: true,
          onClick: async () => {
            const body = await new Promise((done) => formSheet({
              title: 'A new invitation', confirmLabel: 'Make it',
            }, [
              ['Uses before it ends (empty = no limit)', el('input', { class: 'm-input', type: 'number', min: '0', 'aria-label': 'Maximum uses' })],
              ['Hours before it ends (empty = never)', el('input', { class: 'm-input', type: 'number', min: '0', 'aria-label': 'Hours until expiry' })],
            ], done));
            const uses = body.querySelector('input[type=number]');
            const maxUses = Number(uses && uses.value) || undefined;
            const create = {};
            if (maxUses) create.maxUses = maxUses;
            const out = await Api.createInvite(serverId, create);
            toast('Invitation ' + (out.code || 'made'));
            await paint();
          },
        }));
      }
    } catch (error) {
      card.replaceChildren(failure(error, paint));
    }
  };
  await paint();
}

// -- categories ---------------------------------------------------------------

async function categories(host, ctx) {
  const serverId = ctx.serverId;
  const mayManage = can(serverId, 'MANAGE_CHANNELS') || isOwner(serverId);
  const card = cardOf('Categories', []);
  host.appendChild(card);

  const paint = async () => {
    card.replaceChildren(el('div', { class: 'm-kicker' }, 'Categories'), hold());
    try {
      const answer = await Api.categories(serverId);
      const rows = items(answer.categories || answer);
      card.replaceChildren(el('div', { class: 'm-kicker' }, 'Categories'),
        ...(rows.length ? rows.map((category) => row({
          lead: el('span', { class: 'm-row__chevron' }, icon('folder', { size: 16 })),
          title: category.name || 'A category',
          sub: (category.channels ? category.channels.length + ' channels' : ''),
          side: mayManage ? el('button', {
            class: 'm-go m-go--quiet', type: 'button', 'aria-label': 'Delete the category',
            onClick: async () => {
              if (!(await confirm({ title: 'Delete ' + (category.name || 'this category') + '?', text: 'Its channels stay; they become uncategorised.', confirmLabel: 'Delete', danger: true }))) return;
              try {
                await Api.deleteCategory(serverId, category.id);
                toast('The category is gone');
                await paint();
              } catch (error) { failed(error); }
            },
          }, 'Delete') : null,
        })) : [emptyState('folder', 'No categories', 'A category holds a group of channels together.')]));

      if (mayManage) {
        card.appendChild(row({
          title: 'New category', lead: el('span', { class: 'm-row__chevron' }, icon('plus', { size: 16 })), chevron: true,
          onClick: async () => {
            const name = await new Promise((done) => wordsSheet({
              title: 'A new category', fieldLabel: 'Name', confirmLabel: 'Make it',
              placeholder: 'Text channels', required: false,
            }, done));
            if (!name) return;
            await Api.createCategory(serverId, { name });
            toast('The category is made');
            await paint();
          },
        }));
      }
    } catch (error) {
      card.replaceChildren(failure(error, paint));
    }
  };
  await paint();
}

// -- the pins of one channel --------------------------------------------------

async function channelPins(host, ctx) {
  const serverId = ctx.serverId;
  const channelId = ctx.params.channel || (ctx.channel && ctx.channel.id);
  if (!channelId) {
    host.appendChild(emptyState('pin', 'No channel named', 'The address has to name the channel whose pins it wants.'));
    return;
  }
  const card = cardOf('Pinned', []);
  host.appendChild(card);

  const paint = async () => {
    card.replaceChildren(el('div', { class: 'm-kicker' }, 'Pinned'), hold());
    try {
      const answer = await Api.listPins(serverId, channelId);
      const rows = items(answer);
      card.replaceChildren(el('div', { class: 'm-kicker' }, 'Pinned'),
        ...(rows.length ? rows.map((message) => row({
          title: message.authorDisplay || message.authorName || 'A message',
          sub: String(message.content || '').slice(0, 120) || (message.attachments && message.attachments.length ? 'A file' : '—'),
          side: el('button', {
            class: 'm-go m-go--quiet', type: 'button', 'aria-label': 'Unpin the message',
            onClick: async () => {
              if (!(await confirm({ title: 'Unpin this message?', text: 'It stays in the conversation; it leaves the pin board.', confirmLabel: 'Unpin' }))) return;
              try {
                await Api.unpinMessage(serverId, channelId, message.id);
                toast('Unpinned');
                await paint();
              } catch (error) { failed(error); }
            },
          }, 'Unpin'),
        })) : [emptyState('pin', 'Nothing pinned', 'Pin a message to keep it at hand.')]));
    } catch (error) {
      card.replaceChildren(failure(error, paint));
    }
  };
  await paint();
}

// -- a new community ----------------------------------------------------------

async function newCommunity(host) {
  const name = el('input', { class: 'm-input', type: 'text', maxlength: '60', placeholder: 'Ember Works', 'aria-label': 'The name of the community' });
  const description = el('textarea', { class: 'm-area', rows: '3', maxlength: '400', placeholder: 'What is this place for?', 'aria-label': 'The description' });
  const isPublic = el('input', { class: 'm-input', type: 'checkbox', 'aria-label': 'Public' });
  const discoverable = el('input', { class: 'm-input', type: 'checkbox', 'aria-label': 'Discoverable' });
  const go = el('button', { class: 'm-go m-go--block', type: 'button' }, 'Create community');
  go.addEventListener('click', async () => {
    if (!name.value.trim()) {
      toast('Give your community a name.', { type: 'danger' });
      return;
    }
    go.disabled = true;
    try {
      const server = await Api.createServer({
        name: name.value.trim(),
        description: description.value,
        isPublic: isPublic.checked,
        isDiscoverable: discoverable.checked,
      });
      toast('Community created.', { type: 'success' });
      navigate(server && server.id ? path('/server/' + server.id) : path('/communities'));
    } catch (error) {
      failed(error);
      go.disabled = false;
    }
  });
  host.appendChild(cardOf('Start somewhere', [
    el('p', { class: 'm-sheet__note' }, 'A home for your people.'),
    el('div', { class: 'm-card' },
      el('div', { class: 'm-kicker' }, 'The basics'),
      el('label', { class: 'm-field' }, 'Name', name),
      el('label', { class: 'm-field' }, 'Description', description),
      row({ title: 'Public — anyone with the link may read the preview', lead: isPublic }),
      row({ title: 'Discoverable — appears in Discover searches', lead: discoverable })),
    go,
  ]));
}

// -- the welcome a place asks its new members ---------------------------------

async function onboarding(host, ctx) {
  const serverId = ctx.serverId;
  host.appendChild(hold());
  try {
    const [answer, own] = await Promise.all([
      request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/onboarding/preview'),
      request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/onboarding/me').catch(() => null),
    ]);
    const preview = (answer && answer.onboarding) || {};
    clear(host);
    if (!preview.enabled || !(preview.questions || []).length) {
      host.appendChild(emptyState('home', 'There is no welcome here',
        'This community has not set one up, so there is nothing to see. Carry on as you are.'));
      return;
    }
    const choices = {};
    for (const entry of (own && own.answers) || []) {
      for (const optionId of entry.optionIds || []) choices[entry.questionId + ':' + optionId] = true;
    }
    host.appendChild(cardOf(serverById(serverId) ? (serverById(serverId).name || 'The place') : 'The place', [
      el('p', { class: 'm-sheet__note' }, 'Answer what you like to; the answers decide which roles are given and which channels open. You can come back and change your mind.'),
    ]));
    for (const question of preview.questions || []) {
      const qCard = cardOf(question.prompt || 'A question', [
        question.required ? null : el('p', { class: 'm-sheet__note' }, 'You may skip this one.'),
      ]);
      const boxes = (question.options || []).map((option) => {
        const box = el('input', { class: 'm-input', type: question.multi ? 'checkbox' : 'radio', name: 'q' + question.id, 'aria-label': option.label || option.prompt || '' });
        box.value = option.id;
        box.checked = !!choices[question.id + ':' + option.id];
        return box;
      });
      (question.options || []).forEach((option, i) => {
        qCard.appendChild(row({ title: option.label || option.prompt || 'An answer', sub: option.description || '', lead: boxes[i] }));
      });
      qCard.appendChild(el('button', {
        class: 'm-go m-go--block', type: 'button',
        onClick: async () => {
          const picked = boxes.filter((box) => box.checked).map((box) => box.value);
          if (question.required && !picked.length) {
            toast('This one has to be answered.', { type: 'danger' });
            return;
          }
          try {
            await request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/onboarding/answers',
              { body: { answers: [{ questionId: question.id, optionIds: picked }] } });
            toast('Answered');
            await refreshServerTree(serverId).catch(() => {});
          } catch (error) { failed(error); }
        },
      }, 'Answer'));
      host.appendChild(qCard);
    }
  } catch (error) {
    clear(host);
    host.appendChild(failure(error, () => { host.replaceChildren(); return onboarding(host, ctx); }));
  }
}

// -- a place on another instance ----------------------------------------------

async function federatedCommunity(host, ctx) {
  const instanceId = ctx.params.instanceId;
  const communityId = ctx.params.communityId;
  host.appendChild(hold());
  try {
    const peers = items(await Api.continuumFederated());
    const entry = peers.find((peer) => String(peer.communityId || peer.id) === String(communityId)
      && String(peer.instanceId || peer.origin_instance_id || '') === String(instanceId)) || {};
    clear(host);
    const joined = !!(entry.joined || entry.member);
    host.appendChild(cardOf(entry.name || 'A place across the Continuum', [
      fact('Instance', instanceId),
      fact('Community', communityId),
      fact('Membership', joined ? 'Joined' : 'Not joined'),
      entry.description ? el('p', { class: 'm-sheet__note' }, String(entry.description).slice(0, 300)) : null,
    ]));
    host.appendChild(el('button', {
      class: 'm-go m-go--block', type: 'button',
      onClick: async () => {
        try {
          if (joined) await Api.continuumLeaveCommunity(instanceId, communityId);
          else await Api.continuumJoinCommunity(instanceId, communityId);
          toast(joined ? 'Left' : 'Joined');
          host.replaceChildren();
          await federatedCommunity(host, ctx);
        } catch (error) { failed(error); }
      },
    }, joined ? 'Leave this place' : 'Join this place'));

    const relayCard = cardOf('What is relayed', []);
    host.appendChild(relayCard);
    try {
      const messages = items(await Api.continuumRelayedMessages(instanceId, communityId, 40));
      relayCard.appendChild(...(messages.length ? messages.map((message) => row({
        title: message.authorName || message.author || 'A reader',
        sub: String(message.content || '').slice(0, 120),
        side: el('span', { class: 'm-row__note' }, when(message.createdAt || message.created_at)),
      })) : [emptyState('globe', 'Nothing relayed yet', 'Messages from this place appear here as the Continuum carries them.')]));
    } catch (error) {
      relayCard.appendChild(failure(error, () => { host.replaceChildren(); return federatedCommunity(host, ctx); }));
    }
  } catch (error) {
    clear(host);
    host.appendChild(failure(error, () => { host.replaceChildren(); return federatedCommunity(host, ctx); }));
  }
}

const SECTIONS = {
  'community.roles': roles,
  'community.invites': invites,
  'community.categories': categories,
  'community.channelPins': channelPins,
  'community.new': newCommunity,
  'community.onboarding': onboarding,
  'federated.community': federatedCommunity,
};

// The community's settings studio reuses the roles, invitations and category
// screens as sections of its own: they are the same work with the same gate.
export const rolesSection = roles;
export const invitesSection = invites;
export const categoriesSection = categories;

export function renderPlacetools(ctx) {
  return consoleScreen(ctx.page.id, SECTIONS);
}

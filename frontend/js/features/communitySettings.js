// The community settings studio.
//
// A console rather than a page: a rail of the sections on the left, the
// section itself on the right. The sections are the ones the registry
// promises, and the four access sections - members, roles, invites and
// categories - are the community's own pages, drawn by community.js and
// composed here, so there is one implementation of each rather than two that
// disagree about what a role is.
//
// What the console can reach is written down once, in the shared catalogue
// (packages/communitySettings.js): the sections, the routes that configure a
// community, and the calls the platform's API module does not carry. That
// catalogue is what the parity check reads, so a route the server offers and
// the console does not reach is a route nobody can reach.
//
// The rail is the console's own navigation, and it is the place where the
// unsaved-changes warning happens: leaving a section with something typed
// into it asks first.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { path, navigate } from '../../packages/nav.js';
import { confirmDialog, errorToast, toast } from '../ui/overlays.js';
import { head, card, row, blank, fault, fold, facts } from '../ui/page.js';
import { bannerNode, channelIcon, serverMark } from '../ui/primitives.js';
import { copyText } from '../ui/clipboard.js';
import {
  State, nameOf, refreshServer, refreshServerTree, refreshServerMembers, isOwner,
  can, isMuted, serverById,
} from '../../packages/store.js';
import { communitySectionGroups } from '../../packages/communitySettings.js';
import {
  openChannelDialog, renameChannel, deleteChannel, channelMenuItems, toggleMute,
  reorderChannels, orderAfterDrop, attachDragOrder,
} from '../community/manage.js';
import { overviewSection } from './communitySettings/overview.js';
import { moderationSection } from './communitySettings/moderation.js';
import { rulesSection } from './communitySettings/rules.js';
import { integrationsSection } from './communitySettings/integrations.js';
import { voiceSection } from './communitySettings/voice.js';
import { onboardingSection } from './communitySettings/onboarding.js';
import {
  membersSection, rolesSection, invitesSection, categoriesSection,
} from './communitySettings/access.js';

// -- the rail -----------------------------------------------------------------

// The rail of sections.
//
// A section with unsaved changes is left only after the reader is asked: the
// link is an ordinary link, so it can be opened in a new tab and copied, but
// a click that would throw the typing away is a click that asks first.
function studioRail(serverId, activeId, isDirty) {
  const rail = el('nav', { class: 'studionav', 'aria-label': 'Community settings' });
  for (const group of communitySectionGroups()) {
    rail.appendChild(el('p', { class: 'studionav-group' }, group.group));
    for (const section of group.items) {
      const href = path('/server/' + serverId + '/settings/' + section.id);
      const link = el('a', {
        class: 'studionav-link' + (section.id === activeId ? ' studionav-link--active' : ''),
        href,
        'aria-current': section.id === activeId ? 'page' : null,
      },
      icon(section.icon, { size: 16 }),
      el('span', { class: 'studionav-label' }, section.label));
      link.addEventListener('click', (event) => {
        if (section.id === activeId) return;
        if (!isDirty || !isDirty()) return;
        event.preventDefault();
        confirmDialog({
          title: 'Leave with unsaved changes?',
          body: 'What you have typed here has not been saved. Leaving now loses it.',
          confirmLabel: 'Leave anyway',
          danger: true,
        }).then((yes) => { if (yes) navigate('/server/' + serverId + '/settings/' + section.id); });
      });
      rail.appendChild(link);
    }
  }
  return rail;
}

// A section, inside the console.
//
// The section keeps its own lifecycle - { node, onMount, cleanup } - and may
// also say whether it is dirty. The rail is drawn around it, never instead of
// it.
function studioSection(ctx, sectionId, build) {
  const view = build(ctx);
  const node = view && view.node ? view.node : view;
  const framed = el('div', { class: 'studio' },
    studioRail(ctx.serverId, sectionId, view && view.isDirty),
    el('div', { class: 'studio-stage' }, node));
  return {
    node: framed,
    onMount: view && view.onMount,
    cleanup: view && view.cleanup,
    isDirty: view && view.isDirty,
  };
}

// -- appearance -------------------------------------------------------------------

function imageField(server, kind, label) {
  const url = kind === 'icon' ? (server.iconUrl || server.icon_url) : (server.bannerUrl || server.banner_url);
  const preview = kind === 'icon'
    ? serverMark(server, { size: 'md' })
    : (url ? bannerNode(url, 'settings-banner') : null);
  const file = el('input', {
    type: 'file', class: 'visually-hidden', tabindex: '-1',
    accept: 'image/png,image/jpeg,image/webp,image/gif',
    'aria-label': 'Upload a new ' + label,
  });
  const note = el('p', { class: 'form-error', role: 'status' });

  // The picker is opened by the button, and the file that comes back is what
  // changes the picture. Without this the control opened a file dialog and
  // then did nothing with the answer.
  file.addEventListener('change', async () => {
    const chosen = file.files && file.files[0];
    if (!chosen) return;
    note.textContent = 'Uploading…';
    try {
      await Api.setServerImage(server.id, kind, chosen);
      note.textContent = 'Updated';
      toast(label + ' updated');
      await refreshServer(server.id);
    } catch (error) {
      note.textContent = (error && error.message) || 'The upload failed.';
      errorToast(error);
    } finally {
      file.value = '';
    }
  });

  return el('div', { class: 'settings-image-field' },
    preview,
    el('div', { class: 'settings-image-tools' },
      el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        onClick: () => file.click(),
      }, icon('upload', { size: 14 }), 'Replace ' + label.toLowerCase()),
      url ? el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        onClick: async () => {
          try {
            await Api.removeServerImage(server.id, kind);
            note.textContent = 'Removed';
            await refreshServer(server.id);
          } catch (e) { errorToast(e); }
        },
      }, 'Remove') : null,
      note),
    file);
}

function appearanceSection(ctx) {
  const serverId = ctx.serverId;
  const server = serverById(serverId) || State.serverDetail.get(serverId) || {};

  return {
    node: fold([
      head({
        kicker: 'Community',
        title: 'Appearance',
        lede: 'What this community shows the world.',
        actions: null,
      }),
      card({
        label: 'House', glyph: 'image',
        body: fold([imageField(server, 'icon', 'Icon'), imageField(server, 'banner', 'Banner')]),
      }),
    ]),
    onMount: null,
  };
}

// -- channels -------------------------------------------------------------------

// The channel list. Every action here is the shared one from
// community/manage.js - the same dialogs the tree uses, the same deletes, the
// same reordering - so the two surfaces cannot disagree about what a channel
// is or what creating one does.

// A copy of a channel.
//
// The copy carries the settings over - the topic, the type, the category and
// the slow mode - and it carries no messages, so it is a fresh channel with
// the shape of the old one.
async function copyChannel(serverId, channel, done) {
  try {
    const copy = await Api.duplicateChannel(serverId, channel.id);
    toast('The server answered: ' + copy.name + ' was created.');
    await refreshServerTree(serverId, { force: true });
    if (done) done();
  } catch (error) {
    errorToast(error);
  }
}

function channelsSection(ctx) {
  const serverId = ctx.serverId;
  const body = el('div', { class: 'rowlist' });
  const canManage = can(serverId, 'MANAGE_CHANNELS') || isOwner(serverId);

  const read = () => {
    const tree = State.serverTree.get(serverId) || { categories: [], channels: [] };
    const channels = tree.channels || [];
    if (!channels.length) {
      body.replaceChildren(blank({
        glyph: 'hash',
        title: 'No channels yet',
        text: 'A conversation starts in a channel; name one below.',
      }));
      return;
    }
    const categories = new Map((tree.categories || []).map((category) => [category.id, category.name]));
    body.replaceChildren(...channels.map((channel) => {
      const categoryName = channel.category_id ? (categories.get(channel.category_id) || '') : '';
      const node = row({
        class: 'channel-row',
        link: true,
        lead: channelIcon(channel, 16),
        title: channel.name,
        sub: (channel.type === 'voice' ? 'Voice' : 'Text')
          + (categoryName ? ' · ' + categoryName : ' · No category'),
        onClick: () => navigate('/server/' + serverId + '/channel/' + channel.id),
        menu: () => channelMenuItems(serverId, channel, {
          canManageChannels: canManage,
          muted: isMuted(channel.id),
          onCopyTopic: () => copyText(channel.topic || '', 'Topic copied.'),
          onToggleMute: () => toggleMute(channel),
        }),
        side: canManage ? el('span', { class: 'rowtools' },
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            'aria-label': 'Edit ' + channel.name,
            onClick: (event) => { event.stopPropagation(); renameChannel(serverId, channel); },
          }, icon('edit', { size: 14 })),
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            'aria-label': 'Copy ' + channel.name,
            onClick: (event) => {
              event.stopPropagation();
              copyChannel(serverId, channel, read);
            },
          }, 'Copy'),
          el('button', {
            class: 'btn btn--danger btn--sm', type: 'button',
            'aria-label': 'Delete ' + channel.name,
            onClick: (event) => { event.stopPropagation(); deleteChannel(serverId, channel); },
          }, 'Delete')) : null,
      });
      if (canManage) {
        attachDragOrder(node, {
          id: channel.id,
          onDrop: (movedId, targetId) => {
            const order = orderAfterDrop(channels, movedId, targetId);
            if (order) reorderChannels(serverId, order);
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
        kicker: 'Community',
        title: 'Channels',
        lede: 'Where conversations happen, in order. Drag a channel onto another to move it.',
        actions: el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          onClick: () => openChannelDialog(serverId, { onDone: read }),
        }, icon('plus', { size: 14 }), 'New channel'),
      }),
      card({ label: 'Channels', glyph: 'hash', body, flush: true }),
    ]),
    onMount: async () => {
      try {
        await refreshServerTree(serverId, { force: true });
        read();
      } catch (e) {
        body.replaceChildren(fold([fault(e, null)]));
      }
    },
  };
}

// -- ownership ---------------------------------------------------------------------

function ownershipSection(ctx) {
  const serverId = ctx.serverId;
  const owner = isOwner(serverId);
  if (!owner) return null;
  const pick = el('select', { class: 'input', 'aria-label': 'Who takes over' },
    el('option', { value: '' }, 'Choose a member'));

  const refreshTransfer = () => refreshServerMembers(serverId).then((page) => {
    const items = (page && page.items) || [];
    pick.replaceChildren(
      el('option', { value: '' }, 'Choose a member'),
      ...items
        .filter((m) => String(m.id) !== String((State.user || {}).id))
        .map((m) => el('option', { value: m.id }, m.nickname || nameOf(m))));
  }).catch(() => {});

  return {
    node: fold([
      head({
        kicker: 'Community',
        title: 'Ownership',
        lede: 'Who holds it, and where it ends.',
        actions: null,
      }),
      card({
        label: 'Hand it over', glyph: 'crown',
        body: fold([pick,
          el('button', {
            class: 'btn btn--primary btn--sm', type: 'button',
            onClick: async () => {
              const userId = pick.value;
              if (!userId) { pick.focus(); return; }
              const yes = await confirmDialog({
                title: 'Transfer ownership?',
                body: 'After this, everything an owner can do, another person can do. It is final.',
                confirmLabel: 'Transfer',
                danger: true,
              });
              if (!yes) return;
              try {
                await Api.transferServer(serverId, userId);
                toast('Ownership transferred');
              } catch (e) { errorToast(e); }
            },
          }, 'Transfer ownership')]),
      }),
      card({
        label: 'Delete the community', glyph: 'trash', dashed: true,
        body: fold([
          el('p', { class: 'lede' },
            'Everything here goes - channels, messages, roles. It is not reversible.'),
          el('button', {
            class: 'btn btn--danger btn--sm', type: 'button',
            onClick: async () => {
              const yes = await confirmDialog({
                title: 'Delete this community?',
                body: 'The conversations, the members, the settings. It does not come back.',
                confirmLabel: 'Delete community',
                danger: true,
              });
              if (!yes) return;
              try {
                await Api.deleteServer(serverId);
                navigate('/home');
              } catch (e) { errorToast(e); }
            },
          }, 'Delete community'),
        ]),
      }),
    ]),
    onMount: refreshTransfer,
  };
}

// -- analytics -----------------------------------------------------------------------

function analyticsSection(ctx) {
  const serverId = ctx.serverId;
  const body = el('div', { class: 'anticipation-line' });

  return {
    node: fold([
      head({
        kicker: 'Community',
        title: 'Analytics',
        lede: 'What happened here, in numbers the server could measure.',
        actions: null,
      }),
      card({ label: 'Facts', glyph: 'chart', body, flush: true }),
    ]),
    onMount: async () => {
      try {
        const report = await Api.analytics(serverId);
        const totals = (report && (report.totals || report)) || {};
        const labels = {
          messages: 'messages sent',
          members: 'people around',
          joined: 'joined',
          left: 'left',
          reactions: 'reactions given',
          threads: 'threads started',
          pins: 'pins made',
        };
        const cells = Object.entries(totals).slice(0, 6).map(([field, value]) => ({
          value: String(value === undefined || value === null ? '—' : value),
          label: labels[field] || field,
        }));
        body.replaceChildren(cells.length
          ? facts(cells)
          : blank({ glyph: 'chart', title: 'No numbers yet', text: 'Activity shows up once there is any.' }));
      } catch (e) {
        body.replaceChildren(fold([fault(e, null)]));
      }
    },
  };
}

// -- the registry -----------------------------------------------------------------------

// The sections the console offers.
//
// Each one is drawn inside the rail, and each one is a page of its own: the
// address /server/:id/settings/<section> opens it directly.
export function communitySettingsSections() {
  const registry = new Map([
    ['overview', overviewSection],
    ['appearance', appearanceSection],
    ['channels', channelsSection],
    ['categories', categoriesSection],
    ['members', membersSection],
    ['roles', rolesSection],
    ['invites', invitesSection],
    ['moderation', moderationSection],
    ['rules', rulesSection],
    ['voice', voiceSection],
    ['onboarding', onboardingSection],
    ['ownership', ownershipSection],
    ['analytics', analyticsSection],
    ['integrations', integrationsSection],
  ]);

  // The ownership section needs someone signed in and holding the community;
  // without the key it answers with nothing rather than an unusable page.
  const original = registry.get('ownership');
  registry.set('ownership', (ctx) => {
    const owned = original(ctx);
    if (!owned) {
      return {
        node: fold([
          head({
            kicker: 'Community',
            title: 'Ownership',
            lede: 'Only the owner can move a community on.',
            actions: null,
          }),
          blank({
            glyph: 'crown',
            title: 'You do not hold this community',
            text: 'Asking the owner is the only way in.',
          }),
        ]),
      };
    }
    return owned;
  });

  // Everything is drawn inside the console, so the rail is around each section
  // rather than beside one of them.
  const wrapped = new Map();
  for (const [id, build] of registry.entries()) {
    wrapped.set(id, (ctx) => studioSection(ctx, id, build));
  }
  return wrapped;
}

// The community settings studio.
//
// These are the sections only the setting surface needs: identity, appearance,
// channels, moderation, ownership, analytics and integrations. The access
// sections (members, roles, invites, categories) are real pages of their own in
// community.js and are reached from that module's registry, so one set of
// renderers exists rather than two that disagree.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import {
  State, nameOf, refreshServer, refreshServerTree, refreshServerMembers, isOwner, serverById,
} from '../../packages/store.js';
import { navigate } from '../../packages/nav.js';
import { switchControl, fieldRow, bannerNode, channelIcon, serverMark } from '../ui/primitives.js';
import { head, card, row, blank, fault, fold, facts, hold } from '../ui/page.js';
import { errorToast, toast, confirmDialog, openDialog } from '../ui/overlays.js';

const isOwnerOf = isOwner;

// -- identity -------------------------------------------------------------------

function overviewSection(ctx) {
  const serverId = ctx.serverId;
  const server = serverById(serverId) || State.serverDetail.get(serverId)
    || { name: 'Community', description: '' };

  const name = el('input', {
    class: 'input', type: 'text', value: server.name || '',
    'aria-label': 'Community name',
  });
  const description = el('input', {
    class: 'input', type: 'text', value: server.description || '',
    'aria-label': 'What the community is about',
    placeholder: 'One sentence on what this place is for',
  });
  const guidelines = el('textarea', {
    class: 'input', rows: '4', 'aria-label': 'Community guidelines',
    placeholder: 'The rules people agree to here',
  });
  const status = el('p', { class: 'form-error', role: 'status' });

  // This instance has no endpoint that reads the community settings back, so
  // the guidelines cannot be shown as they stand. An empty field that is saved
  // unchanged would therefore wipe the rules the community has, so the field
  // is only written once it has actually been edited.
  let guidelinesEdited = false;
  guidelines.addEventListener('input', () => { guidelinesEdited = true; });

  const saveIdentity = async () => {
    try {
      await Api.updateServer(serverId, { name: name.value.trim(), description: description.value.trim() });
      status.textContent = 'Identity saved';
    } catch (e) { errorToast(e); }
  };
  const saveGuidelines = async () => {
    if (!guidelinesEdited) {
      status.textContent = 'The guidelines are unchanged, so nothing was written.';
      return;
    }
    try {
      await Api.updateServerSettings(serverId, { guidelines: guidelines.value });
      guidelinesEdited = false;
      status.textContent = 'Guidelines saved';
    } catch (e) { errorToast(e); }
  };

  return {
    node: fold([
      head({
        kicker: 'Community',
        title: 'Community settings',
        lede: 'The face and the welcome of this place.',
        actions: null,
      }),
      card({
        label: 'Identity', glyph: 'grid',
        body: fold([
          name,
          description,
          el('button', {
            class: 'btn btn--primary btn--sm', type: 'button', onClick: saveIdentity,
          }, 'Save identity'),
        ]),
      }),
      card({
        label: 'Guidelines', glyph: 'book',
        body: fold([
          guidelines,
          el('p', { class: 'form-note' },
            'This instance cannot show the rules as they stand, so write them out again to change them.'),
          el('button', {
            class: 'btn btn--default btn--sm', type: 'button', onClick: saveGuidelines,
          }, 'Save guidelines'),
          status,
        ]),
      }),
    ]),
    onMount: null,
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
  const publicToggle = switchControl(!!server.is_public, async (on) => {
    try {
      await Api.updateServer(serverId, { isPublic: on });
      toast(on ? 'The community is public' : 'The community is private again');
    } catch (e) { errorToast(e); }
  }, 'Public');
  const discoverToggle = switchControl(!!server.is_discoverable, async (on) => {
    try {
      await Api.updateServer(serverId, { isDiscoverable: on });
      toast(on ? 'Listed on Discover' : 'Removed from Discover');
    } catch (e) { errorToast(e); }
  }, 'Discoverable');

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
      card({
        label: 'Reach', glyph: 'compass',
        rows: [
          fieldRow('Public', 'Anyone with the address can read it.', publicToggle),
          fieldRow('Discoverable', 'Listed on Discover.', discoverToggle),
        ],
      }),
    ]),
    onMount: null,
  };
}

// -- channels -------------------------------------------------------------------

function channelDialog(serverId, channel, onDone) {
  const name = el('input', {
    class: 'input', type: 'text', value: channel ? (channel.name || '') : '',
    'aria-label': 'Channel name',
    placeholder: channel ? '' : 'general',
  });
  const typeSelect = el('select', { class: 'input', 'aria-label': 'Channel type' },
    el('option', { value: 'text' }, 'Text'),
    el('option', { value: 'voice' }, 'Voice'));
  typeSelect.value = channel ? (channel.type || 'text') : 'text';
  const save = async (event) => {
    event.preventDefault();
    if (!name.value.trim()) { name.focus(); return; }
    try {
      if (channel) await Api.updateChannel(serverId, channel.id, { name: name.value.trim() });
      else await Api.createChannel(serverId, { name: name.value.trim(), type: typeSelect.value });
      dialog.close();
      await refreshServerTree(serverId, { force: true });
      onDone();
    } catch (e) { errorToast(e); }
  };
  const dialog = openDialog({
    title: channel ? 'Rename the channel' : 'New channel',
    body: el('form', { class: 'fold', onSubmit: save },
      name,
      channel ? null : typeSelect,
      el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Save')),
  });
  name.focus();
}

function channelsSection(ctx) {
  const serverId = ctx.serverId;
  const body = el('div', { class: 'rowlist' });

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
    body.replaceChildren(...channels.map((channel) => row({
      lead: channelIcon(channel, 16),
      title: channel.name,
      sub: channel.type === 'voice' ? 'Voice' : 'Text',
      side: el('span', { class: 'rowtools' },
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'Rename ' + channel.name,
          onClick: () => channelDialog(serverId, channel, read),
        }, icon('edit', { size: 14 })),
        el('button', {
          class: 'btn btn--danger btn--sm', type: 'button',
          'aria-label': 'Delete ' + channel.name,
          onClick: async () => {
            const yes = await confirmDialog({
              title: 'Delete ' + channel.name + '?',
              body: 'The messages in it are gone with it; this cannot be undone.',
              confirmLabel: 'Delete channel',
              danger: true,
            });
            if (!yes) return;
            try {
              await Api.deleteChannel(serverId, channel.id);
              await refreshServerTree(serverId, { force: true });
              read();
            } catch (e) { errorToast(e); }
          },
        }, 'Delete')),
    })));
  };
  read();

  return {
    node: fold([
      head({
        kicker: 'Community',
        title: 'Channels',
        lede: 'Where conversations happen, in order.',
        actions: el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          onClick: () => channelDialog(serverId, null, read),
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

// -- moderation -------------------------------------------------------------------

function paintBans(serverId, body) {
  return Api.bans(serverId).then((bans) => {
    const rows = Array.isArray(bans) ? bans : (bans && bans.items) || [];
    if (!rows.length) {
      body.replaceChildren(blank({
        glyph: 'ban',
        title: 'Nobody is banned',
        text: 'Lifting starts at banning; nobody to lift yet.',
      }));
      return;
    }
    body.replaceChildren(...rows.map((ban) => row({
      lead: el('span', { class: 'role-dot' }, icon('ban', { size: 15 })),
      title: ban.displayName || ban.username || 'Someone',
      sub: ban.reason || 'No reason given',
      side: el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        'aria-label': 'Lift the ban on ' + (ban.username || 'this person'),
        onClick: async () => {
          try {
            await Api.unbanMember(serverId, ban.userId || ban.user_id || ban.id);
            paintBans(serverId, body);
          } catch (e) { errorToast(e); }
        },
      }, 'Lift'),
    })));
  });
}

function moderationSection(ctx) {
  const serverId = ctx.serverId;
  const body = el('div', { class: 'rowlist' });

  return {
    node: fold([
      head({
        kicker: 'Community',
        title: 'Moderation',
        lede: 'Who is kept out, and why.',
        actions: null,
      }),
      card({ label: 'Bans', glyph: 'ban', body, flush: true }),
    ]),
    onMount: async () => {
      try {
        await paintBans(serverId, body);
      } catch (e) {
        body.replaceChildren(fold([fault(e, null)]));
      }
    },
  };
}

// -- ownership ---------------------------------------------------------------------

function ownershipSection(ctx) {
  const serverId = ctx.serverId;
  const owner = isOwnerOf(serverId);
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

// -- integrations ---------------------------------------------------------------------

function integrationsSection(ctx) {
  const serverId = ctx.serverId;
  const body = el('div', { class: 'rowlist' });

  const paint = (hooks) => {
    if (!(hooks || []).length) {
      body.replaceChildren(blank({
        glyph: 'rocket',
        title: 'No webhooks',
        text: 'A webhook is an address another program can post messages through.',
      }));
      return;
    }
    body.replaceChildren(...hooks.map((hook) => row({
      lead: el('span', { class: 'role-dot' }, icon('zap', { size: 15 })),
      title: hook.name || 'Webhook',
      sub: hook.channel ? '#' + hook.channel.name : hook.channelId || '',
      side: el('button', {
        class: 'btn btn--danger btn--sm', type: 'button',
        'aria-label': 'Delete the webhook ' + (hook.name || ''),
        onClick: async () => {
          try {
            await Api.deleteWebhook(serverId, hook.id);
            load();
          } catch (e) { errorToast(e); }
        },
      }, 'Delete'),
    })));
  };

  const load = async () => {
    try {
      const res = await Api.webhooks(serverId);
      paint(res.webhooks || []);
    } catch (e) {
      body.replaceChildren(fold([fault(e, null)]));
    }
  };

  return {
    node: fold([
      head({
        kicker: 'Community',
        title: 'Integrations',
        lede: 'How other software talks to this place.',
        actions: el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          onClick: async () => {
            try {
              await Api.createWebhook(serverId, { name: 'New webhook' });
              load();
            } catch (e) { errorToast(e); }
          },
        }, icon('plus', { size: 14 }), 'New webhook'),
      }),
      card({ label: 'Webhooks', glyph: 'rocket', body, flush: true }),
    ]),
    onMount: load,
  };
}

// -- the registry -----------------------------------------------------------------------

export function communitySettingsSections() {
  const registry = new Map([
    ['overview', overviewSection],
    ['appearance', appearanceSection],
    ['channels', channelsSection],
    ['moderation', moderationSection],
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
  return registry;
}

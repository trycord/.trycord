// The community's settings studio on the phone.
//
// Fourteen addresses the desk keeps behind one rail; the phone answers each
// with its own screen. The gates are the desk's own rule: what a reader may
// do is what the server lets them do, and the screen is built around that.
// The roles, invitations and category screens are the ones the place's tools
// already carry; the rest is the studio's own work - identity, pictures,
// channels, members, moderation, rules, voice, ownership, counts, and the
// webhooks an outside thing speaks through.

import {
  el, clear, icon, Api, confirm, toast, failed, hold, failure, emptyState,
  items, when, statusWord, row, cardOf, fact, wordsSheet, formSheet, consoleScreen,
  describeValue,
} from './kit.js';
import { navigate, path } from '../../../packages/nav.js';
import { nameOf, refreshServerEmojis, refreshServerTree, serverById } from '../../../packages/store.js';
import { can, isOwner } from '../../../packages/store.js';
import { communityApi } from '../../../packages/communitySettings.js';
import { rolesSection, invitesSection, categoriesSection } from './placetools.js';
import { avatar } from '../../../js/ui/primitives.js';
import { sheet, closeSheet } from '../ui.js';

// -- the index ----------------------------------------------------------------

async function index(host, ctx) {
  const serverId = ctx.serverId;
  const server = serverById(serverId) || {};
  const manage = can(serverId, 'MANAGE_SERVER') || isOwner(serverId);
  if (!manage) {
    host.appendChild(emptyState('settings', 'Not your settings',
      'Only the people who run this place read its settings.'));
    return;
  }
  host.appendChild(cardOf(server.name || 'The place', [
    fact('Members', server.member_count != null ? server.member_count : (server.memberCount != null ? server.memberCount : '—')),
    fact('Channels', server.channel_count != null ? server.channel_count : (server.channelCount != null ? server.channelCount : '—')),
  ]));
  host.appendChild(cardOf('The sections', [
    row({ title: 'Overview', lead: el('span', { class: 'm-row__chevron' }, icon('home', { size: 16 })), chevron: true, onClick: () => navigate(path('/server/' + serverId + '/settings/overview')) }),
    row({ title: 'Appearance', lead: el('span', { class: 'm-row__chevron' }, icon('image', { size: 16 })), chevron: true, onClick: () => navigate(path('/server/' + serverId + '/settings/appearance')) }),
    row({ title: 'Emojis', lead: el('span', { class: 'm-row__chevron' }, icon('smile', { size: 16 })), chevron: true, onClick: () => navigate(path('/server/' + serverId + '/settings/emojis')) }),
    row({ title: 'Channels', lead: el('span', { class: 'm-row__chevron' }, icon('hash', { size: 16 })), chevron: true, onClick: () => navigate(path('/server/' + serverId + '/settings/channels')) }),
    row({ title: 'Categories', lead: el('span', { class: 'm-row__chevron' }, icon('folder', { size: 16 })), chevron: true, onClick: () => navigate(path('/server/' + serverId + '/settings/categories')) }),
    row({ title: 'Members', lead: el('span', { class: 'm-row__chevron' }, icon('users', { size: 16 })), chevron: true, onClick: () => navigate(path('/server/' + serverId + '/settings/members')) }),
    row({ title: 'Roles', lead: el('span', { class: 'm-row__chevron' }, icon('shield', { size: 16 })), chevron: true, onClick: () => navigate(path('/server/' + serverId + '/settings/roles')) }),
    row({ title: 'Invitations', lead: el('span', { class: 'm-row__chevron' }, icon('mail', { size: 16 })), chevron: true, onClick: () => navigate(path('/server/' + serverId + '/settings/invites')) }),
    row({ title: 'Moderation', lead: el('span', { class: 'm-row__chevron' }, icon('gavel', { size: 16 })), chevron: true, onClick: () => navigate(path('/server/' + serverId + '/settings/moderation')) }),
    row({ title: 'Rules', lead: el('span', { class: 'm-row__chevron' }, icon('book', { size: 16 })), chevron: true, onClick: () => navigate(path('/server/' + serverId + '/settings/rules')) }),
    row({ title: 'Voice', lead: el('span', { class: 'm-row__chevron' }, icon('mic', { size: 16 })), chevron: true, onClick: () => navigate(path('/server/' + serverId + '/settings/voice')) }),
    row({ title: 'Analytics', lead: el('span', { class: 'm-row__chevron' }, icon('activity', { size: 16 })), chevron: true, onClick: () => navigate(path('/server/' + serverId + '/settings/analytics')) }),
    row({ title: 'Integrations', lead: el('span', { class: 'm-row__chevron' }, icon('plug', { size: 16 })), chevron: true, onClick: () => navigate(path('/server/' + serverId + '/settings/integrations')) }),
    row({ title: 'Ownership', lead: el('span', { class: 'm-row__chevron' }, icon('key', { size: 16 })), chevron: true, onClick: () => navigate(path('/server/' + serverId + '/settings/ownership')) }),
  ]));
}

// -- overview -----------------------------------------------------------------

async function overview(host, ctx) {
  const serverId = ctx.serverId;
  host.appendChild(hold());
  try {
    const server = await Api.server(serverId);
    clear(host);
    host.appendChild(cardOf('The place', [
      fact('Name', server.name),
      fact('Description', server.description || '—'),
      fact('Members', server.member_count != null ? server.member_count : '—'),
      fact('Made', when(server.created_at || server.createdAt)),
      fact('Address', server.slug ? '/' + server.slug : '—'),
    ]));
    const edit = () => formSheet({ title: 'The words of the place', confirmLabel: 'Save' }, [
      ['Name', el('input', { class: 'm-input', type: 'text', maxlength: '60', value: server.name || '', 'aria-label': 'Name' })],
      ['Description', el('textarea', { class: 'm-area', rows: '3', maxlength: '400', 'aria-label': 'Description' }, server.description || '')],
    ], async () => {
      const box = document.querySelectorAll('.m-sheet .m-input, .m-sheet .m-area');
      await Api.updateServer(serverId, { name: box[0].value.trim(), description: box[1].value });
      toast('Saved');
      host.replaceChildren();
      await overview(host, ctx);
    });
    host.appendChild(cardOf('What you can change', [
      row({ title: 'Name and description', lead: el('span', { class: 'm-row__chevron' }, icon('edit', { size: 16 })), chevron: true, onClick: edit }),
    ]));
    try {
      const read = await communityApi.readSettings(serverId);
      host.appendChild(cardOf('Guidelines', [
        el('p', { class: 'm-sheet__note' }, (read && read.guidelines) || 'None written yet.'),
        row({
          title: 'Write the guidelines', lead: el('span', { class: 'm-row__chevron' }, icon('book', { size: 16 })), chevron: true,
          onClick: async () => {
            const words = await new Promise((done) => wordsSheet({
              title: 'The guidelines', fieldLabel: 'What members agree to', confirmLabel: 'Save',
              placeholder: (read && read.guidelines) || 'Be kind. Read the room.', required: false,
            }, done));
            await Api.updateServerSettings(serverId, { guidelines: words });
            toast('Saved');
            host.replaceChildren();
            await overview(host, ctx);
          },
        }),
      ]));
    } catch { /* guidelines need a newer server; the rest of the page stands */ }
  } catch (error) {
    clear(host);
    host.appendChild(failure(error, () => { host.replaceChildren(); return overview(host, ctx); }));
  }
}

// -- appearance ---------------------------------------------------------------

async function appearance(host, ctx) {
  const serverId = ctx.serverId;
  const mayManage = can(serverId, 'MANAGE_SERVER') || isOwner(serverId);
  host.appendChild(hold());
  try {
    const server = await Api.server(serverId);
    clear(host);
    const face = el('div', { class: 'm-card' },
      el('div', { class: 'm-kicker' }, 'The face of the place'),
      el('div', { class: 'm-profile__actions', style: { justifyContent: 'flex-start' } },
        avatar(server, { size: 'lg' })));
    host.appendChild(face);
    if (mayManage) {
      host.appendChild(cardOf('The pictures', [
        row({
          title: 'Change the icon', lead: el('span', { class: 'm-row__chevron' }, icon('image', { size: 16 })), chevron: true,
          onClick: () => pictureSheet(serverId, 'icon'),
        }),
        row({
          title: 'Change the banner', lead: el('span', { class: 'm-row__chevron' }, icon('image', { size: 16 })), chevron: true,
          onClick: () => pictureSheet(serverId, 'banner'),
        }),
        row({
          title: 'Remove the icon', chevron: true,
          onClick: async () => {
            if (!(await confirm({ title: 'Remove the icon?', confirmLabel: 'Remove' }))) return;
            try {
              await Api.removeServerImage(serverId, 'icon');
              toast('Removed');
              host.replaceChildren();
              await appearance(host, ctx);
            } catch (error) { failed(error); }
          },
        }),
      ]));
    }
  } catch (error) {
    clear(host);
    host.appendChild(failure(error, () => { host.replaceChildren(); return appearance(host, ctx); }));
  }
}

function pictureSheet(serverId, kind) {
  const input = el('input', { class: 'm-input', type: 'file', accept: 'image/*', 'aria-label': 'The picture' });
  const go = el('button', { class: 'm-go m-go--block', type: 'button' }, 'Save');
  go.addEventListener('click', async () => {
    const file = input.files && input.files[0];
    if (!file) {
      toast('Choose a picture first.', { type: 'danger' });
      return;
    }
    go.disabled = true;
    try {
      await Api.setServerImage(serverId, kind, file);
      toast('Saved');
      closeSheet();
    } catch (error) {
      failed(error);
      go.disabled = false;
    }
  });
  const layer = sheet({ title: kind === 'icon' ? 'The icon' : 'The banner' });
  layer.body.appendChild(input);
  layer.body.appendChild(go);
}

// -- emojis -------------------------------------------------------------------

const EMOJI_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

async function emojis(host, ctx) {
  const serverId = ctx.serverId;
  const mayManage = can(serverId, 'MANAGE_SERVER') || isOwner(serverId);
  const card = cardOf('The community\'s emojis', []);
  host.appendChild(card);

  const paint = async () => {
    card.replaceChildren(el('div', { class: 'm-row' }, el('span', { class: 'm-row__note' }, 'Loading the emojis…')));
    try {
      const list = await refreshServerEmojis(serverId, { force: true }) || [];
      card.replaceChildren(el('div', { class: 'm-kicker' }, 'The community\'s emojis'),
        ...(list.length ? list.map((emoji) => row({
          lead: el('img', { src: emoji.url, alt: ':' + emoji.name + ':', style: { width: '22px', height: '22px' }, loading: 'lazy' }),
          title: ':' + emoji.name + ':',
          sub: when(emoji.createdAt || emoji.created_at),
          side: mayManage ? el('button', {
            class: 'm-go m-go--quiet', type: 'button', 'aria-label': 'Delete the emoji',
            onClick: async () => {
              if (!(await confirm({ title: 'Delete :' + emoji.name + ':?', text: 'Words already typed keep the name; it renders as the name only.', confirmLabel: 'Delete', danger: true }))) return;
              try {
                await Api.deleteEmoji(serverId, emoji.id);
                toast('The emoji is gone');
                await paint();
              } catch (error) { failed(error); }
            },
          }, 'Delete') : null,
        })) : [emptyState('smile', 'No emojis yet', 'A name and a picture: type :name: in a message and the picture appears.')]));

      if (mayManage) {
        const name = el('input', { class: 'm-input', type: 'text', maxlength: '30', placeholder: 'sparkle', 'aria-label': 'The name, as it will be typed between colons' });
        const file = el('input', { class: 'm-input', type: 'file', accept: EMOJI_ACCEPT, 'aria-label': 'The picture' });
        const go = el('button', { class: 'm-go m-go--block', type: 'button' }, 'Name it and keep it');
        go.addEventListener('click', async () => {
          const picked = file.files && file.files[0];
          if (!name.value.trim() || !picked) {
            toast('The emoji needs a name and a picture.', { type: 'danger' });
            return;
          }
          go.disabled = true;
          try {
            await Api.createEmoji(serverId, picked, name.value.trim());
            toast(':' + name.value.trim() + ': now belongs to this community.', { type: 'success' });
            name.value = '';
            file.value = '';
            go.disabled = false;
            await paint();
          } catch (error) {
            failed(error);
            go.disabled = false;
          }
        });
        card.appendChild(el('div', { class: 'm-card' },
          el('div', { class: 'm-kicker' }, 'Make one'),
          el('label', { class: 'm-field' }, 'Name', name),
          el('label', { class: 'm-field' }, 'Picture', file),
          go));
      }
    } catch (error) {
      card.replaceChildren(failure(error, () => { card.replaceChildren(); return paint(); }));
    }
  };
  await paint();
}

// -- channels -----------------------------------------------------------------

async function channels(host, ctx) {
  const serverId = ctx.serverId;
  const mayManage = can(serverId, 'MANAGE_CHANNELS') || isOwner(serverId);
  const card = cardOf('Channels', []);
  host.appendChild(card);

  const paint = async () => {
    card.replaceChildren(el('div', { class: 'm-kicker' }, 'Channels'), hold());
    try {
      await refreshServerTree(serverId);
      const answer = await Api.channels(serverId);
      const rows = items(answer.channels || answer);
      card.replaceChildren(el('div', { class: 'm-kicker' }, 'Channels'),
        ...(rows.length ? rows.map((channel) => row({
          lead: el('span', { class: 'm-row__chevron' }, icon(channel.type === 'voice' ? 'mic' : 'hash', { size: 16 })),
          title: (channel.type === 'voice' ? '' : '#') + (channel.name || ''),
          sub: (channel.topic || '') + (channel.slow_mode ? ' · slow ' + channel.slow_mode + 's' : ''),
          side: mayManage ? el('button', {
            class: 'm-go m-go--quiet', type: 'button', 'aria-label': 'Change the channel',
            onClick: () => channelEditor(serverId, channel, paint),
          }, 'Change') : null,
        })) : [emptyState('hash', 'No channels', 'A place starts with a channel.')]));

      if (mayManage) {
        card.appendChild(row({
          title: 'New channel', lead: el('span', { class: 'm-row__chevron' }, icon('plus', { size: 16 })), chevron: true,
          onClick: () => channelEditor(serverId, null, paint),
        }));
      }
    } catch (error) {
      card.replaceChildren(failure(error, paint));
    }
  };
  await paint();
}

async function channelEditor(serverId, channel, onDone) {
  const isVoice = channel && channel.type === 'voice';
  const name = el('input', { class: 'm-input', type: 'text', maxlength: '60', value: channel ? (channel.name || '') : '', placeholder: isVoice ? 'The quiet room' : 'general', 'aria-label': 'The name of the channel' });
  const topic = el('input', { class: 'm-input', type: 'text', maxlength: '200', value: channel ? (channel.topic || '') : '', 'aria-label': 'What the channel is for' });
  const slow = el('input', { class: 'm-input', type: 'number', min: '0', value: channel && channel.slow_mode ? String(channel.slow_mode) : '0', 'aria-label': 'Seconds between messages' });
  const controls = [['Name', name]];
  if (!isVoice) controls.push(['Topic', topic], ['Slow mode (seconds, 0 = off)', slow]);
  const layer = formSheet({
    title: channel ? 'Change ' + (channel.name || 'the channel') : 'A new channel',
    confirmLabel: channel ? 'Save' : 'Make it',
  }, controls, async () => {
    const body = { name: name.value.trim() };
    if (!isVoice) {
      body.topic = topic.value;
      body.slowMode = Number(slow.value || 0);
    }
    if (channel) await Api.updateChannel(serverId, channel.id, body);
    else await Api.createChannel(serverId, Object.assign(body, { type: 'text' }));
    toast(channel ? 'Saved' : 'The channel is made');
    await refreshServerTree(serverId).catch(() => {});
    await onDone();
  });
  if (channel) {
    layer.body.appendChild(el('button', {
      class: 'm-go m-go--danger m-go--block', type: 'button',
      onClick: async () => {
        if (!(await confirm({ title: 'Delete #' + (channel.name || 'this channel') + '?', text: 'Its words go with it. This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
        try {
          await Api.deleteChannel(serverId, channel.id);
          toast('The channel is gone');
          await refreshServerTree(serverId).catch(() => {});
          await onDone();
        } catch (error) { failed(error); }
      },
    }, 'Delete the channel'));
  }
}

// -- members ------------------------------------------------------------------

async function members(host, ctx) {
  const serverId = ctx.serverId;
  const mayManage = can(serverId, 'BAN_MEMBERS') || can(serverId, 'KICK_MEMBERS')
    || can(serverId, 'MANAGE_SERVER') || isOwner(serverId);
  const search = el('input', { class: 'm-input', type: 'search', placeholder: 'Find a member', 'aria-label': 'Find a member' });
  const card = cardOf('Members', []);
  host.append(search, card);

  const paint = async (query) => {
    card.replaceChildren(hold());
    try {
      const answer = await Api.serverMembers(serverId, { limit: '100' });
      let rows = items(answer.members || answer);
      if (query) {
        const q = query.toLowerCase();
        rows = rows.filter((member) => String(nameOf(member) || member.username || '').toLowerCase().indexOf(q) !== -1);
      }
      card.replaceChildren(el('div', { class: 'm-kicker' }, 'Members'),
        ...(rows.length ? rows.map((member) => row({
          lead: avatar(member, { size: 'sm' }),
          title: nameOf(member) || member.username || 'A member',
          sub: '@' + (member.username || '') + (member.nickname ? ' · called ' + member.nickname : ''),
          chevron: true,
          onClick: () => memberSheet(serverId, member, () => paint(query)),
        })) : [emptyState('users', query ? 'Nobody by that name' : 'No members', query ? 'Try another spelling.' : 'The people of this place appear here.')]));
    } catch (error) {
      card.replaceChildren(failure(error, () => paint(query)));
    }
  };

  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => paint(search.value.trim()), 250);
  });
  await paint('');
}

async function memberSheet(serverId, member, onDone) {
  const mayManage = can(serverId, 'BAN_MEMBERS') || can(serverId, 'KICK_MEMBERS') || isOwner(serverId);
  const mayRoles = can(serverId, 'MANAGE_ROLES') || isOwner(serverId);
  const acts = [];
  if (mayManage) {
    acts.push(row({
      title: 'Give them a different name here', chevron: true,
      onClick: async () => {
        const nickname = await new Promise((done) => wordsSheet({
          title: 'Their name in this place', fieldLabel: 'Nickname', confirmLabel: 'Save',
          placeholder: 'Empty clears it', required: false,
        }, done));
        try {
          await Api.setNickname(serverId, member.id, nickname);
          toast('Saved');
          await onDone();
        } catch (error) { failed(error); }
      },
    }));
    acts.push(row({
      title: 'Time out for an hour', lead: el('span', { class: 'm-row__chevron' }, icon('clock', { size: 16 })), chevron: true,
      onClick: async () => {
        const reason = await new Promise((done) => wordsSheet({
          title: 'A time out', confirmLabel: 'Apply it', danger: true,
          placeholder: 'Why, in the words a reviewer reads',
        }, done));
        await Api.timeoutMember(serverId, member.id, 60, reason);
        toast('Timed out');
        await onDone();
      },
    }));
    acts.push(row({
      title: 'Lift any time out', chevron: true,
      onClick: async () => {
        await Api.timeoutMember(serverId, member.id, 0);
        toast('The time out is lifted');
        await onDone();
      },
    }));
    acts.push(row({
      title: 'Remove from this place', lead: el('span', { class: 'm-row__chevron' }, icon('log-out', { size: 16 })), chevron: true,
      onClick: async () => {
        const reason = await new Promise((done) => wordsSheet({
          title: 'Remove ' + (nameOf(member) || 'this member') + '?', confirmLabel: 'Remove', danger: true,
          placeholder: 'Why, in the words a reviewer reads',
        }, done));
        await Api.kickMember(serverId, member.id, reason);
        toast('Removed');
        await onDone();
      },
    }));
    acts.push(row({
      title: 'Ban from this place', danger: true, lead: el('span', { class: 'm-row__chevron' }, icon('ban', { size: 16 })), chevron: true,
      onClick: async () => {
        const reason = await new Promise((done) => wordsSheet({
          title: 'Ban ' + (nameOf(member) || 'this member') + '?', confirmLabel: 'Ban', danger: true,
          placeholder: 'Why, in the words a reviewer reads',
        }, done));
        await Api.banMember(serverId, member.id, reason);
        toast('Banned');
        await onDone();
      },
    }));
  }
  if (mayRoles) {
    acts.push(row({
      title: 'Give or take a role', lead: el('span', { class: 'm-row__chevron' }, icon('shield', { size: 16 })), chevron: true,
      onClick: async () => {
        try {
          const roles = await Api.roles(serverId);
          const list = items(roles.roles || roles);
          if (!list.length) {
            toast('This place has no roles yet.', { type: 'danger' });
            return;
          }
          const picked = await new Promise((done) => formSheet({
            title: 'Roles of ' + (nameOf(member) || 'the member'), confirmLabel: 'Save the roles',
          }, [
            ['The roles', el('select', { class: 'm-input', 'aria-label': 'The role' },
              list.map((role) => el('option', { value: role.id }, role.name || 'A role')))],
            ['Give or take', el('select', { class: 'm-input', 'aria-label': 'Give or take' },
              [el('option', { value: 'give' }, 'Give the role'), el('option', { value: 'take' }, 'Take the role')])],
          ], done));
          const picks = picked.querySelectorAll('select');
          const roleId = picks[0].value;
          const give = picks[1].value === 'give';
          if (give) await Api.assignRole(serverId, roleId, member.id);
          else await Api.unassignRole(serverId, roleId, member.id);
          toast(give ? 'The role is given' : 'The role is taken');
          await onDone();
        } catch (error) { failed(error); }
      },
    }));
  }
  const layer = formSheet({ title: nameOf(member) || member.username || 'A member', note: '@' + (member.username || ''), confirmLabel: 'Done' }, [], async () => {});
  for (const act of acts) layer.body.appendChild(act);
}

// -- moderation ---------------------------------------------------------------

async function moderation(host, ctx) {
  const serverId = ctx.serverId;
  const card = cardOf('The bans', []);
  const queue = cardOf('The report queue', []);
  host.append(card, queue);

  const paintBans = async () => {
    card.replaceChildren(el('div', { class: 'm-kicker' }, 'The bans'), hold());
    try {
      const rows = items(await Api.bans(serverId));
      card.replaceChildren(el('div', { class: 'm-kicker' }, 'The bans'),
        ...(rows.length ? rows.map((ban) => row({
          lead: el('span', { class: 'm-row__chevron' }, icon('ban', { size: 16 })),
          title: ban.username || ban.user_name || nameOf(ban) || 'An account',
          sub: (ban.reason || '') + (ban.created_at ? ' · ' + when(ban.created_at) : ''),
          side: el('button', {
            class: 'm-go m-go--quiet', type: 'button', 'aria-label': 'Lift the ban',
            onClick: async () => {
              const reason = await new Promise((done) => wordsSheet({
                title: 'Lift the ban?', fieldLabel: 'The words the decision carries', confirmLabel: 'Lift',
                placeholder: 'Why the ban is lifted', required: false,
              }, done));
              await Api.unbanMember(serverId, ban.userId || ban.user_id || ban.id, reason);
              toast('The ban is lifted');
              await paintBans();
            },
          }, 'Lift'),
        })) : [emptyState('ban', 'Nobody banned', 'A ban keeps an account out of this place.')]));
    } catch (error) {
      card.replaceChildren(failure(error, paintBans));
    }
  };

  const paintQueue = async () => {
    queue.replaceChildren(el('div', { class: 'm-kicker' }, 'The report queue'), hold());
    try {
      const rows = items(await Api.moderationReports(serverId, { limit: '50' }));
      queue.replaceChildren(el('div', { class: 'm-kicker' }, 'The report queue'),
        ...(rows.length ? rows.map((report) => row({
          lead: el('span', { class: 'm-row__chevron' }, icon('flag', { size: 16 })),
          title: report.reason || 'A report',
          sub: statusWord(report.targetType || report.target_type) + (report.createdAt ? ' · ' + when(report.createdAt) : ''),
          side: el('span', { class: 'm-row__note' }, statusWord(report.status)),
        })) : [emptyState('flag', 'No reports', 'A report a member files in this place arrives here.')]));
    } catch (error) {
      queue.replaceChildren(el('div', { class: 'm-kicker' }, 'The report queue'), failure(error, paintQueue));
    }
  };

  await Promise.all([paintBans(), paintQueue()]);
}

// -- rules --------------------------------------------------------------------

async function rules(host, ctx) {
  const serverId = ctx.serverId;
  const mayManage = can(serverId, 'MANAGE_CHANNELS') || isOwner(serverId);
  const slowCard = cardOf('Slow mode', []);
  const wordsCard = cardOf('Words that are not welcome', []);
  host.append(slowCard, wordsCard);

  try {
    const answer = await Api.channels(serverId);
    const rows = items(answer.channels || answer).filter((channel) => channel.type === 'text');
    slowCard.replaceChildren(el('div', { class: 'm-kicker' }, 'Slow mode'),
      ...(rows.length ? rows.map((channel) => row({
        title: '#' + (channel.name || ''),
        sub: channel.slow_mode ? 'A message every ' + channel.slow_mode + 's' : 'No hold',
        side: mayManage ? el('button', {
          class: 'm-go m-go--quiet', type: 'button',
          onClick: () => formSheet({ title: '#' + (channel.name || ''), confirmLabel: 'Save' }, [
            ['Seconds between messages (0 = off)', el('input', {
              class: 'm-input', type: 'number', min: '0', value: String(channel.slow_mode || 0), 'aria-label': 'Seconds',
            })],
          ], async () => {
            const pick = document.querySelector('.m-sheet input[type=number]');
            await Api.updateChannel(serverId, channel.id, { slowMode: Number(pick.value || 0) });
            toast('Saved');
            host.replaceChildren();
            await rules(host, ctx);
          }),
        }, 'Set') : null,
      })) : [emptyState('hash', 'No text channels', 'Slow mode is a channel\'s rule, so it needs a channel.')]));
  } catch (error) {
    slowCard.replaceChildren(failure(error, () => { host.replaceChildren(); return rules(host, ctx); }));
  }

  const paintWords = async () => {
    try {
      const rows = items(await Api.blockedTerms(serverId));
      wordsCard.replaceChildren(el('div', { class: 'm-kicker' }, 'Words that are not welcome'),
        ...(rows.length ? rows.map((term) => row({
          title: term.word || term.term || 'A word',
          sub: when(term.createdAt || term.created_at),
          side: mayManage ? el('button', {
            class: 'm-go m-go--quiet', type: 'button', 'aria-label': 'Remove the word',
            onClick: async () => {
              try {
                await Api.removeBlockedTerm(serverId, term.id);
                toast('The word is allowed again');
                await paintWords();
              } catch (error) { failed(error); }
            },
          }, 'Remove') : null,
        })) : [emptyState('book', 'No blocked words', 'A word on this list is refused when it is typed.')]));

      if (mayManage) {
        wordsCard.appendChild(row({
          title: 'Add a word', lead: el('span', { class: 'm-row__chevron' }, icon('plus', { size: 16 })), chevron: true,
          onClick: async () => {
            const word = await new Promise((done) => wordsSheet({
              title: 'A word that is not welcome', fieldLabel: 'The word', confirmLabel: 'Block it',
              placeholder: 'The exact word or phrase',
            }, done));
            await Api.addBlockedTerm(serverId, word);
            toast('Blocked');
            await paintWords();
          },
        }));
      }
    } catch (error) {
      wordsCard.replaceChildren(el('div', { class: 'm-kicker' }, 'Words that are not welcome'), failure(error, paintWords));
    }
  };
  await paintWords();
}

// -- voice --------------------------------------------------------------------

async function voice(host) {
  host.appendChild(hold());
  try {
    const capabilities = await Api.voiceCapabilities();
    clear(host);
    const entries = capabilities && (capabilities.capabilities || capabilities.features) || capabilities;
    host.appendChild(cardOf('What the voice server does', Array.isArray(entries) || typeof entries !== 'object'
      ? [fact('State', 'Answering')]
      : Object.entries(entries).map(([key, value]) => fact(key, describeValue(value)))));
  } catch (error) {
    clear(host);
    host.appendChild(failure(error, () => { host.replaceChildren(); return voice(host); }));
  }
}

// -- ownership ----------------------------------------------------------------

async function ownership(host, ctx) {
  const serverId = ctx.serverId;
  if (!isOwner(serverId)) {
    host.appendChild(emptyState('key', 'Only the owner reads this',
      'Who owns the place is decided here, by the owner.'));
    return;
  }
  const transferCard = cardOf('Hand the place over', []);
  const deleteCard = cardOf('End the place', []);
  host.append(transferCard, deleteCard);

  transferCard.appendChild(row({
    title: 'Give the ownership away', lead: el('span', { class: 'm-row__chevron' }, icon('key', { size: 16 })), chevron: true,
    onClick: async () => {
      try {
        const answer = await Api.serverMembers(serverId, { limit: '200' });
        const rows = items(answer.members || answer);
        if (!rows.length) {
          toast('There is nobody to give it to.', { type: 'danger' });
          return;
        }
        await new Promise((done) => formSheet({
          title: 'Hand the place over',
          note: 'The new owner can do everything here, including removing you. This cannot be undone by you.',
          confirmLabel: 'Hand it over', danger: true,
        }, [
          ['The new owner', el('select', { class: 'm-input', 'aria-label': 'The new owner' },
            rows.map((member) => el('option', { value: member.id }, nameOf(member) || member.username || 'A member')))],
        ], done));
        const pick = document.querySelector('.m-sheet select');
        if (!(await confirm({ title: 'Hand the place over?', text: 'It is theirs from now on.', confirmLabel: 'Hand it over', danger: true }))) return;
        await Api.transferServer(serverId, pick.value);
        toast('The place is theirs');
        host.replaceChildren();
        await ownership(host, ctx);
      } catch (error) { failed(error); }
    },
  }));

  deleteCard.appendChild(row({
    title: 'Remove this place', danger: true, lead: el('span', { class: 'm-row__chevron' }, icon('trash', { size: 16 })), chevron: true,
    onClick: async () => {
      const server = serverById(serverId) || {};
      if (!(await confirm({
        title: 'Remove ' + (server.name || 'this place') + '?',
        text: 'Its channels and words go with it. This cannot be undone.',
        confirmLabel: 'Remove it', danger: true,
      }))) return;
      const words = await new Promise((done) => wordsSheet({
        title: 'The reason it ends', fieldLabel: 'Reason', confirmLabel: 'Remove it', danger: true,
        placeholder: 'Why this place ends', required: false,
      }, done));
      void words;
      try {
        await Api.deleteServer(serverId);
        toast('The place is gone');
        navigate(path('/communities'));
      } catch (error) { failed(error); }
    },
  }));
}

// -- analytics ----------------------------------------------------------------

async function analytics(host, ctx) {
  host.appendChild(hold());
  try {
    const answer = await Api.analytics(ctx.serverId, 14);
    clear(host);
    const entries = answer && (answer.days || answer.metrics) || answer;
    const rows = Array.isArray(entries) ? entries : Object.entries(entries || {});
    host.appendChild(cardOf('The last fortnight', rows.length
      ? rows.slice(0, 14).map((entry) => {
        if (Array.isArray(entry)) {
          return fact(entry[0], typeof entry[1] === 'object' ? describeValue(entry[1]) : describeValue(entry[1]));
        }
        return fact(entry.date || entry.day || entry.key || 'A day',
          describeValue(entry.messages != null ? entry.messages : (entry.count != null ? entry.count : entry.value)));
      })
      : [emptyState('activity', 'Nothing counted yet', 'The days\' words are counted as they happen.')]));
  } catch (error) {
    clear(host);
    host.appendChild(failure(error, () => { host.replaceChildren(); return analytics(host, ctx); }));
  }
}

// -- integrations -------------------------------------------------------------

async function integrations(host, ctx) {
  const serverId = ctx.serverId;
  const mayManage = can(serverId, 'MANAGE_SERVER') || isOwner(serverId);
  const card = cardOf('Webhooks', []);
  host.appendChild(card);

  const paint = async () => {
    card.replaceChildren(el('div', { class: 'm-kicker' }, 'Webhooks'), hold());
    try {
      const rows = items(await Api.webhooks(serverId));
      card.replaceChildren(el('div', { class: 'm-kicker' }, 'Webhooks'),
        ...(rows.length ? rows.map((hook) => row({
          lead: el('span', { class: 'm-row__chevron' }, icon('plug', { size: 16 })),
          title: hook.name || 'A webhook',
          sub: hook.channel ? 'in ' + (hook.channel.name || 'a channel') : '',
          side: mayManage ? el('button', {
            class: 'm-go m-go--quiet', type: 'button', 'aria-label': 'Delete the webhook',
            onClick: async () => {
              if (!(await confirm({ title: 'Delete this webhook?', text: 'Whatever posts by it loses its voice here.', confirmLabel: 'Delete', danger: true }))) return;
              try {
                await Api.deleteWebhook(serverId, hook.id);
                toast('The webhook is gone');
                await paint();
              } catch (error) { failed(error); }
            },
          }, 'Delete') : null,
        })) : [emptyState('plug', 'No webhooks', 'A webhook lets an outside thing speak in a channel.')]));

      if (mayManage) {
        card.appendChild(row({
          title: 'New webhook', lead: el('span', { class: 'm-row__chevron' }, icon('plus', { size: 16 })), chevron: true,
          onClick: async () => {
            try {
              const answer = await Api.channels(serverId);
              const channelRows = items(answer.channels || answer).filter((channel) => channel.type === 'text');
              await new Promise((done) => formSheet({
                title: 'A new webhook', confirmLabel: 'Make it',
              }, [
                ['Its name', el('input', { class: 'm-input', type: 'text', maxlength: '60', 'aria-label': 'The name of the webhook' })],
                ['The channel it speaks in', el('select', { class: 'm-input', 'aria-label': 'The channel' },
                  channelRows.map((channel) => el('option', { value: channel.id }, '#' + (channel.name || ''))))],
              ], done));
              const picks = document.querySelectorAll('.m-sheet input, .m-sheet select');
              await Api.createWebhook(serverId, { name: picks[0].value.trim(), channelId: picks[1].value });
              toast('The webhook is made');
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

const SECTIONS = {
  'community.settings': index,
  'community.settings.overview': overview,
  'community.settings.appearance': appearance,
  'community.settings.emojis': emojis,
  'community.settings.channels': channels,
  'community.settings.categories': categoriesSection,
  'community.settings.members': members,
  'community.settings.roles': rolesSection,
  'community.settings.invites': invitesSection,
  'community.settings.moderation': moderation,
  'community.settings.rules': rules,
  'community.settings.voice': voice,
  'community.settings.ownership': ownership,
  'community.settings.analytics': analytics,
  'community.settings.integrations': integrations,
};

export function renderPlaceSettings(ctx) {
  return consoleScreen(ctx.page.id, SECTIONS);
}

// The voice channels of a community, on a phone.
//
// The same three things the desktop section shows: the rooms this community
// talks in, what the instance is doing with voice, and where the provider is
// actually set - which is the instance, not this community.
//
// The provider belongs to the instance, so this section does not offer to
// change it. It says where the decision is made, and it says plainly when
// voice is off, so a member is not left wondering why a room cannot be
// joined.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { screen } from './util.js';
import { empty, loading, failure } from '../components.js';
import { navigate } from '../../../packages/nav.js';
import { State, refreshServerTree, can, isOwner } from '../../../packages/store.js';
import Api from '../../../packages/api.js';

// What the provider is called when it has a name.
const PROVIDER_LABEL = {
  mesh: 'The mesh: member to member, with no server in the middle.',
  cloudflare: 'Cloudflare Realtime.',
  sfu: 'A third-party SFU.',
};

// The voice channels of a community, from its tree.
function voiceChannels(serverId) {
  const tree = State.serverTree.get(serverId) || { channels: [] };
  return (tree.channels || []).filter((channel) => channel.type === 'voice' || channel.type === 'stage');
}

export function voiceSection(serverId) {
  const host = el('div', { class: 'm-stack' });

  async function load() {
    host.replaceChildren(loading('Reading the voice channels'));
    try {
      await refreshServerTree(serverId, { force: true });
    } catch (error) {
      host.replaceChildren(failure(error, load));
      return;
    }
    let capabilities = null;
    try {
      capabilities = await Api.voiceCapabilities();
    } catch (error) {
      capabilities = { error };
    }
    paint(capabilities);
  }

  function paint(capabilities) {
    const channels = voiceChannels(serverId);
    const list = el('div', { class: 'm-list' });

    if (!channels.length) {
      list.appendChild(empty({
        icon: 'volume',
        title: 'No voice channels',
        text: 'A voice channel is a room people talk in. Make one in the channels section.',
      }));
    } else {
      for (const channel of channels) {
        list.appendChild(el('button', {
          class: 'm-row',
          type: 'button',
          onClick: () => navigate('/server/' + serverId + '/channel/' + channel.id),
        },
        el('span', { class: 'm-row__lead' }, icon('volume', { size: 17 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title truncate' }, channel.name),
          el('span', { class: 'm-row__sub truncate' },
            (channel.type === 'stage' ? 'A stage' : 'A voice channel')
            + (channel.topic ? ' · ' + channel.topic : '')))));
      }
    }

    // What the instance is doing with voice right now.
    const voice = capabilities && capabilities.voiceVideo ? capabilities.voiceVideo : null;
    const provider = voice && voice.provider ? voice.provider : null;
    const status = el('div', { class: 'm-stack' });
    if (capabilities && capabilities.error) {
      status.appendChild(el('p', { class: 'm-lede' },
        'The instance did not answer about voice.'));
    } else if (voice && voice.available) {
      status.appendChild(el('p', { class: 'm-lede' },
        'Voice is on. ' + (PROVIDER_LABEL[provider] || 'The instance carries the audio.')));
      status.appendChild(el('p', { class: 'm-section__note' },
        'The provider belongs to the instance, not to this community: it is the same for every community here.'));
    } else {
      status.appendChild(el('p', { class: 'm-lede' },
        'Voice is off on this instance, so the rooms above are rooms nobody can join yet.'));
      status.appendChild(el('p', { class: 'm-section__note' },
        (voice && voice.detail ? voice.detail + ' ' : '')
        + 'Turning voice on is the instance administrator\'s decision.'));
    }

    const mayJoin = can(serverId, 'CONNECT') || isOwner(serverId);
    status.appendChild(el('p', { class: 'm-section__note' },
      mayJoin
        ? 'Members who hold the permission to connect can join these rooms from the channel list.'
        : 'This account does not hold the permission to connect, so it cannot join these rooms.'));

    // Where the provider is set. It is an instance setting, and a community is
    // not where an instance-wide decision belongs.
    status.appendChild(el('button', {
      class: 'm-btn m-btn--sm m-btn--ghost',
      type: 'button',
      onClick: () => navigate('/admin/settings'),
    }, icon('settings', { size: 16 }), 'Open the instance configuration'));

    host.replaceChildren(
      el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' },
          el('div', { class: 'm-section__title' }, 'The voice channels of this community')),
        list),
      el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' },
          el('div', { class: 'm-section__title' }, 'What the instance does with voice')),
        status),
    );
  }

  load();
  return { node: host, load };
}

export default { voiceSection };

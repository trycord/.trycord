// The voice of a community.
//
// The community's part of voice is the channels it has and who may be in
// them. The instance's part is the provider that carries the audio - the
// mesh, or something else - and that is not this section's to set: it is the
// instance's configuration, and this section says where it is.
//
// So nothing here configures a provider. It says what the community has,
// what the instance is currently doing with voice, and where the operator
// goes to change that.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import { path } from '../../../packages/nav.js';
import { head, card, row, blank, fault, fold, hold } from '../../ui/page.js';
import { State, refreshServerTree, can, isOwner } from '../../../packages/store.js';

// The voice channels of a community, from its tree.
function voiceChannels(serverId) {
  const tree = State.serverTree.get(serverId) || { channels: [] };
  return (tree.channels || []).filter((channel) => channel.type === 'voice' || channel.type === 'stage');
}

// What the provider is called when it has a name.
const PROVIDER_LABEL = {
  mesh: 'The mesh: member to member, with no server in the middle.',
  cloudflare: 'Cloudflare Realtime.',
  sfu: 'A third-party SFU.',
};

export function voiceSection(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'fold' });

  const load = async () => {
    host.replaceChildren(hold('Reading the voice channels'));
    try {
      await refreshServerTree(serverId, { force: true });
    } catch (error) {
      host.replaceChildren(fold([fault(error, load)]));
      return;
    }
    let capabilities = null;
    try {
      capabilities = await Api.voiceCapabilities();
    } catch (error) {
      capabilities = { error };
    }
    paint(capabilities);
  };

  const paint = (capabilities) => {
    const channels = voiceChannels(serverId);
    const channelBody = el('div', { class: 'rowlist' });

    if (!channels.length) {
      channelBody.replaceChildren(blank({
        glyph: 'volume',
        title: 'No voice channels',
        text: 'A voice channel is a room people talk in. Make one in the channels section.',
      }));
    } else {
      channelBody.replaceChildren(...channels.map((channel) => row({
        lead: el('span', { class: 'role-dot' }, icon('volume', { size: 15 })),
        title: channel.name,
        sub: (channel.type === 'stage' ? 'A stage' : 'A voice channel')
          + (channel.topic ? ' · ' + channel.topic : ''),
      })));
    }

    // What the instance is doing with voice right now.
    const voice = capabilities && capabilities.voiceVideo ? capabilities.voiceVideo : null;
    const provider = voice && voice.provider ? voice.provider : null;
    const statusBody = el('div', { class: 'fold' });
    if (capabilities && capabilities.error) {
      statusBody.replaceChildren(fold([fault(capabilities.error, null)]));
    } else if (voice && voice.available) {
      statusBody.replaceChildren(
        el('p', { class: 'lede' },
          'Voice is on. ' + (PROVIDER_LABEL[provider] || 'The instance carries the audio.')),
        el('p', { class: 'form-note' },
          'The provider belongs to the instance, not to this community: it is the same for every community here.'));
    } else {
      statusBody.replaceChildren(
        el('p', { class: 'lede' },
          'Voice is off on this instance, so the channels below are rooms nobody can join yet.'),
        el('p', { class: 'form-note' },
          (voice && voice.detail ? voice.detail + ' ' : '')
          + 'Turning voice on is the instance administrator\'s decision.'));
    }

    const mayJoin = can(serverId, 'CONNECT') || isOwner(serverId);
    const joinNote = mayJoin
      ? el('p', { class: 'form-note' },
        'Members who hold the permission to connect can join these rooms from the channel list.')
      : el('p', { class: 'form-note' },
        'This account does not hold the permission to connect, so it cannot join these rooms.');

    host.replaceChildren(fold([
      card({ label: 'The voice channels of this community', glyph: 'volume', body: channelBody, flush: true }),
      card({
        label: 'What the instance does with voice', glyph: 'mic',
        body: fold([statusBody, joinNote]),
      }),
      card({
        label: 'Where the provider is set', glyph: 'cog',
        body: fold([
          el('p', { class: 'lede' },
            'The media server this instance uses is an instance setting. It is not configured here, because a community is not where an instance-wide decision belongs.'),
          el('a', {
            class: 'btn btn--default btn--sm',
            href: path('/admin/settings'),
          }, icon('settings', { size: 14 }), 'Open the instance configuration'),
        ]),
      }),
    ]));
  };

  return {
    node: fold([
      head({
        kicker: 'Community',
        title: 'Voice',
        lede: 'The rooms this community talks in, and what carries them.',
        actions: null,
      }),
      host,
    ]),
    onMount: load,
  };
}

export default { voiceSection };

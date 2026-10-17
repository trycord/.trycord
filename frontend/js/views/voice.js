// Voice channel UI - minimal version
import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { toast } from '../ui.js';

function voiceChannelPanel(serverId, channel) {
  const node = el('div', { class: 'voice-stage' });
  const header = el('div', { class: 'voice-head' });
  head.appendChild(
    el('div', { class: 'voice-head-main' },
      el('h2', { class: 'voice-head-title' }, channel.name))
  );
  node.appendChild(head);
  return node;
}

function leaveVoice(channelId) {
  // stub
}

export { voiceChannelPanel, leaveVoice };

export async function voiceCapabilities() {
  return Api.voiceCapabilities();
}

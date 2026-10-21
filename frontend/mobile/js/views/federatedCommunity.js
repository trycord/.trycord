// A community that lives on another instance.
//
// The same page the desk has, drawn the way the phone draws things.
//
// It is a reference and not a copy: there is no member list, no roles and no
// settings, because the instance that owns the community is the only
// authority over it. What the reader can do here is follow it, and read what
// was relayed from it.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import { State, on as onStore } from '../../../packages/store.js';
import { path } from '../../../packages/nav.js';
import { serverMark, loading, failure } from '../components.js';
import { screen, section, notice, actions, primaryButton, ghostButton } from './util.js';
import { relativeTime } from '../../../packages/format.js';
import {
  federatedName, federatedOrigin, federatedIsJoined,
} from '../../../packages/places.js';

function communityFor(instanceId, communityId) {
  return (State.federated || []).find((entry) =>
    String(entry.originInstanceId) === String(instanceId)
    && String(entry.originCommunityId) === String(communityId)) || null;
}

export function renderFederatedCommunity(ctx) {
  const instanceId = ctx.params.instanceId;
  const communityId = ctx.params.communityId;

  const body = el('div', { class: 'm-stack' });

  const paint = async () => {
    const community = communityFor(instanceId, communityId);
    const joined = community ? federatedIsJoined(community) : false;
    const name = community ? federatedName(community) : 'A community on another instance';
    const origin = community && community.originName ? community.originName : 'another instance';

    const rows = [];
    rows.push(notice({
      tone: 'info',
      title: 'It lives on ' + origin,
      text: 'The people there decide who may read it and who may post in it. '
        + 'What you can do here is follow it and read what is relayed from it.',
    }));

    const list = community && community.channels ? community.channels : [];
    rows.push(section('Channels', list.length
      ? list.map((channel) => el('div', { class: 'm-row' },
        el('span', { class: 'm-row__lead' }, icon(channel.type === 'voice' ? 'volume' : 'hash', { size: 17 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title truncate' }, channel.name),
          el('span', { class: 'm-row__sub truncate' }, channel.topic
            || (channel.canPost ? 'Open to you' : 'Read only')))))
      : [el('p', { class: 'm-lede' }, 'No channels are published for this community.')]));

    body.replaceChildren(...rows);
  };

  const messages = el('div', { class: 'm-stack' });

  const load = async () => {
    await paint();
    messages.replaceChildren(loading('Reading what was relayed'));
    try {
      const rows = await Api.continuumRelayedMessages(instanceId, communityId, 40);
      const list = Array.isArray(rows) ? rows : [];
      messages.replaceChildren(section('What was relayed', list.length
        ? list.map((entry) => el('div', { class: 'm-row' },
          el('span', { class: 'm-row__lead' }, icon('message', { size: 17 })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, String(entry.content || '').slice(0, 120) || 'A message'),
            el('span', { class: 'm-row__sub truncate' },
              (entry.author_name || entry.author || 'Somebody')
              + (entry.created_at ? ' · ' + relativeTime(entry.created_at) : '')))))
        : [el('p', { class: 'm-lede' }, 'Nothing has been relayed from this community yet.')]));
    } catch (error) {
      messages.replaceChildren(failure(error, load));
    }
  };

  const off = onStore('federated', () => { paint(); });

  const host = el('div', { class: 'm-stack' });
  const node = screen(
    el('div', { class: 'm-hero m-hero--quiet' },
      el('h1', { class: 'm-hero__title' }, 'Another instance'),
      el('div', { class: 'm-hero__sub' }, 'A community that lives somewhere else')),
    host,
  );

  return {
    node,
    onMount: async () => {
      await load();
      host.replaceChildren(body, messages);
    },
    cleanup: off,
  };
}

export default { renderFederatedCommunity };

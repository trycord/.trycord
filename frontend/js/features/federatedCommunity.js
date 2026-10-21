// A community that lives on another instance.
//
// It is a reference, not a copy. This page shows what the instance that owns
// the community publishes about it: its name, its channels, and the messages
// that were relayed from it.
//
// What it does not show is anything this instance would have to invent. There
// is no member list here - the members live over there - and no roles, and no
// settings. The instance that owns the community is the only authority over
// it, and the page says so rather than pretending otherwise.
//
// Following a community is the one thing a reader can do here, and it is a
// local record: it says that this person joined a community that lives
// somewhere else, and it carries no authority over it.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { State, on as onStore } from '../../packages/store.js';
import { navigate, path } from '../../packages/nav.js';
import { serverMark } from '../ui/primitives.js';
import { head, card, row, blank, fault, fold, hold, memo } from '../ui/page.js';
import { errorToast, toast, confirmDialog } from '../ui/overlays.js';
import { relativeTime } from '../../packages/format.js';
import {
  federatedRoute, federatedName, federatedOrigin, federatedIsJoined,
} from '../../packages/places.js';

// The community this page is about, as the server knows it.
function communityFor(instanceId, communityId) {
  return (State.federated || []).find((entry) =>
    String(entry.originInstanceId) === String(instanceId)
    && String(entry.originCommunityId) === String(communityId)) || null;
}

export function renderFederatedCommunity(ctx) {
  const instanceId = ctx.params.instanceId;
  const communityId = ctx.params.communityId;
  const known = communityFor(instanceId, communityId);

  const identity = el('div', { class: 'fold fold--tight' });
  const channels = el('div', { class: 'rowlist' });
  const messages = el('div', { class: 'cardrow-list' });
  const notice = el('div', {});

  const host = el('div', { class: 'fold fold--tight' },
    head({
      kicker: 'Another instance',
      title: known ? federatedName(known) : 'A community on another instance',
      lede: known
        ? federatedOrigin(known) + '. It lives there, and that instance decides who may read it.'
        : 'It lives on another instance, and that instance decides who may read it.',
    }),
    identity,
    notice,
    card({ label: 'Channels', glyph: 'hash', body: channels, flush: true }),
    card({ label: 'What was relayed', glyph: 'share', body: messages, flush: true }),
  );

  function paintIdentity() {
    const community = communityFor(instanceId, communityId);
    const joined = community ? federatedIsJoined(community) : false;
    const origin = community && community.originName ? community.originName : 'another instance';

    identity.replaceChildren(el('div', { class: 'settings-profile-top' },
      serverMark({
        id: communityId,
        name: community ? federatedName(community) : 'A community',
        icon_url: community ? community.iconUrl : null,
      }, { size: 'lg', rounded: true }),
      el('div', { class: 'fold fold--tight' },
        el('p', { class: 'pagehead-kicker' }, 'Hosted on ' + origin),
        el('p', { class: 'lede' }, community && community.description
          ? community.description
          : 'A community on another instance. It is a reference, not a copy: it grants '
            + 'no role and no permission here.'),
        el('div', { class: 'actionline' },
          el('button', {
            class: 'btn ' + (joined ? 'btn--default' : 'btn--primary') + ' btn--sm',
            type: 'button',
            onClick: async () => {
              try {
                if (joined) {
                  const yes = await confirmDialog({
                    title: 'Stop following ' + (community ? federatedName(community) : 'this community') + '?',
                    body: 'You will stop seeing what is relayed from it. The community itself '
                      + 'is not affected: it lives on another instance.',
                    confirmLabel: 'Stop following',
                  });
                  if (!yes) return;
                  await Api.continuumLeaveCommunity(instanceId, communityId);
                  toast('You stopped following it');
                } else {
                  await Api.continuumJoinCommunity(instanceId, communityId);
                  toast('You are following it');
                }
                await load();
              } catch (error) { errorToast(error); }
            },
          }, joined ? 'Stop following' : 'Follow'),
          el('a', { class: 'btn btn--ghost btn--sm', href: path('/federation') },
            icon('share', { size: 14 }), 'Federation')))));

    notice.replaceChildren(memo({
      tone: 'info',
      title: 'This community is not yours to change',
      text: 'It lives on ' + origin + '. The people there decide who may read it, '
        + 'who may post in it, and who may remove whom. What you can do here is '
        + 'follow it and write in the channels that are open to you.',
    }));
  }

  function paintChannels() {
    const community = communityFor(instanceId, communityId);
    const list = community && community.channels ? community.channels : [];
    if (!list.length) {
      channels.replaceChildren(blank({
        glyph: 'hash',
        title: 'No channels are published',
        text: 'The instance that owns this community has not published its channels, '
          + 'or has published none that may be read from here.',
      }));
      return;
    }
    channels.replaceChildren(...list.map((channel) => row({
      lead: el('span', { class: 'role-dot' }, icon(channel.type === 'voice' ? 'volume' : 'hash', { size: 15 })),
      title: channel.name,
      sub: channel.topic || (channel.canPost ? 'Open to you' : 'Read only'),
    })));
  }

  function paintMessages(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      messages.replaceChildren(blank({
        glyph: 'share',
        title: 'Nothing has been relayed',
        text: 'The messages of a community on another instance reach this one when '
          + 'somebody here follows it and the other instance sends them.',
      }));
      return;
    }
    messages.replaceChildren(...list.map((entry) => row({
      lead: el('span', { class: 'role-dot' }, icon('message', { size: 15 })),
      title: String(entry.content || '').slice(0, 120) || 'A message',
      sub: (entry.author_name || entry.author || 'Somebody')
        + (entry.created_at ? ' · ' + relativeTime(entry.created_at) : ''),
    })));
  }

  async function load() {
    paintIdentity();
    paintChannels();
    messages.replaceChildren(hold('Reading what was relayed'));
    try {
      const rows = await Api.continuumRelayedMessages(instanceId, communityId, 40);
      paintMessages(rows);
    } catch (error) {
      // The server refuses to name a community this reader does not follow.
      // That is the answer, and it is shown as one.
      messages.replaceChildren(fault(error, load));
    }
  }

  const off = onStore('federated', () => { paintIdentity(); paintChannels(); });

  return {
    node: host,
    onMount: load,
    cleanup() { off(); },
  };
}

export default { renderFederatedCommunity };

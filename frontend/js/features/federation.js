// The reader's cross-instance reports.
//
// A report about something on another instance carries a reference and a
// reason, and nothing else. What crosses and what does not is written down by
// the server, and this screen shows that text rather than a paraphrase of it.
//
// Two lists: the reports this account has filed, and the communities on other
// instances this account follows - where the relayed messages are, and where a
// report can be filed about one of them.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { head, card, row, blank, fault, fold, hold } from '../ui/page.js';
import { openDialog } from '../ui/overlays.js';
import { relativeTime } from '../../packages/format.js';
import { disclosurePanel, reportDialog } from '../ui/federation.js';

export function renderFederation(ctx) {
  const filed = el('div', { class: 'rowlist' });
  const followed = el('div', { class: 'rowlist' });
  const disclosure = el('div', { class: 'disclosure-holder' });

  // The disclosure the server told us about, kept so the next report can show
  // it before it is sent rather than only after.
  let known = null;

  function showDisclosure(answer) {
    const found = answer && answer.disclosure;
    if (!found) return;
    known = found;
    disclosure.replaceChildren(disclosurePanel(found));
  }

  async function paintFiled() {
    try {
      const rows = await Api.myFederationReports();
      const reports = Array.isArray(rows) ? rows : [];
      if (reports.length) showDisclosure(reports[0]);
      filed.replaceChildren(...(reports.length ? reports.map((entry) => row({
        class: 'federation-row',
        lead: el('span', { class: 'federation-glyph' }, icon('flag', { size: 15 })),
        title: entry.reason,
        sub: 'about a ' + (entry.contentType || 'message') + ' in a community on another instance',
        meta: entry.createdAt ? relativeTime(entry.createdAt) : '',
        side: el('span', { class: 'badge' }, entry.status || 'FILED'),
      })) : [blank({
        glyph: 'flag',
        title: 'No reports filed',
        text: 'A report asks another instance to look at something. What it carries is a reference, never a copy.',
      })]));
    } catch (error) {
      filed.replaceChildren(fault(error, paintFiled));
    }
  }

  async function paintFollowed() {
    followed.replaceChildren(hold('Reading the communities you follow'));
    try {
      const rows = await Api.continuumMemberships();
      const memberships = Array.isArray(rows) ? rows : [];
      if (!memberships.length) {
        followed.replaceChildren(blank({
          glyph: 'share',
          title: 'No communities on other instances',
          text: 'When you follow a community that lives on another instance, it is listed here.',
        }));
        return;
      }
      followed.replaceChildren(...memberships.map((entry) => row({
        class: 'federation-row',
        lead: el('span', { class: 'federation-glyph' }, icon('globe', { size: 15 })),
        title: (entry.community && entry.community.name) || 'A community on another instance',
        sub: 'on another instance',
        onClick: () => openRelayed(entry),
      })));
    } catch (error) {
      // Federation switched off is not a failure: the instance says so.
      const message = error && error.status === 404
        ? 'Federation is not enabled on this instance.'
        : (error && error.message) || 'The communities could not be read.';
      followed.replaceChildren(blank({
        glyph: 'share',
        title: 'Nothing to show',
        text: message,
      }));
    }
  }

  // The relayed messages of one community on another instance. Each one can be
  // reported to the instance that wrote it.
  function openRelayed(entry) {
    const list = el('div', { class: 'rowlist' });
    const dialog = openDialog({
      title: (entry.community && entry.community.name) || 'Relayed messages',
      body: el('div', { class: 'fold' }, list),
    });

    Api.continuumRelayedMessages(entry.origin_instance_id, entry.origin_community_id)
      .then((rows) => {
        const messages = Array.isArray(rows) ? rows : [];
        list.replaceChildren(...(messages.length ? messages.map((message) => row({
          class: 'federation-row',
          lead: el('span', { class: 'federation-glyph' }, icon('message', { size: 15 })),
          title: String(message.content || '').replace(/\s+/g, ' ').trim() || '(a message that was removed)',
          sub: (message.author_display_name || message.author_username || 'Someone')
            + ' · written on another instance',
          side: el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            'aria-label': 'Report this message to the instance that wrote it',
            onClick: () => reportDialog({
              targetInstanceId: message.origin_instance_id,
              communityId: message.origin_community_id,
              channelId: message.origin_channel_id,
              contentId: message.origin_message_id,
              contentType: 'message',
            }, {
              disclosure: known,
              onFiled: (filedReport) => {
                showDisclosure(filedReport);
                paintFiled();
              },
            }),
          }, 'Report'),
        })) : [blank({
          glyph: 'message',
          title: 'Nothing has been relayed here',
          text: 'When a message arrives from that instance, it is listed here.',
        })]));
      })
      .catch((error) => {
        list.replaceChildren(el('p', { class: 'form-error' },
          (error && error.message) || 'The relayed messages could not be read.'));
      });
  }

  const node = fold([
    head({
      kicker: 'Federation',
      title: 'Reports about other instances',
      lede: 'What you have asked another instance to look at.',
    }),
    card({
      label: 'Reports you have filed', glyph: 'flag', flush: true, body: filed,
    }),
    card({
      label: 'What a report carries', glyph: 'info',
      note: 'the server says this, and the client repeats it',
      body: disclosure,
    }),
    card({
      label: 'Communities on other instances', glyph: 'share', flush: true, body: followed,
    }),
  ]);

  return {
    node,
    onMount: async () => {
      await paintFiled();
      await paintFollowed();
    },
    cleanup() {},
  };
}

export default { renderFederation };

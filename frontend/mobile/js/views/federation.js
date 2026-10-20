// The reader's cross-instance reports, on a phone.
//
// A report about something on another instance carries a reference and a
// reason, and nothing else. What crosses and what does not is written down by
// the server, and this screen shows that text rather than a paraphrase of it.
//
// Two lists: the reports this account has filed, and the communities on other
// instances this account follows - where the relayed messages are, and where a
// report can be filed about one of them.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import { empty, loading, failure, iconButton } from '../components.js';
import { screen, section, actions, primaryButton, notice } from './util.js';
import { sheet, toast } from '../ui.js';
import { relativeTime } from '../../../packages/format.js';

// What the server says crosses with a report, and what does not.
export function disclosurePanel(disclosure) {
  if (!disclosure) return null;
  const shared = Array.isArray(disclosure.shared) ? disclosure.shared : [];
  const notShared = Array.isArray(disclosure.notShared) ? disclosure.notShared : [];
  if (!shared.length && !notShared.length) return null;
  return el('div', { class: 'm-disclosure' },
    el('div', { class: 'm-disclosure__title' }, 'What crosses with a report'),
    el('ul', { class: 'm-disclosure__list' }, shared.map((line) => el('li', {}, line))),
    el('div', { class: 'm-disclosure__title' }, 'What does not cross'),
    el('ul', { class: 'm-disclosure__list' }, notShared.map((line) => el('li', {}, line))));
}

// The sheet that files one.
//
// The reason is required, because a report with no reason is a report nobody
// can act on. The disclosure is shown before the report is sent when the
// server has already told us what it says, and again from the answer.
export function reportSheet(target, options) {
  const opts = options || {};
  const reason = el('input', {
    class: 'm-input', type: 'text', 'aria-label': 'Why you are reporting this',
    placeholder: 'What is wrong with it',
  });
  const description = el('input', {
    class: 'm-input', type: 'text', 'aria-label': 'Anything else the other instance should know',
  });

  const layer = sheet({
    title: 'Report to the other instance',
    body: el('div', { class: 'm-stack' },
      el('label', { class: 'm-field' },
        el('span', { class: 'm-field__label' }, 'Reason'), reason),
      el('label', { class: 'm-field' },
        el('span', { class: 'm-field__label' }, 'Anything else'), description),
      disclosurePanel(opts.disclosure)),
    footer: actions([
      primaryButton('File the report', async () => {
        if (!reason.value.trim()) {
          toast('Say why, so the other instance can act on it.', { type: 'danger' });
          return;
        }
        try {
          const filed = await Api.fileFederationReport({
            targetInstanceId: target.targetInstanceId,
            communityId: target.communityId,
            channelId: target.channelId,
            contentId: target.contentId,
            contentType: target.contentType || 'message',
            reason: reason.value.trim(),
            description: description.value.trim() || undefined,
          });
          layer.close();
          toast('The report has been filed.', { type: 'success' });
          if (opts.onFiled) opts.onFiled(filed);
        } catch (error) { toast(error.message, { type: 'danger' }); }
      }, { block: true }),
    ]),
  });
  return layer;
}

export function renderFederation(ctx) {
  const filed = el('div', { class: 'm-list' });
  const followed = el('div', { class: 'm-list' });
  const disclosure = el('div', { class: 'm-stack' });
  const host = el('div', { class: 'm-stack' });
  const node = screen(
    el('div', { class: 'm-hero m-hero--quiet' },
      el('h1', { class: 'm-hero__title' }, 'Federation reports'),
      el('div', { class: 'm-hero__sub' }, 'What you have asked another instance to look at.')),
    host);

  // The disclosure the server told us about, kept so the next report can show
  // it before it is sent rather than only after.
  let known = null;

  function showDisclosure(answer) {
    const found = answer && answer.disclosure;
    if (!found) return;
    known = found;
    clear(disclosure);
    disclosure.appendChild(disclosurePanel(found));
  }

  async function paintFiled() {
    try {
      const rows = await Api.myFederationReports();
      const reports = Array.isArray(rows) ? rows : [];
      if (reports.length) showDisclosure(reports[0]);
      clear(filed);
      if (!reports.length) {
        filed.appendChild(empty({
          icon: 'flag',
          title: 'No reports filed',
          text: 'A report asks another instance to look at something.',
        }));
        return;
      }
      for (const entry of reports) {
        filed.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__lead' }, icon('flag', { size: 17 })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title truncate' }, entry.reason),
            el('span', { class: 'm-row__sub truncate' },
              'about a ' + (entry.contentType || 'message') + ' on another instance')),
          el('span', { class: 'm-row__actions' },
            el('span', { class: 'm-chip' }, entry.status || 'FILED'))));
      }
    } catch (error) {
      clear(filed);
      filed.appendChild(failure(error, paintFiled));
    }
  }

  async function paintFollowed() {
    clear(followed);
    followed.appendChild(loading('Reading the communities you follow'));
    try {
      const rows = await Api.continuumMemberships();
      const memberships = Array.isArray(rows) ? rows : [];
      clear(followed);
      if (!memberships.length) {
        followed.appendChild(empty({
          icon: 'share',
          title: 'No communities on other instances',
          text: 'When you follow a community that lives on another instance, it is listed here.',
        }));
        return;
      }
      for (const entry of memberships) {
        followed.appendChild(el('button', {
          class: 'm-row', type: 'button',
          onClick: () => openRelayed(entry),
        },
        el('span', { class: 'm-row__lead' }, icon('globe', { size: 17 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title truncate' },
            (entry.community && entry.community.name) || 'A community on another instance'),
          el('span', { class: 'm-row__sub' }, 'written on another instance')),
        el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 }))));
      }
    } catch (error) {
      clear(followed);
      followed.appendChild(empty({
        icon: 'share',
        title: 'Nothing to show',
        text: error && error.status === 404
          ? 'Federation is not enabled on this instance.'
          : (error && error.message) || 'The communities could not be read.',
      }));
    }
  }

  // The relayed messages of one community on another instance. Each one can be
  // reported to the instance that wrote it.
  function openRelayed(entry) {
    const body = el('div', { class: 'm-stack' });
    const layer = sheet({
      title: (entry.community && entry.community.name) || 'Relayed messages',
      body,
    });

    Api.continuumRelayedMessages(entry.origin_instance_id, entry.origin_community_id)
      .then((rows) => {
        const messages = Array.isArray(rows) ? rows : [];
        clear(body);
        if (!messages.length) {
          body.appendChild(empty({
            icon: 'message',
            title: 'Nothing has been relayed here',
            text: 'When a message arrives from that instance, it is listed here.',
          }));
          return;
        }
        const list = el('div', { class: 'm-list' });
        for (const message of messages) {
          list.appendChild(el('div', { class: 'm-row' },
            el('span', { class: 'm-row__lead' }, icon('message', { size: 17 })),
            el('span', { class: 'm-row__body' },
              el('span', { class: 'm-row__title truncate' },
                String(message.content || '').replace(/\s+/g, ' ').trim() || '(a message that was removed)'),
              el('span', { class: 'm-row__sub truncate' },
                (message.author_display_name || message.author_username || 'Someone'))),
            el('span', { class: 'm-row__actions' },
              iconButton('flag', 'Report this message to the instance that wrote it', () => {
                reportSheet({
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
                });
              }))));
        }
        body.appendChild(list);
      })
      .catch((error) => {
        clear(body);
        body.appendChild(failure(error, () => openRelayed(entry)));
      });
  }

  host.append(
    section('Reports you have filed', filed),
    section('What a report carries', disclosure),
    section('Communities on other instances', followed));

  return {
    node,
    head: { title: 'Federation reports' },
    onMount: async () => {
      await paintFiled();
      await paintFollowed();
    },
  };
}

export default { renderFederation };

// The cross-instance reports this instance has received, and the messages its
// own communities' members wrote elsewhere.
//
// A report arrives from another instance about something here. What arrives is
// a reference and a reason: the community and channel it is about, the id of
// the content, and why it was reported. The content itself never crosses.
//
// Whether this instance can act on a report is decided here, by the server:
// a report about something this instance holds is actionable, and a report
// about something it has never seen is still a report worth keeping.
//
// The other half is this instance's own side of the relay: what the members
// of this instance's communities wrote on other instances. That is the
// owner's to moderate, and the platform administrator moderates every
// community of the instance, so the surface is drawn here in full.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { head, card, row, blank, fault, fold, hold, memo } from '../ui/page.js';
import { relativeTime } from '../../packages/format.js';
import { continuum, moderationSurface } from './federation.js';

export function adminFederation() {
  const list = el('div', { class: 'rowlist' });
  const moderation = el('div', { class: 'fold' });
  // What the server answered the last time. It lives here rather than in the
  // surface, so that re-reading the surface after an action does not take the
  // answer with it.
  const answer = el('div', { class: 'memo-list' });

  function say(title, text, tone) {
    answer.replaceChildren(memo({ tone: tone || 'info', role: 'status', title, text }));
  }

  async function paint() {
    try {
      const rows = await Api.inboundFederationReports(100);
      const reports = Array.isArray(rows) ? rows : [];
      list.replaceChildren(...(reports.length ? reports.map((entry) => row({
        class: 'federation-row',
        lead: el('span', { class: 'federation-glyph' }, icon('flag', { size: 15 })),
        title: entry.reason,
        sub: 'about a ' + (entry.contentType || 'message')
          + ' in a community on this instance',
        meta: entry.receivedAt ? relativeTime(entry.receivedAt) : '',
        side: el('div', { class: 'cardrow-side' },
          el('span', { class: 'badge' }, entry.actionable ? 'actionable' : 'no content here'),
          el('span', { class: 'badge' }, entry.status || 'RECEIVED')),
      })) : [blank({
        glyph: 'share',
        title: 'No reports have arrived',
        text: 'When another instance sends a report about something here, it is listed here.',
      })]));
    } catch (error) {
      list.replaceChildren(fault(error, paint));
    }
  }

  // What the members of this instance's communities wrote on other instances.
  //
  // The whole instance is in scope here: the platform administrator moderates
  // every community of it, so the relay is read without naming a community.
  async function paintModeration() {
    moderation.replaceChildren(hold('Reading what the members of this instance wrote elsewhere'));
    try {
      const [servers, messages, members] = await Promise.all([
        Api.adminServers({ limit: '100' }),
        continuum.moderationMessages(),
        continuum.moderationMembers(),
      ]);
      const names = {};
      for (const server of Array.isArray(servers) ? servers : []) names[server.id] = server.name;
      moderation.replaceChildren(answer, moderationSurface({
        messages: Array.isArray(messages) ? messages : [],
        members: Array.isArray(members) ? members : [],
        names,
        refresh: paintModeration,
        say,
      }));
    } catch (error) {
      // Federation switched off is not a failure: the instance says so.
      if (error && error.status === 404) {
        moderation.replaceChildren(blank({
          glyph: 'share',
          title: 'Nothing to show',
          text: 'Federation is not enabled on this instance.',
        }));
        return;
      }
      moderation.replaceChildren(fault(error, paintModeration));
    }
  }

  return {
    node: fold([
      head({
        kicker: 'Moderation',
        title: 'Federation reports',
        lede: 'Reports about activity on this instance, sent by other instances.',
      }),
      card({ label: 'Reports received', glyph: 'flag', flush: true, body: list }),
      moderation,
      card({
        label: 'What a report carries', glyph: 'info',
        body: el('p', { class: 'card-note' },
          'A reference and a reason. The content stays where it was written, and '
          + 'nothing about the person who reported it crosses either.'),
      }),
    ]),
    onMount: async () => {
      await paint();
      await paintModeration();
    },
    cleanup() {},
  };
}

export default { adminFederation };

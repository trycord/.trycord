// The cross-instance reports this instance has received.
//
// A report arrives from another instance about something here. What arrives is
// a reference and a reason: the community and channel it is about, the id of
// the content, and why it was reported. The content itself never crosses.
//
// Whether this instance can act on a report is decided here, by the server:
// a report about something this instance holds is actionable, and a report
// about something it has never seen is still a report worth keeping.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { head, card, row, blank, fault, fold } from '../ui/page.js';
import { relativeTime } from '../../packages/format.js';

export function adminFederation() {
  const list = el('div', { class: 'rowlist' });

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

  return {
    node: fold([
      head({
        kicker: 'Moderation',
        title: 'Federation reports',
        lede: 'Reports about activity on this instance, sent by other instances.',
      }),
      card({ label: 'Reports received', glyph: 'flag', flush: true, body: list }),
      card({
        label: 'What a report carries', glyph: 'info',
        body: el('p', { class: 'card-note' },
          'A reference and a reason. The content stays where it was written, and '
          + 'nothing about the person who reported it crosses either.'),
      }),
    ]),
    onMount: paint,
    cleanup() {},
  };
}

export default { adminFederation };

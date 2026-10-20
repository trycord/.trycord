// The incident timeline, for readers.
//
// What an operator wrote is what is shown here: the summary they wrote, the
// note under it, and when it happened. Nothing is added to it and nothing is
// taken from it, because a status page that says more than the operator wrote
// is making a claim nobody made.
//
// The administrative side - writing an incident and closing it - lives in the
// instance console. This page only reads.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { head, card, blank, fault, fold, memo } from '../ui/page.js';
import { formatDateTime } from '../../packages/locale.js';

const STATUS_LABEL = {
  investigating: 'Being looked at',
  identified: 'The cause is known',
  monitoring: 'Being watched',
  resolved: 'Resolved',
  scheduled: 'Scheduled',
};

const STATUS_TONE = {
  investigating: 'warning',
  identified: 'warning',
  monitoring: 'info',
  resolved: 'success',
  scheduled: 'info',
};

function statusLabel(status) {
  return STATUS_LABEL[status] || status;
}

// One entry of the timeline.
export function incidentEntry(entry) {
  return el('article', { class: 'incident' },
    el('div', { class: 'incident-head' },
      el('span', { class: 'incident-status', dataset: { tone: STATUS_TONE[entry.status] || 'info' } },
        statusLabel(entry.status)),
      el('time', { class: 'incident-time', datetime: entry.startedAt || '' },
        formatDateTime(entry.startedAt))),
    el('h3', { class: 'incident-title' }, entry.title),
    el('p', { class: 'incident-summary' }, entry.summary),
    entry.body ? el('p', { class: 'incident-body' }, entry.body) : null);
}

export function renderStatus(ctx) {
  const timeline = el('div', { class: 'incident-timeline' });
  const summary = el('div', { class: 'factline' });

  async function load() {
    timeline.replaceChildren(el('p', { class: 'holdline', 'aria-busy': 'true' }, 'Reading the timeline'));
    try {
      const answer = await Api.incidentStatus({ limit: 50 });
      const incidents = Array.isArray(answer && answer.incidents) ? answer.incidents : [];
      const maintenance = Array.isArray(answer && answer.maintenance) ? answer.maintenance : [];

      summary.replaceChildren(el('div', { class: 'factline' },
        el('div', { class: 'factcell' },
          el('span', { class: 'factnum' }, String(answer && answer.openIncidents || 0)),
          el('span', { class: 'factlabel' }, 'open')),
        el('div', { class: 'factcell' },
          el('span', { class: 'factnum' }, String(incidents.length)),
          el('span', { class: 'factlabel' }, 'recorded')),
        el('div', { class: 'factcell' },
          el('span', { class: 'factnum' }, String(maintenance.length)),
          el('span', { class: 'factlabel' }, 'planned'))));

      const entries = incidents.concat(maintenance);
      if (!entries.length) {
        timeline.replaceChildren(blank({
          glyph: 'check',
          title: 'Nothing has been recorded',
          text: (answer && answer.summary) || 'No incidents have been recorded.',
        }));
        return;
      }
      timeline.replaceChildren(...entries.map(incidentEntry));
    } catch (error) {
      if (error && error.status === 404) {
        summary.replaceChildren();
        timeline.replaceChildren(blank({
          glyph: 'info',
          title: 'This instance publishes no status page',
          text: 'An operator has not opened one here.',
        }));
        return;
      }
      timeline.replaceChildren(fault(error, load));
    }
  }

  const node = fold([
    head({
      kicker: 'This instance',
      title: 'Service status',
      lede: 'What the people running this instance have written down.',
    }),
    summary,
    card({ label: 'The timeline', glyph: 'activity', body: timeline }),
    memo({
      tone: 'info',
      title: 'What is here is what an operator wrote',
      text: 'Nothing is added here, and nothing is guessed: an instance with nothing recorded says so.',
    }),
  ]);

  return { node, onMount: load, cleanup() {} };
}

export default { renderStatus };

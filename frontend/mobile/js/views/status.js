// The incident timeline, on a phone.
//
// What an operator wrote is what is shown here: the summary they wrote, the
// note under it, and when it happened. Nothing is added to it and nothing is
// taken from it, because a status page that says more than the operator wrote
// is making a claim nobody made.
//
// The administrative side - writing an incident and closing it - lives in the
// instance console. This screen only reads.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import { empty, loading, failure } from '../components.js';
import { screen, section, stat } from './util.js';
import { formatDateTime } from '../../../packages/locale.js';

const STATUS_LABEL = {
  investigating: 'Being looked at',
  identified: 'The cause is known',
  monitoring: 'Being watched',
  resolved: 'Resolved',
  scheduled: 'Scheduled',
};

function statusLabel(status) {
  return STATUS_LABEL[status] || status;
}

// One entry of the timeline.
function incidentEntry(entry) {
  return el('article', { class: 'm-incident' },
    el('div', { class: 'm-incident__head' },
      el('span', { class: 'm-incident__status' }, statusLabel(entry.status)),
      el('time', { class: 'm-incident__time' }, formatDateTime(entry.startedAt))),
    el('div', { class: 'm-incident__title' }, entry.title),
    el('p', { class: 'm-incident__summary' }, entry.summary),
    entry.body ? el('p', { class: 'm-incident__body' }, entry.body) : null);
}

export function renderStatus(ctx) {
  const timeline = el('div', { class: 'm-stack' });
  const summary = el('div', { class: 'm-strip' });
  const host = el('div', { class: 'm-stack' });
  const node = screen(
    el('div', { class: 'm-hero m-hero--quiet' },
      el('h1', { class: 'm-hero__title' }, 'Service status'),
      el('div', { class: 'm-hero__sub' }, 'What the people running this instance have written down.')),
    host);

  async function load() {
    clear(timeline);
    timeline.appendChild(loading('Reading the timeline'));
    try {
      const answer = await Api.incidentStatus({ limit: 50 });
      const incidents = Array.isArray(answer && answer.incidents) ? answer.incidents : [];
      const maintenance = Array.isArray(answer && answer.maintenance) ? answer.maintenance : [];

      clear(summary);
      summary.append(
        stat(String(answer && answer.openIncidents || 0), 'open'),
        stat(String(incidents.length), 'recorded'),
        stat(String(maintenance.length), 'planned'));

      const entries = incidents.concat(maintenance);
      clear(timeline);
      if (!entries.length) {
        timeline.appendChild(empty({
          icon: 'check',
          title: 'Nothing has been recorded',
          text: (answer && answer.summary) || 'No incidents have been recorded.',
        }));
        return;
      }
      for (const entry of entries) timeline.appendChild(incidentEntry(entry));
    } catch (error) {
      clear(summary);
      clear(timeline);
      if (error && error.status === 404) {
        timeline.appendChild(empty({
          icon: 'info',
          title: 'This instance publishes no status page',
          text: 'An operator has not opened one here.',
        }));
        return;
      }
      timeline.appendChild(failure(error, load));
    }
  }

  host.append(summary, section('The timeline', timeline));

  return {
    node,
    head: { title: 'Service status' },
    onMount: load,
  };
}

export default { renderStatus };

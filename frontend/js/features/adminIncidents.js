// The incident timeline, administratively.
//
// An operator posts an incident with a status, a summary and a note under it,
// and moves it on as it is looked at, understood, watched, and closed. What is
// written here is what the status page shows, so the screen says plainly what
// it will do: it posts what you write.
//
// Nothing here invents an entry. An instance with nothing recorded says it has
// nothing recorded, and closing an incident is a status, not a deletion.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { head, card, row, blank, fault, fold, hold } from '../ui/page.js';
import { confirmDialog, errorToast, toast } from '../ui/overlays.js';
import { formatDateTime } from '../../packages/locale.js';

const STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'];
const STATUS_LABEL = {
  investigating: 'Being looked at',
  identified: 'The cause is known',
  monitoring: 'Being watched',
  resolved: 'Resolved',
  scheduled: 'Scheduled',
};

export function adminIncidents() {
  const list = el('div', { class: 'rowlist' });

  const kind = el('select', { class: 'input', 'aria-label': 'What kind of entry this is' });
  kind.appendChild(el('option', { value: 'incident' }, 'An incident'));
  kind.appendChild(el('option', { value: 'maintenance' }, 'Planned maintenance'));

  const status = el('select', { class: 'input', 'aria-label': 'The status of this entry' });
  for (const name of ['investigating', 'identified', 'monitoring', 'resolved']) {
    status.appendChild(el('option', { value: name }, STATUS_LABEL[name]));
  }

  const title = el('input', {
    class: 'input', type: 'text', 'aria-label': 'The title',
    placeholder: 'What it says at a glance',
  });
  const summary = el('textarea', {
    class: 'textarea', rows: '3', 'aria-label': 'The summary',
    placeholder: 'What is happening',
  });
  const body = el('textarea', {
    class: 'textarea', rows: '3', 'aria-label': 'The note under it',
    placeholder: 'Anything else people should know',
  });
  const scheduled = el('input', {
    class: 'input', type: 'datetime-local', 'aria-label': 'The date the maintenance is planned for',
  });

  const note = el('p', { class: 'form-note', role: 'status', 'aria-live': 'polite' });

  function paintScheduled() {
    scheduled.hidden = kind.value !== 'maintenance';
  }
  kind.addEventListener('change', paintScheduled);
  paintScheduled();

  async function post(event) {
    event.preventDefault();
    if (!title.value.trim() || !summary.value.trim()) {
      note.textContent = 'An incident needs a title and a summary.';
      return;
    }
    if (kind.value === 'maintenance' && !scheduled.value) {
      note.textContent = 'Planned maintenance needs the date it is planned for.';
      return;
    }
    note.textContent = '';
    try {
      await Api.createIncident({
        kind: kind.value,
        status: kind.value === 'maintenance' ? 'scheduled' : status.value,
        title: title.value.trim(),
        summary: summary.value.trim(),
        body: body.value.trim() || undefined,
        scheduledFor: kind.value === 'maintenance' ? scheduled.value : undefined,
      });
      toast('Posted. It is on the status page now.');
      title.value = '';
      summary.value = '';
      body.value = '';
      scheduled.value = '';
      await paint();
    } catch (error) { errorToast(error); }
  }

  async function move(entry, next) {
    try {
      await Api.updateIncident(entry.id, { status: next });
      toast(next === 'resolved' ? 'Closed' : 'Moved to ' + STATUS_LABEL[next].toLowerCase());
      await paint();
    } catch (error) { errorToast(error); }
  }

  async function close(entry) {
    const yes = await confirmDialog({
      title: 'Close this incident?',
      body: 'It stays on the timeline, marked resolved. Nothing is deleted.',
      confirmLabel: 'Close it',
    });
    if (!yes) return;
    await move(entry, 'resolved');
  }

  function nextStatus(entry) {
    const index = STATUSES.indexOf(entry.status);
    if (index === -1 || index === STATUSES.length - 1) return null;
    return STATUSES[index + 1];
  }

  async function paint() {
    try {
      const rows = await Api.incidents({ limit: 100 });
      const entries = Array.isArray(rows) ? rows : [];
      list.replaceChildren(...(entries.length ? entries.map((entry) => {
        const next = nextStatus(entry);
        return row({
          class: 'incident-row',
          lead: el('span', { class: 'incident-status', dataset: { tone: entry.status } },
            STATUS_LABEL[entry.status] || entry.status),
          title: entry.title,
          sub: entry.summary,
          meta: entry.startedAt ? formatDateTime(entry.startedAt) : '',
          side: el('div', { class: 'cardrow-side' },
            next ? el('button', {
              class: 'btn btn--default btn--sm', type: 'button',
              'aria-label': 'Move ' + entry.title + ' to ' + STATUS_LABEL[next].toLowerCase(),
              onClick: () => move(entry, next),
            }, STATUS_LABEL[next]) : null,
            entry.status !== 'resolved' ? el('button', {
              class: 'btn btn--default btn--sm', type: 'button',
              'aria-label': 'Close ' + entry.title,
              onClick: () => close(entry),
            }, 'Close') : null),
        });
      }) : [blank({
        glyph: 'activity',
        title: 'Nothing has been recorded',
        text: 'An instance with nothing recorded says so, rather than claiming that everything is fine.',
      })]));
    } catch (error) {
      list.replaceChildren(fault(error, paint));
    }
  }

  return {
    node: fold([
      head({
        kicker: 'Instance',
        title: 'Incidents',
        lede: 'What has happened to this instance, and what is being done about it.',
      }),
      card({
        label: 'Post an incident', glyph: 'alert',
        note: 'what you write is what the status page shows',
        body: el('form', { class: 'form-stack', onSubmit: post },
          el('div', { class: 'incident-form-row' }, kind, status),
          title, summary, body, scheduled,
          note,
          el('div', { class: 'formfoot' },
            el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Post it'))),
      }),
      card({ label: 'The timeline', glyph: 'activity', flush: true, body: list }),
    ]),
    onMount: paint,
    cleanup() {},
  };
}

export default { adminIncidents };

import Api from '../api.js';
import { loadingState } from '../view-states.js';
import { esc, el, btn, clear, toast, relTime } from '../ui.js';
import { emptyState } from '../components.js';
import { adminError, currentSeq, reportListFailure } from './shared.js';

import { statusChip } from '../components.js';
// The reports console offers the same moderation actions the users and communities
// consoles do. These five buttons called them with no import at all, so every one of
// them threw a ReferenceError when pressed, and nothing noticed at load because a
// missing name is only a failure on the line that uses it.
import { userEnforceModal, liftUserModal } from './users.js';
import { serverEnforceModal, serverRemoveModal, serverLiftModal } from './communities.js';

const REPORT_STATUSES = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'DISMISSED'];

function reportRow(r, refresh) {
  const row = el('div', { class: 'card card--list--row' });
  row.appendChild(statusChip(r.status));
  const idt = el('div', { class: 'grow' });
  idt.append(
    el('div', { class: 'admin-name' }, esc(r.target_type), ' ', el('span', { class: 'muted small' }, '#' + esc(r.target_id))),
    el('div', { class: 'muted small' },
      (r.reporter_name ? 'by ' + esc(r.reporter_name) + ' · ' : '') + relTime(r.created_at) + ' · ' + esc(String(r.reason || '').slice(0, 90))));
  row.appendChild(idt);
  row.appendChild(el('button', { class: 'btn ghost sm', type: 'button', onClick: () => toggleReportDetail(row, r, refresh) }, 'Detail'));
  return row;
}

async function toggleReportDetail(row, r, refresh) {
  const parent = row.parentElement;
  const existing = parent.querySelector('.admin-detail');
  if (existing) existing.remove();
  const det = el('div', { class: 'admin-detail' }, loadingState('Loading detail'));
  row.after(det);
  try {
    const full = await Api.adminReport(r.id);
    clear(det);
    if (!full) { det.appendChild(el('div', { class: 'form-error' }, 'Report not found.')); return; }
    const note = el('input', { class: 'input', placeholder: 'Note (recorded in audit log)' });
    const sel = el('select', { class: 'input' },
      REPORT_STATUSES.map((s) => el('option', { value: s, selected: s === full.status }, s)));
    const updateBtn = el('button', { class: 'btn primary sm', type: 'button' }, 'Update status');
    updateBtn.addEventListener('click', async () => {
      try { await Api.adminUpdateReport(r.id, { status: sel.value, note: note.value.trim() }); toast('Report updated.', 'ok'); refresh(); }
      catch (ex) { toast(ex.message || 'Failed to update.', 'error'); }
    });
    det.appendChild(el('div', { class: 'admin-detail-head' },
      el('div', { class: 'grow' }, el('strong', {}, 'Reason: '), esc(full.reason || ''))));
    if (full.description) det.appendChild(el('p', { class: 'muted small' }, esc(full.description)));
    det.appendChild(el('div', { class: 'muted small' },
      'Reported ' + relTime(full.created_at) + ' · updated ' + relTime(full.updated_at) +
      (full.resolved_at ? ' · resolved ' + relTime(full.resolved_at) : '')));
    const rowLine = el('div', { class: 'card--list__actions' });
    rowLine.append(sel, note, updateBtn);
    det.appendChild(rowLine);
    det.appendChild(targetBlock(full, refresh));
  } catch (ex) {
    clear(det);
    det.appendChild(el('div', { class: 'form-error' }, ex.message || 'Failed to load detail.'));
  }
}

function targetBlock(full, refresh) {
  const wrap = el('div', { class: 'card--list__actions' });
  const t = full.target_type;
  if (t === 'user') {
    const u = full.targetUser || { id: full.target_id, username: full.target_id, display_name: full.target_id };
    const uu = { id: u.id, username: u.username, displayName: u.display_name };
    wrap.append(el('span', { class: 'muted small' }, '@' + esc(uu.username)), ' ');
    wrap.append(
      el('button', { class: 'btn danger sm', type: 'button', onClick: () => userEnforceModal(uu, refresh) }, 'Enforce user'),
      el('button', { class: 'btn ghost sm', type: 'button', onClick: () => liftUserModal(uu, refresh) }, 'Lift user'));
  } else if (t === 'server') {
    const s = { id: full.target_id, name: full.target_id };
    wrap.append(
      el('button', { class: 'btn danger sm', type: 'button', onClick: () => serverEnforceModal(s, refresh) }, 'Suspend'),
      el('button', { class: 'btn danger sm', type: 'button', onClick: () => serverRemoveModal(s, refresh) }, 'Remove'),
      el('button', { class: 'btn ghost sm', type: 'button', onClick: () => serverLiftModal(s, refresh) }, 'Lift'));
  }
  return wrap;
}

export async function renderReports(body, show, seq) {
  const toolbar = el('div', { class: 'admin-toolbar' });
  const sel = el('select', { class: 'input', 'aria-label': 'Filter reports by status' },
    el('option', { value: '' }, 'All statuses'),
    REPORT_STATUSES.map((s) => el('option', { value: s }, s)));
  // A report is what someone submitted, not a finding. The old copy ("reports
  // stay scoped: reviewers see actionable cases only") read as though the queue
  // contained established cases to action, which is the opposite of what a
  // reviewer has to determine.
  toolbar.append(sel, el('span', { class: 'muted small' },
    'A report records what someone submitted. Decide for yourself whether it happened.'));
  const listWrap = el('div', { class: 'admin-list' });
  show(el('div', { class: 'admin-block admin-block--sections' }, toolbar, listWrap));
  const render = async (status) => {
    listWrap.setAttribute('aria-busy', 'true');
    clear(listWrap);
    try {
      const found = await Api.adminReports({ status });
      if (seq !== currentSeq()) return;
      if (!found || !found.length) {
        listWrap.appendChild(emptyState('', 'No reports here.', 'Change the filter to see other cases.'));
        return;
      }
      for (const r of found) listWrap.appendChild(reportRow(r, () => render(sel.value)));
    } catch (ex) {
      listWrap.appendChild(el('p', { class: 'form-error' }, adminError(ex, 'Could not load reports.')));
    } finally {
      listWrap.removeAttribute('aria-busy');
    }
  };
  sel.addEventListener('change', () => render(sel.value).catch(reportListFailure(listWrap)));
  await render(sel.value);
}

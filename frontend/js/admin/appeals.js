import Api from '../api.js';
import { esc, el, btn, clear, toast, openModal, relTime } from '../ui.js';
import { emptyState } from '../components.js';
import { adminError, currentSeq, denied, reportListFailure } from './shared.js';

import { statusChip } from '../components.js';

const APPEAL_STATUSES = ['OPEN', 'UNDER_REVIEW', 'APPROVED', 'DENIED'];

function appealRow(a, refresh) {
  const row = el('div', { class: 'card card--list--row' });
  row.appendChild(statusChip(a.status));
  const idt = el('div', { class: 'grow' });
  idt.append(
    el('div', { class: 'admin-name' }, esc(a.user_name || a.user_id), ' ', el('span', { class: 'muted small' }, '· ' + esc(a.action_type))),
    el('div', { class: 'muted small' }, 'Action: ' + esc(String(a.action_reason || '').slice(0, 90))),
    el('div', { class: 'muted small' }, 'Appeal: ' + esc(String(a.reason || '').slice(0, 90))));
  row.appendChild(idt);
  row.appendChild(el('div', { class: 'muted small admin-when' }, relTime(a.created_at)));
  const decided = a.status === 'APPROVED' || a.status === 'DENIED';
  if (!decided) {
    const acts = el('div', { class: 'card--list__actions' });
    acts.append(
      el('button', { class: 'btn primary sm', type: 'button', onClick: () => appealDecisionModal(a, 'APPROVED', refresh) }, 'Approve'),
      el('button', { class: 'btn danger sm', type: 'button', onClick: () => appealDecisionModal(a, 'DENIED', refresh) }, 'Deny'));
    row.appendChild(acts);
  }
  return row;
}

function appealDecisionModal(appeal, decision, onDone) {
  const err = el('div', { class: 'form-error', hidden: true });
  const note = el('textarea', { class: 'input', rows: 3, required: true, placeholder: 'Note — recorded in the audit log and visible to the user' });
  const approve = decision === 'APPROVED';
  const modal = openModal({
    title: (approve ? 'Approve' : 'Deny') + ' appeal — ' + appeal.user_name,
    body: el('div', { class: 'admin-form' }, err,
      approve ? el('p', {}, 'Approving lifts the enforcement on this account or community.') : null,
      el('div', { class: 'field' }, el('label', {}, 'Note'), note)),
    footer: [
      btn('Cancel', { variant: 'ghost', onClick: () => modal.close() }),
      el('button', { class: approve ? 'btn primary' : 'btn danger', type: 'button', onClick: submit }, approve ? 'Approve appeal' : 'Deny appeal'),
    ],
  });
  async function submit() {
    err.hidden = true;
    const reasonText = note.value.trim();
    if (!reasonText) { err.hidden = false; err.textContent = 'A note is required.'; return; }
    try {
      await Api.adminDecideAppeal(appeal.id, decision, reasonText);
      modal.close();
      toast(approve ? 'Appeal approved.' : 'Appeal denied.', 'ok');
      onDone();
    } catch (ex) { err.hidden = false; err.textContent = adminError(ex, 'Failed to decide appeal.'); }
  }
  return modal;
}

export async function renderAppeals(body, show, seq) {
  const toolbar = el('div', { class: 'admin-toolbar' });
  const sel = el('select', { class: 'input', 'aria-label': 'Filter appeals by status' },
    el('option', { value: '' }, 'All statuses'),
    APPEAL_STATUSES.map((s) => el('option', { value: s }, s)));
  toolbar.appendChild(sel);
  const listWrap = el('div', { class: 'admin-list' });
  show(el('div', { class: 'admin-block admin-block--sections' }, toolbar, listWrap));
  const render = async (status) => {
    listWrap.setAttribute('aria-busy', 'true');
    clear(listWrap);
    try {
      const found = await Api.adminAppeals({ status });
      if (seq !== currentSeq()) return;
      if (!found || !found.length) {
        listWrap.appendChild(emptyState('', 'No appeals here.', 'Change the filter to see other cases.'));
        return;
      }
      for (const a of found) listWrap.appendChild(appealRow(a, () => render(sel.value)));
    } catch (ex) {
      listWrap.appendChild(el('p', { class: 'form-error' }, adminError(ex, 'Could not load appeals.')));
    } finally {
      listWrap.removeAttribute('aria-busy');
    }
  };
  sel.addEventListener('change', () => render(sel.value).catch(reportListFailure(listWrap)));
  await render(sel.value);
}

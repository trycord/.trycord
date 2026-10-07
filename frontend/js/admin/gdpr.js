import Api from '../api.js';
import { can } from '../state.js';
import { esc, el, btn, clear, toast, openModal, relTime, fullTime } from '../ui.js';
import { emptyState, avatar } from '../components.js';
import { reportListFailure, adminError } from './shared.js';

import { statusChip } from '../components.js';

const GDPR_STATUSES = ['DELETION_REQUESTED', 'UNDER_REVIEW', 'DELETION_PROCESSING', 'DELETED', 'CANCELLED', 'REJECTED'];

function gdprRow(r, refresh) {
  const row = el('div', { class: 'card card--list--row' });
  row.appendChild(statusChip(r.status));
  if (r.requestedBy === 'GDPR') row.appendChild(statusChip('GDPR', 'REQUESTED BY GDPR'));

  const idt = el('div', { class: 'grow' });
  idt.append(
    el('div', { class: 'admin-name' }, esc(r.username || 'deleted account')),
    el('div', { class: 'muted small' }, 'Account ' + esc(r.userId) + ' · joined ' + fullTime(r.accountCreatedAt || r.requestedAt)),
    r.reason ? el('div', { class: 'muted small' }, 'Stated: ' + esc(String(r.reason).slice(0, 160))) : null,
    r.processedAt ? el('div', { class: 'muted small' }, 'Erased ' + fullTime(r.processedAt)) : null,
    r.reviewedAt ? el('div', { class: 'muted small' }, 'Reviewed ' + fullTime(r.reviewedAt)) : null,
  );
  row.appendChild(idt);
  row.appendChild(el('div', { class: 'muted small admin-when' }, relTime(r.requestedAt)));

  const acts = el('div', { class: 'card--list__actions' });
  if (r.status === 'DELETION_REQUESTED') {
    acts.append(
      el('button', {
        class: 'btn primary sm', type: 'button',
        onClick: () => reviewGdpr(r, 'APPROVE', refresh),
      }, 'Approve'),
      el('button', {
        class: 'btn sm', type: 'button',
        onClick: () => reviewGdpr(r, 'REJECT', refresh),
      }, 'Decline'));
  } else if (r.status === 'UNDER_REVIEW') {
    acts.appendChild(el('button', {
      class: 'btn danger sm', type: 'button',
      onClick: () => processGdpr(r, refresh),
    }, 'Erase account'));
  }
  if (acts.childElementCount) row.appendChild(acts);
  return row;
}

function reviewGdpr(r, decision, refresh) {
  const err = el('div', { class: 'form-error', hidden: true });
  const note = el('input', { class: 'input', type: 'text', placeholder: 'Note (optional, kept with the request)' });
  const approve = decision === 'APPROVE';
  const modal = openModal({
    title: (approve ? 'Approve' : 'Decline') + ' erasure request - ' + (r.username || r.userId),
    body: el('div', { class: 'admin-form' }, err,
      el('p', { class: 'muted small' }, approve
        ? 'Approving moves this to the processing queue. Nothing is erased until you run it.'
        : 'The user is told the request was declined and can submit a new one.'),
      el('div', { class: 'field' }, el('label', {}, 'Note'), note)),
    footer: [
      btn('Cancel', { variant: 'ghost', onClick: () => modal.close() }),
      el('button', { class: approve ? 'btn primary' : 'btn danger', type: 'button', onClick: submit },
        approve ? 'Approve' : 'Decline'),
    ],
  });
  async function submit() {
    err.hidden = true;
    try {
      await Api.adminReviewGdprRequest(r.id, decision, note.value);
      modal.close();
      toast(approve ? 'Approved. Run the erase to complete it.' : 'Request declined.', 'ok');
      refresh();
    } catch (ex) { err.hidden = false; err.textContent = adminError(ex, 'Failed to record the decision.'); }
  }
  return modal;
}

function processGdpr(r, refresh) {
  const err = el('div', { class: 'form-error', hidden: true });
  const modal = openModal({
    title: 'Erase this account?',
    body: el('div', { class: 'admin-form' }, err,
      el('p', {}, 'This erases the identity of ' + (r.username || r.userId) + ':'),
      el('p', { class: 'muted small' },
        'Username, email, display name, profile, avatar and banner, every uploaded file, and all sessions. '
        + 'Messages stay, attributed to a deleted account. Communities they owned are handed to their '
        + 'longest-standing member. Moderation and audit records that name them are kept.'),
      el('p', { class: 'muted small' }, 'This cannot be undone.')),
    footer: [
      btn('Cancel', { variant: 'ghost', onClick: () => modal.close() }),
      el('button', { class: 'btn danger', type: 'button', onClick: submit }, 'Erase account'),
    ],
  });
  async function submit() {
    err.hidden = true;
    try {
      const res = await Api.adminProcessGdprRequest(r.id);
      const rep = res.report || {};
      modal.close();
      toast('Erased ' + rep.username + '. ' + rep.objectsRemoved + ' object(s) removed, '
        + rep.messagesRedacted + ' message(s) kept as anonymous.', 'ok');
      refresh();
    } catch (ex) { err.hidden = false; err.textContent = adminError(ex, 'The erase failed.'); }
  }
  return modal;
}

export async function renderGdpr(sec) {
  sec.appendChild(el('h2', { class: 'section-label' }, 'Data subject requests'));
  sec.appendChild(el('p', { class: 'muted small' },
    'Erasure requests a user submitted from Settings → Account. They are created by the user, not by an administrator, and every one of them is a GDPR request.'));

  const sel = el('select', { class: 'select' });
  sel.appendChild(el('option', { value: '' }, 'All states'));
  for (const s of GDPR_STATUSES) sel.appendChild(el('option', { value: s }, s.replace(/_/g, ' ').toLowerCase()));

  const listWrap = el('div', { class: 'card-list' });
  sec.append(sel);
  sec.appendChild(listWrap);

  const render = async (status) => {
    listWrap.setAttribute('aria-busy', 'true');
    clear(listWrap);
    try {
      const rows = await Api.adminGdprRequests({ status: status || undefined });
      if (!rows.length) {
        listWrap.appendChild(emptyState('', 'No requests here.', status ? 'Change the filter to see other states.' : 'No one has requested deletion.'));
        return;
      }
      for (const r of rows) listWrap.appendChild(gdprRow(r, () => render(status)));
    } catch (ex) {
      listWrap.appendChild(el('p', { class: 'form-error' }, adminError(ex, 'Could not load GDPR requests.')));
    } finally {
      listWrap.removeAttribute('aria-busy');
    }
  };
  sel.addEventListener('change', () => render(sel.value).catch(reportListFailure(listWrap)));
  await render(sel.value);
}

import Api from '../api.js';
import { loadingState } from '../view-states.js';
import { esc, el, btn, clear, toast, openModal, relTime } from '../ui.js';
import { initialOf, emptyState, avatar } from '../components.js';
import { actionRow, adminError, currentSeq, debounced, reportListFailure } from './shared.js';

import { statusChip } from '../components.js';

function userRow(u, onChanged) {
  const row = el('div', { class: 'card card--list--row' });
  const who = el('div', { class: 'admin-avatar' }, initialOf(u.displayName || u.username));
  const idt = el('div', { class: 'grow' });
  idt.append(
    el('div', { class: 'admin-name' }, esc(u.displayName || u.username), ' ', el('span', { class: 'muted small' }, '@' + esc(u.username))),
    el('div', { class: 'muted small' }, 'Created ' + relTime(u.createdAt)));
  if (u.enforced) {
    idt.appendChild(el('div', { class: 'admin-row-state' }, statusChip(u.enforcement || 'ENFORCED')));
  }
  row.append(who, idt);

  const acts = el('div', { class: 'card--list__actions' });
  acts.appendChild(el('button', {
    class: 'btn sm ' + (u.enforced ? 'ghost' : 'danger'),
    type: 'button',
    onClick: () => userEnforceModal(u, onChanged),
  }, u.enforced ? 'Re-enforce' : 'Enforce'));
  if (u.enforced) {
    acts.appendChild(el('button', {
      class: 'btn sm ghost', type: 'button',
      onClick: () => liftUserModal(u, onChanged),
    }, 'Lift'));
  }
  acts.appendChild(el('button', {
    class: 'btn sm quiet', type: 'button', onClick: toggleHistory,
  }, 'History'));
  row.appendChild(acts);

  function toggleHistory() {
    const listRow = row.parentElement;
    const existing = listRow.querySelector('.admin-history');
    if (existing && existing.dataset.uid === u.id) { existing.remove(); return; }
    if (existing) existing.remove();
    const ph = el('div', { class: 'admin-history', dataset: { uid: u.id } }, loadingState('Loading history'));
    row.after(ph);
    Api.adminUserActions(u.id).then((actsList) => {
      clear(ph);
      if (!actsList || !actsList.length) ph.appendChild(el('div', { class: 'muted small' }, 'No moderation actions recorded.'));
      else for (const a of actsList) ph.appendChild(actionRow(a));
    }).catch((ex) => { clear(ph); ph.appendChild(el('div', { class: 'form-error' }, ex.message || 'Failed to load history.')); });
  }
  return row;
}

export async function renderUsers(body, show, seq) {
  const toolbar = el('div', { class: 'admin-toolbar' });
  const search = el('input', { class: 'input', type: 'search', placeholder: 'Search users by name…', 'aria-label': 'Search users' });
  toolbar.appendChild(search);
  const listWrap = el('div', { class: 'admin-list' });
  show(el('div', { class: 'admin-block admin-block--sections' }, toolbar, listWrap));
  const render = async (q) => {
    const found = await Api.adminUsers({ q });
    if (seq !== currentSeq()) return;
    clear(listWrap);
    if (!found || !found.length) {
      listWrap.appendChild(emptyState('', 'No users found.', 'Try a different search.'));
      return;
    }
    const refresh = () => render(search.value.trim());
    for (const u of found) listWrap.appendChild(userRow(u, refresh));
  };
  search.addEventListener('input', debounced(() => render(search.value.trim()).catch(reportListFailure(listWrap))));
  await render(search.value.trim());
}

// Exported because the reports console offers the same two actions on the same row.
// It called them without importing them, so both buttons threw a ReferenceError on
// click; they are module-private, which is why nothing noticed at load.
export function userEnforceModal(user, onDone) {
  const err = el('div', { class: 'form-error', hidden: true });
  const typeSel = el('select', { class: 'input' },
    el('option', { value: 'WARNING' }, 'Warning'),
    el('option', { value: 'SUSPENSION' }, 'Suspension (timed)'),
    el('option', { value: 'ACCOUNT_BAN' }, 'Account ban (permanent)'));
  const hours = el('input', { class: 'input', type: 'number', min: '1', step: '1', value: '24' });
  const hoursField = el('div', { class: 'field', hidden: true }, el('label', {}, 'Duration (hours)'), hours);
  const confirm = el('input', { type: 'checkbox' });
  const confirmField = el('label', { class: 'field row-line admin-confirm', hidden: true },
    confirm, el('span', {}, 'I confirm a permanent account ban. It invalidates all sessions and closes live sockets.'));
  const reason = el('textarea', { class: 'input', rows: 3, required: true, placeholder: 'Reason — recorded and visible in the user\u2019s enforcement record' });
  typeSel.addEventListener('change', () => {
    const t = typeSel.value;
    hoursField.hidden = t !== 'SUSPENSION';
    confirmField.hidden = t !== 'ACCOUNT_BAN';
  });
  const modal = openModal({
    title: 'Enforce — ' + (user.displayName || user.username),
    body: el('div', { class: 'admin-form' }, err,
      el('div', { class: 'field' }, el('label', {}, 'Action'), typeSel),
      hoursField, confirmField,
      el('div', { class: 'field' }, el('label', {}, 'Reason'), reason)),
    footer: [
      btn('Cancel', { variant: 'ghost', onClick: () => modal.close() }),
      el('button', { class: 'btn danger', type: 'button', onClick: submit }, 'Apply action'),
    ],
  });
  async function submit() {
    err.hidden = true;
    const reasonText = reason.value.trim();
    if (!reasonText) { err.hidden = false; err.textContent = 'A reason is required.'; return; }
    const actionType = typeSel.value;
    try {
      await Api.adminEnforceUser(user.id, actionType, reasonText, {
        hours: actionType === 'SUSPENSION' ? hours.value : undefined,
        confirm: actionType === 'ACCOUNT_BAN' && confirm.checked ? true : undefined,
      });
      modal.close();
      toast('Action applied.', 'ok');
      onDone();
    } catch (ex) { err.hidden = false; err.textContent = adminError(ex, 'Failed to apply action.'); }
  }
  return modal;
}

export function liftUserModal(user, onDone) {
  const err = el('div', { class: 'form-error', hidden: true });
  const reason = el('textarea', { class: 'input', rows: 2, required: true, placeholder: 'Reason for lifting enforcement' });
  const modal = openModal({
    title: 'Lift enforcement — ' + (user.displayName || user.username),
    body: el('div', { class: 'admin-form' }, err,
      el('div', { class: 'field' }, el('label', {}, 'Reason'), reason)),
    footer: [
      btn('Cancel', { variant: 'ghost', onClick: () => modal.close() }),
      el('button', { class: 'btn primary', type: 'button', onClick: submit }, 'Lift enforcement'),
    ],
  });
  async function submit() {
    err.hidden = true;
    const reasonText = reason.value.trim();
    if (!reasonText) { err.hidden = false; err.textContent = 'A reason is required.'; return; }
    try {
      await Api.adminLiftUser(user.id, reasonText);
      modal.close();
      toast('Enforcement lifted.', 'ok');
      onDone();
    } catch (ex) { err.hidden = false; err.textContent = adminError(ex, 'Failed to lift.'); }
  }
  return modal;
}

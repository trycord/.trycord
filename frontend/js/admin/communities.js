import Api from '../api.js';
import { loadingState } from '../view-states.js';
import { esc, el, btn, clear, toast, openModal, relTime } from '../ui.js';
import { initialOf, emptyState, avatar } from '../components.js';
import { actionRow, adminError, currentSeq, debounced, reportListFailure } from './shared.js';

function serverRow(s, onChanged) {
  const row = el('div', { class: 'card card--list--row' });
  const who = el('div', { class: 'admin-avatar' }, initialOf(s.name || s.id));
  const idt = el('div', { class: 'grow' });
  idt.append(
    el('div', { class: 'admin-name' }, esc(s.name || '(unnamed)'),
      s.owner_name ? el('span', { class: 'muted small' }, ' · @' + esc(s.owner_name)) : null),
    el('div', { class: 'muted small' }, (s.description ? esc(String(s.description).slice(0, 120)) + ' · ' : '') + 'Created ' + relTime(s.createdAt)));
  row.append(who, idt);
  if (s.enforcement_state === 'suspended') {
    row.appendChild(el('span', { class: 'status-chip suspended', title: s.enforcement_reason || '' }, 'SUSPENDED'));
  }

  const acts = el('div', { class: 'card--list__actions' });
  acts.append(
    el('button', { class: 'btn ghost sm', type: 'button', onClick: () => serverEnforceModal(s, onChanged) }, 'Suspend'),
    el('button', { class: 'btn ghost sm', type: 'button', onClick: () => serverLiftModal(s, onChanged) }, 'Lift'),
    el('button', { class: 'btn danger sm', type: 'button', onClick: () => serverRemoveModal(s, onChanged) }, 'Remove'),
    el('button', { class: 'btn ghost sm', type: 'button', onClick: toggleHistory }, 'History'));
  row.appendChild(acts);

  function toggleHistory() {
    const listRow = row.parentElement;
    const existing = listRow.querySelector('.admin-history');
    if (existing) existing.remove();
    if (existing && existing.dataset.sid === s.id) return;
    const ph = el('div', { class: 'admin-history', dataset: { sid: s.id } }, loadingState('Loading history'));
    row.after(ph);
    Api.adminServerActions(s.id).then((actsList) => {
      clear(ph);
      if (!actsList || !actsList.length) ph.appendChild(el('div', { class: 'muted small' }, 'No moderation actions recorded.'));
      else for (const a of actsList) ph.appendChild(actionRow(a));
    }).catch((ex) => { clear(ph); ph.appendChild(el('div', { class: 'form-error' }, ex.message || 'Failed to load history.')); });
  }
  return row;
}

export async function renderCommunities(body, show, seq) {
  const toolbar = el('div', { class: 'admin-toolbar' });
  const search = el('input', { class: 'input', type: 'search', placeholder: 'Search communities by name…', 'aria-label': 'Search communities' });
  toolbar.appendChild(search);
  const listWrap = el('div', { class: 'admin-list' });
  show(el('div', { class: 'admin-block admin-block--sections' }, toolbar, listWrap));
  const render = async (q) => {
    const found = await Api.adminServers({ q });
    if (seq !== currentSeq()) return;
    clear(listWrap);
    if (!found || !found.length) {
      listWrap.appendChild(emptyState('', 'No communities found.', 'Try a different search.'));
      return;
    }
    const refresh = () => render(search.value.trim());
    for (const s of found) listWrap.appendChild(serverRow(s, refresh));
  };
  search.addEventListener('input', debounced(() => render(search.value.trim()).catch(reportListFailure(listWrap))));
  await render(search.value.trim());
}

function serverEnforceModal(server, onDone) {
  const err = el('div', { class: 'form-error', hidden: true });
  const typeSel = el('select', { class: 'input' },
    el('option', { value: 'SERVER_SUSPENSION' }, 'Suspension'),
    el('option', { value: 'SERVER_REMOVAL' }, 'Removal (permanent)'));
  const confirm = el('input', { type: 'checkbox' });
  const confirmField = el('label', { class: 'field row-line admin-confirm', hidden: true },
    confirm, el('span', {}, 'I confirm permanent removal of this community and its data.'));
  const reason = el('textarea', { class: 'input', rows: 3, required: true, placeholder: 'Reason — recorded and audited' });
  typeSel.addEventListener('change', () => { confirmField.hidden = typeSel.value !== 'SERVER_REMOVAL'; });
  const modal = openModal({
    title: 'Enforce — ' + server.name,
    body: el('div', { class: 'admin-form' }, err,
      el('div', { class: 'field' }, el('label', {}, 'Action'), typeSel),
      confirmField,
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
      await Api.adminEnforceServer(server.id, actionType, reasonText, {
        confirm: actionType === 'SERVER_REMOVAL' && confirm.checked ? true : undefined,
      });
      modal.close();
      toast('Action applied.', 'ok');
      onDone();
    } catch (ex) { err.hidden = false; err.textContent = adminError(ex, 'Failed to apply action.'); }
  }
  return modal;
}

function serverLiftModal(server, onDone) {
  const err = el('div', { class: 'form-error', hidden: true });
  const reason = el('textarea', { class: 'input', rows: 2, required: true, placeholder: 'Reason for lifting enforcement' });
  const modal = openModal({
    title: 'Lift enforcement — ' + server.name,
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
      await Api.adminLiftServer(server.id, reasonText);
      modal.close();
      toast('Enforcement lifted.', 'ok');
      onDone();
    } catch (ex) { err.hidden = false; err.textContent = adminError(ex, 'Failed to lift.'); }
  }
  return modal;
}

function serverRemoveModal(server, onDone) {
  const err = el('div', { class: 'form-error', hidden: true });
  const reason = el('textarea', { class: 'input', rows: 3, required: true, placeholder: 'Removal reason — audited and final' });
  const confirm = el('input', { type: 'checkbox' });
  const modal = openModal({
    title: 'Remove community — ' + server.name,
    body: el('div', { class: 'admin-form' }, err,
      el('div', { class: 'field' }, el('label', {}, 'Reason'), reason),
      el('label', { class: 'field row-line admin-confirm' },
        confirm, el('span', {}, 'I confirm this removes the community and its content permanently.')),
      el('p', { class: 'muted small' }, 'This is irreversible. Members are removed and the community record is deleted.')),
    footer: [
      btn('Cancel', { variant: 'ghost', onClick: () => modal.close() }),
      el('button', { class: 'btn danger', type: 'button', onClick: submit }, 'Remove community'),
    ],
  });
  async function submit() {
    err.hidden = true;
    const reasonText = reason.value.trim();
    if (!reasonText) { err.hidden = false; err.textContent = 'A reason is required.'; return; }
    if (!confirm.checked) { err.hidden = false; err.textContent = 'Confirm the removal to continue.'; return; }
    try {
      await Api.adminEnforceServer(server.id, 'SERVER_REMOVAL', reasonText, { confirm: true });
      modal.close();
      toast('Community removed.', 'ok');
      onDone();
    } catch (ex) { err.hidden = false; err.textContent = adminError(ex, 'Failed to remove.'); }
  }
  return modal;
}

// The admin console.
//
// Every section renders what the API returns and never fabricates privileges.

import Api from '../api.js';
import { loadingState } from '../states.js';
import State from '../state.js';
import { esc, el, btn, clear, toast, openModal, confirmDialog, relTime, fullTime } from '../ui.js';
import { initialOf, emptyState } from '../components.js';
import { renderContextHeader } from '../shell.js';
import { settingsNav, settingsFrame } from '../settings-shell.js';
import { adminContext } from '../context-column.js';
import { navigate, route } from '../nav.js';;

const REPORT_STATUSES = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'DISMISSED'];
const APPEAL_STATUSES = ['OPEN', 'UNDER_REVIEW', 'APPROVED', 'DENIED'];


// captured sequence before touching the DOM so a slow response never writes
let adminSeq = 0;

function debounced(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function denied(msg) {
  return el('div', { class: 'empty-state' },
    el('div', { class: 'form-error' }, msg || 'You do not have platform administration access.'),
    el('div', { class: 'row-line' },
      el('button', { class: 'btn primary', type: 'button', onClick: () => { navigate('/home'); } }, 'Home')));
}

function loadError(ex, retry) {
  return el('div', { class: 'empty-state' },
    el('div', { class: 'form-error' }, (ex && ex.message) || 'Failed to load.'),
    el('button', { class: 'btn primary', type: 'button', onClick: retry }, 'Retry'));
}

export function statusChip(status, text) {
  const cls = String(status).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return el('span', { class: 'status-chip ' + cls }, text || String(status).replace(/_/g, ' '));
}

// server's own message so we never fabricate a cause.
function adminError(ex, fallback) {
  const code = ex && ex.code;
  if (code === 'AUTH_REQUIRED') return 'You need to sign in to perform this action.';
  if (code === 'PERMISSION_DENIED') return 'You do not have permission to perform this action.';
  if (code === 'NOT_FOUND' || code === 'SERVER_NOT_FOUND') return 'This community could not be found. It may already be gone.';
  if (code === 'USER_NOT_FOUND') return 'This account could not be found.';
  return (ex && ex.message) || fallback || 'The request could not be completed. Please try again.';
}

function statTile(label, value) {
  return el('div', { class: 'admin-stat' }, el('b', {}, value), el('span', {}, label));
}

function actionRow(a) {
  return el('div', { class: 'admin-history-row' },
    statusChip(a.actionType || 'ACTION'),
    el('div', { class: 'grow' },
      el('div', {}, esc(a.reason || '(no reason)')),
      el('div', { class: 'muted small' },
        (a.actor_name ? esc(a.actor_name) + ' · ' : '') + relTime(a.createdAt),
        a.expiresAt ? ' · expires ' + fullTime(a.expiresAt) : '')),
    el('div', { class: 'muted small admin-when' }, relTime(a.createdAt)));
}


async function renderOverview(body, show, seq) {
  const data = await Api.adminOverview();
  if (seq !== adminSeq) return;
  const grid = el('div', { class: 'admin-stats' });
  grid.append(
    statTile('Users', data.users),
    statTile('Communities', data.servers),
    statTile('Enforced accounts', data.enforcedUsers),
    statTile('Open reports', data.openReports),
    statTile('Open appeals', data.openAppeals));
  const recent = el('div', { class: 'admin-block' });
  recent.appendChild(el('div', { class: 'section-label' }, 'Recent audit activity'));
  if (!data.recentAudit || !data.recentAudit.length) {
    recent.appendChild(el('div', { class: 'muted small' }, 'No activity yet.'));
  } else {
    for (const a of data.recentAudit || []) {
      recent.appendChild(el('div', { class: 'admin-history-row' },
        statusChip(a.action),
        el('div', { class: 'grow' },
          el('div', {}, el('span', { class: 'muted small' }, esc(a.targetType || '') + ' '), esc(a.targetId || '')),
          el('div', { class: 'muted small' }, '…')),
        el('div', { class: 'muted small admin-when' }, relTime(a.createdAt))));
    }
  }
  recent.appendChild(el('div', { class: 'row-line admin-more' },
    el('button', { class: 'btn ghost sm', type: 'button', onClick: () => { navigate('/admin/audit'); } }, 'Open audit log')));
  show(el('div', { class: 'admin-block admin-block--sections' }, grid, recent));
}


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

async function renderUsers(body, show, seq) {
  const toolbar = el('div', { class: 'admin-toolbar' });
  const search = el('input', { class: 'input', type: 'search', placeholder: 'Search users by name…', 'aria-label': 'Search users' });
  toolbar.appendChild(search);
  const listWrap = el('div', { class: 'admin-list' });
  show(el('div', { class: 'admin-block admin-block--sections' }, toolbar, listWrap));
  const render = async (q) => {
    const found = await Api.adminUsers({ q });
    if (seq !== adminSeq) return;
    clear(listWrap);
    if (!found || !found.length) {
      listWrap.appendChild(emptyState('', 'No users found.', 'Try a different search.'));
      return;
    }
    const refresh = () => render(search.value.trim());
    for (const u of found) listWrap.appendChild(userRow(u, refresh));
  };
  search.addEventListener('input', debounced(() => render(search.value.trim())));
  await render(search.value.trim());
}


function userEnforceModal(user, onDone) {
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

function liftUserModal(user, onDone) {
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

async function renderCommunities(body, show, seq) {
  const toolbar = el('div', { class: 'admin-toolbar' });
  const search = el('input', { class: 'input', type: 'search', placeholder: 'Search communities by name…', 'aria-label': 'Search communities' });
  toolbar.appendChild(search);
  const listWrap = el('div', { class: 'admin-list' });
  show(el('div', { class: 'admin-block admin-block--sections' }, toolbar, listWrap));
  const render = async (q) => {
    const found = await Api.adminServers({ q });
    if (seq !== adminSeq) return;
    clear(listWrap);
    if (!found || !found.length) {
      listWrap.appendChild(emptyState('', 'No communities found.', 'Try a different search.'));
      return;
    }
    const refresh = () => render(search.value.trim());
    for (const s of found) listWrap.appendChild(serverRow(s, refresh));
  };
  search.addEventListener('input', debounced(() => render(search.value.trim())));
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

async function renderReports(body, show, seq) {
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
    const found = await Api.adminReports({ status });
    if (seq !== adminSeq) return;
    clear(listWrap);
    if (!found || !found.length) { listWrap.appendChild(emptyState('', 'No reports here.', 'Change the filter to see other cases.')); return; }
    for (const r of found) listWrap.appendChild(reportRow(r, () => render(sel.value)));
  };
  sel.addEventListener('change', () => render(sel.value));
  await render(sel.value);
}


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

async function renderGdpr(sec) {
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
  sel.addEventListener('change', () => render(sel.value));
  await render(sel.value);
}


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

async function renderAppeals(body, show, seq) {
  const toolbar = el('div', { class: 'admin-toolbar' });
  const sel = el('select', { class: 'input', 'aria-label': 'Filter appeals by status' },
    el('option', { value: '' }, 'All statuses'),
    APPEAL_STATUSES.map((s) => el('option', { value: s }, s)));
  toolbar.appendChild(sel);
  const listWrap = el('div', { class: 'admin-list' });
  show(el('div', { class: 'admin-block admin-block--sections' }, toolbar, listWrap));
  const render = async (status) => {
    const found = await Api.adminAppeals({ status });
    if (seq !== adminSeq) return;
    clear(listWrap);
    if (!found || !found.length) { listWrap.appendChild(emptyState('', 'No appeals here.', 'Change the filter to see other cases.')); return; }
    for (const a of found) listWrap.appendChild(appealRow(a, () => render(sel.value)));
  };
  sel.addEventListener('change', () => render(sel.value));
  await render(sel.value);
}


function auditRow(a) {
  const row = el('div', { class: 'card card--list--row' });
  row.appendChild(statusChip(a.action));
  const idt = el('div', { class: 'grow' });
  idt.append(
    el('div', { class: 'admin-name' }, libChip(a.target_type), ' ', el('span', { class: 'muted small' }, '#' + esc(a.target_id))),
    el('div', { class: 'muted small' }, (a.actor_name ? 'by ' + esc(a.actor_name) : esc(a.actor_id || '')) + (a.target_name ? ' · ' + esc(a.target_name) : '')),
    a.reason ? el('div', { class: 'muted small' }, esc(String(a.reason).slice(0, 160))) : null);
  row.appendChild(idt);
  row.appendChild(el('div', { class: 'muted small admin-when' }, relTime(a.created_at)));
  row.title = fullTime(a.created_at);
  return row;
}

function libChip(type) {
  return el('span', { class: 'admin-tag' }, esc(type || ''));
}

async function renderAudit(body, show, seq) {
  const toolbar = el('div', { class: 'admin-toolbar' });
  const search = el('input', { class: 'input', type: 'search', placeholder: 'Filter by action, e.g. MODERATION_ACCOUNT_BAN…', 'aria-label': 'Filter audit log by action' });
  const info = el('span', { class: 'muted small' }, 'This instance keeps the most recent entries per query.');
  toolbar.append(search, info);
  const listWrap = el('div', { class: 'admin-list' });
  show(el('div', { class: 'admin-block admin-block--sections' }, toolbar, listWrap));
  const render = async (action) => {
    const found = await Api.adminAudit({ action });
    if (seq !== adminSeq) return;
    clear(listWrap);
    if (!found || !found.length) { listWrap.appendChild(emptyState('', 'No audit entries.', 'Try a different action filter.')); return; }
    for (const a of found) listWrap.appendChild(auditRow(a));
  };
  search.addEventListener('input', debounced(() => render(search.value.trim().toUpperCase())));
  await render(search.value.trim().toUpperCase());
}


async function renderAnnouncements(body, show, seq) {
  const listWrap = el('div', { class: 'admin-list' });
  const editor = el('div', { class: 'admin-block' });

  const text = el('textarea', { class: 'input', rows: 3, maxlength: 500, placeholder: 'What should everyone on this instance know?' });
  const level = el('select', { class: 'input' },
    el('option', { value: 'info' }, 'Info'),
    el('option', { value: 'warning' }, 'Warning'),
    el('option', { value: 'critical' }, 'Critical'));
  const linkLabel = el('input', { class: 'input', type: 'text', maxlength: 64, placeholder: 'Link text (optional)' });
  const linkHref = el('input', { class: 'input', type: 'text', placeholder: '/#/support' });
  const expires = el('input', { class: 'input', type: 'datetime-local' });
  const err = el('div', { class: 'form-error', hidden: true });
  const save = el('button', { class: 'btn primary', type: 'button' }, 'Publish banner');

  const form = el('form', { class: 'settings-form' },
    el('div', { class: 'field' }, el('label', {}, 'Message'), text,
      el('span', { class: 'hint' }, 'Shown to every signed-in user on this instance until you retire it.')),
    el('div', { class: 'field' }, el('label', {}, 'Level'), level),
    el('div', { class: 'field' }, el('label', {}, 'Link label'), linkLabel),
    el('div', { class: 'field' }, el('label', {}, 'Link'), linkHref,
      el('span', { class: 'hint' }, 'Relative path only, e.g. /#/support. Leave empty for no link.')),
    el('div', { class: 'field' }, el('label', {}, 'Expires'), expires,
      el('span', { class: 'hint' }, 'Optional. Leave empty to run until you retire it.')),
    err,
    el('div', {}, save));

  save.addEventListener('click', async () => {
    err.hidden = true;
    save.disabled = true;
    try {
      await Api.createAnnouncement({
        body: text.value,
        level: level.value,
        linkLabel: linkLabel.value,
        linkHref: linkHref.value,
        expiresAt: expires.value ? new Date(expires.value).toISOString() : null,
      });
      text.value = ''; linkLabel.value = ''; linkHref.value = ''; expires.value = '';
      await loadList();
    } catch (ex) {
      err.hidden = false;
      err.textContent = (ex && ex.message) || 'Could not publish the banner.';
    } finally { save.disabled = false; }
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); save.click(); });

  editor.appendChild(el('div', { class: 'section-label' }, 'New banner'));
  editor.appendChild(form);

  const rowFor = (a) => {
    const row = el('div', { class: 'card card--list--row' });
    const main = el('div', { class: 'grow' });
    main.appendChild(el('div', { class: 'admin-name' }, a.body));
    const meta = [a.level, a.expiresAt ? 'expires ' + fullTime(a.expiresAt) : 'no expiry'];
    main.appendChild(el('div', { class: 'muted small' }, meta.join(' · ') + (a.active ? '' : ' · retired')));
    row.appendChild(main);

    const acts = el('div', { class: 'card--list__actions' });
    acts.appendChild(el('button', {
      class: 'btn sm ' + (a.active ? 'ghost' : 'primary'), type: 'button',
      onClick: async () => {
        try { await Api.updateAnnouncement(a.id, { active: !a.active }); await loadList(); }
        catch (ex) { toast(ex.message || 'Could not update.', 'error'); }
      },
    }, a.active ? 'Retire' : 'Republish'));
    acts.appendChild(el('button', {
      class: 'btn sm danger', type: 'button',
      onClick: () => confirmDialog({
        title: 'Delete this banner?', message: 'It disappears for everyone immediately.',
        danger: true, confirmText: 'Delete',
        onConfirm: async () => {
          try { await Api.deleteAnnouncement(a.id); await loadList(); }
          catch (ex) { toast(ex.message || 'Could not delete.', 'error'); }
        },
      }),
    }, 'Delete'));
    row.appendChild(acts);
    return row;
  };

  const loadList = async () => {
    let all = [];
    try { all = await Api.allAnnouncements(); }
    catch (ex) { listWrap.appendChild(emptyState('', 'Could not load banners.', (ex && ex.message) || '')); return; }
    clear(listWrap);
    if (!all || !all.length) {
      listWrap.appendChild(emptyState('', 'No banners yet.', 'Publish one above to notify everyone on this instance.'));
      return;
    }
    for (const a of all) listWrap.appendChild(rowFor(a));
  };

  show(el('div', { class: 'admin-block admin-block--sections' },
    editor,
    el('div', { class: 'admin-block' },
      el('div', { class: 'section-label' }, 'Published banners'),
      listWrap)));
  await loadList();
}


// Pages is a separate module rather than one more branch of renderAdmin: the
// router sends /admin/pages to renderAdminPages. It still needs a place in the
// nav, and the IA is where that place lives now.
const EXTERNAL_SECTIONS = new Set(['pages']);

// Shared with pages-admin-pages.js, which is a separate route and would
// otherwise have no way back to the rest of the dashboard.
export function renderAdminNav(current) {
  return settingsNav({ scope: 'admin', active: current });
}

export async function renderAdmin(container, { section = 'overview' } = {}) {
  clear(container);
  renderContextHeader({ title: 'Admin', sub: 'Platform trust, safety, and enforcement' });

  // The section title is the pane's heading rather than a page-level h1, so the
  // nav and the content read as one surface instead of a title stacked above a
  // nav stacked above the content.
  const { frame, pane, context } = settingsFrame({
    scope: 'admin',
    active: section,
    contentClass: 'admin-page',
  });
  const body = pane;
  const wrap = el('div', { class: 'page admin' }, frame);
  container.appendChild(wrap);

  // isAdmin is server-computed on /me; refresh it here so a session started
  let me = State.me;
  if (!me || me.isAdmin !== true) {
    const fresh = await Api.me().catch(() => null);
    if (fresh) { State.me = fresh; me = fresh; }
  }
  if (!me || me.isAdmin !== true) { body.appendChild(denied()); return; }

  const seq = ++adminSeq;
  const show = (node) => { if (seq === adminSeq) { clear(body); body.appendChild(node); } };
  // node must not linger in body: give them a fresh container that show()
  const sec = el('div', { class: 'admin-block' });
  const showSec = (node) => { if (seq === adminSeq) { clear(sec); sec.appendChild(node); } };
  show(sec);
  sec.appendChild(loadingState('Loading'));
  try {
    if (section === 'users') await renderUsers(sec, showSec, seq);
    else if (section === 'communities') await renderCommunities(sec, showSec, seq);
    else if (section === 'reports') await renderReports(sec, showSec, seq);
    else if (section === 'appeals') await renderAppeals(sec, showSec, seq);
    else if (section === 'gdpr') await renderGdpr(sec);
    else if (section === 'audit') await renderAudit(sec, showSec, seq);
    else if (section === 'announcements') await renderAnnouncements(sec, showSec, seq);
    else await renderOverview(sec, showSec, seq);
    await fillAdminContext(context, section);
  } catch (ex) {
    if (seq !== adminSeq) return;
    clear(body);
    if (ex && (ex.code === 'PERMISSION_DENIED' || ex.code === 'AUTH_REQUIRED')) body.appendChild(denied());
    else body.appendChild(loadError(ex, () => { clear(container); renderAdmin(container, { section }); }));
  }
}

// Painted after the section so the column reads the same instance the list does.
// A failure here must not take the console down with it.
async function fillAdminContext(host, section) {
  if (!host) return;
  try {
    const nodes = await adminContext(section);
    for (const n of nodes) host.appendChild(n);
    if (nodes.length) host.closest('.settings-layout').dataset.hasContext = 'yes';
  } catch { /* a summary is a convenience, never a dependency */ }
}

export default { renderAdmin, renderAdminNav };

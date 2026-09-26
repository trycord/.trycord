// Platform Administration. Backed by the real /api/admin/* endpoints
// (adminGuard on the server is the single source of truth — this client only
// renders what the API returns and never fabricates privileges). Sections:
// Overview, Users, Communities, Reports, Appeals, Audit log.

import Api from './api.js';
import State from './state.js';
import { esc, el, clear, toast, openModal, relTime, fullTime } from './ui.js';
import { initialOf, emptyState } from './components.js';
import { renderContextHeader } from './shell.js';

const REPORT_STATUSES = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'DISMISSED'];
const APPEAL_STATUSES = ['OPEN', 'UNDER_REVIEW', 'APPROVED', 'DENIED'];

const SECTIONS = [
  { id: 'overview', label: 'Overview', href: '#/admin' },
  { id: 'users', label: 'Users', href: '#/admin/users' },
  { id: 'communities', label: 'Communities', href: '#/admin/communities' },
  { id: 'reports', label: 'Reports', href: '#/admin/reports' },
  { id: 'appeals', label: 'Appeals', href: '#/admin/appeals' },
  { id: 'audit', label: 'Audit log', href: '#/admin/audit' },
];

// Stale-request guard: each route render bumps this; async work checks its
// captured sequence before touching the DOM so a slow response never writes
// over a newer view.
let adminSeq = 0;

function debounced(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function adminTabs(active) {
  const tabs = el('div', { class: 'settings-nav' });
  for (const s of SECTIONS) {
    const b = el('button', { class: 'btn ' + (active === s.id ? 'active' : 'ghost'), type: 'button' }, s.label);
    b.addEventListener('click', () => { location.hash = s.href; });
    tabs.appendChild(b);
  }
  return tabs;
}

function denied(msg) {
  return el('div', { class: 'empty-state' },
    el('div', { class: 'form-error' }, msg || 'You do not have platform administration access.'),
    el('div', { class: 'row-line' },
      el('button', { class: 'btn primary', type: 'button', onClick: () => { location.hash = '#/home'; } }, 'Home')));
}

function loadError(ex, retry) {
  return el('div', { class: 'empty-state' },
    el('div', { class: 'form-error' }, (ex && ex.message) || 'Failed to load.'),
    el('button', { class: 'btn primary', type: 'button', onClick: retry }, 'Retry'));
}

function statusChip(status) {
  const cls = String(status).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return el('span', { class: 'admin-chip ' + cls }, status);
}

// Translate server error codes into plain hoster language. Only maps codes
// whose meaning is unambiguous; everything else falls through to the
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
    el('div', { class: 'grow', style: { overflow: 'hidden' } },
      el('div', {}, esc(a.reason || '(no reason)')),
      el('div', { class: 'muted small' },
        (a.actor_name ? esc(a.actor_name) + ' · ' : '') + relTime(a.createdAt),
        a.expiresAt ? ' · expires ' + fullTime(a.expiresAt) : '')),
    el('div', { class: 'muted small', style: { whiteSpace: 'nowrap' } }, relTime(a.createdAt)));
}

// ---- overview -------------------------------------------------------------

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
        el('div', { class: 'grow', style: { overflow: 'hidden' } },
          el('div', {}, el('span', { class: 'muted small' }, esc(a.targetType || '') + ' '), esc(a.targetId || '')),
          el('div', { class: 'muted small' }, '…')),
        el('div', { class: 'muted small', style: { whiteSpace: 'nowrap' } }, relTime(a.createdAt))));
    }
  }
  recent.appendChild(el('div', { class: 'row-line', style: { marginTop: '10px' } },
    el('button', { class: 'btn ghost sm', type: 'button', onClick: () => { location.hash = '#/admin/audit'; } }, 'Open audit log')));
  show(el('div', {}, grid, recent));
}

// ---- users ----------------------------------------------------------------

function userRow(u, onChanged) {
  const row = el('div', { class: 'admin-row' });
  const who = el('div', { class: 'admin-avatar' }, initialOf(u.displayName || u.username));
  const idt = el('div', { class: 'grow', style: { overflow: 'hidden' } });
  idt.append(
    el('div', { class: 'admin-name' }, esc(u.displayName || u.username), ' ', el('span', { class: 'muted small' }, '@' + esc(u.username))),
    el('div', { class: 'muted small' }, 'Created ' + relTime(u.createdAt)));
  row.append(who, idt);
  if (u.enforced) row.appendChild(statusChip(u.enforcement || 'ENFORCED'));

  const acts = el('div', { class: 'row-line', style: { gap: '6px', flexWrap: 'wrap' } });
  acts.append(
    el('button', { class: 'btn ghost sm', type: 'button', onClick: () => userEnforceModal(u, onChanged) }, u.enforced ? 'Re-enforce' : 'Enforce'),
    el('button', { class: 'btn ghost sm', type: 'button', onClick: () => liftUserModal(u, onChanged) }, 'Lift'),
    el('button', { class: 'btn ghost sm', type: 'button', onClick: toggleHistory }, 'History'));
  row.appendChild(acts);

  function toggleHistory() {
    const listRow = row.parentElement;
    const existing = listRow.querySelector('.admin-history');
    if (existing && existing.dataset.uid === u.id) { existing.remove(); return; }
    if (existing) existing.remove();
    const ph = el('div', { class: 'admin-history', dataset: { uid: u.id } }, 'Loading history…');
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
  body.append(toolbar, listWrap);
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

// ---- enforcement modals (user) ---------------------------------------------

function userEnforceModal(user, onDone) {
  const err = el('div', { class: 'form-error', hidden: true });
  const typeSel = el('select', { class: 'input' },
    el('option', { value: 'WARNING' }, 'Warning'),
    el('option', { value: 'SUSPENSION' }, 'Suspension (timed)'),
    el('option', { value: 'ACCOUNT_BAN' }, 'Account ban (permanent)'));
  const hours = el('input', { class: 'input', type: 'number', min: '1', step: '1', value: '24' });
  const hoursField = el('div', { class: 'field', hidden: true }, el('label', {}, 'Duration (hours)'), hours);
  const confirm = el('input', { type: 'checkbox' });
  const confirmField = el('label', { class: 'field row-line', style: { gap: '8px', alignItems: 'center' }, hidden: true },
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
      el('button', { class: 'btn ghost', type: 'button', onClick: () => modal.close() }, 'Cancel'),
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
      el('button', { class: 'btn ghost', type: 'button', onClick: () => modal.close() }, 'Cancel'),
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

// ---- communities ------------------------------------------------------------

function serverRow(s, onChanged) {
  const row = el('div', { class: 'admin-row' });
  const who = el('div', { class: 'admin-avatar' }, initialOf(s.name || s.id));
  const idt = el('div', { class: 'grow', style: { overflow: 'hidden' } });
  idt.append(
    el('div', { class: 'admin-name' }, esc(s.name || '(unnamed)'),
      s.owner_name ? el('span', { class: 'muted small' }, ' · @' + esc(s.owner_name)) : null),
    el('div', { class: 'muted small' }, (s.description ? esc(String(s.description).slice(0, 120)) + ' · ' : '') + 'Created ' + relTime(s.createdAt)));
  row.append(who, idt);
  if (s.enforcement_state === 'suspended') {
    row.appendChild(el('span', { class: 'admin-chip suspended', title: s.enforcement_reason || '' }, 'SUSPENDED'));
  }

  const acts = el('div', { class: 'row-line', style: { gap: '6px', flexWrap: 'wrap' } });
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
    const ph = el('div', { class: 'admin-history', dataset: { sid: s.id } }, 'Loading history…');
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
  body.append(toolbar, listWrap);
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
  const confirmField = el('label', { class: 'field row-line', style: { gap: '8px', alignItems: 'center' }, hidden: true },
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
      el('button', { class: 'btn ghost', type: 'button', onClick: () => modal.close() }, 'Cancel'),
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
      el('button', { class: 'btn ghost', type: 'button', onClick: () => modal.close() }, 'Cancel'),
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
      el('label', { class: 'field row-line', style: { gap: '8px', alignItems: 'center' } },
        confirm, el('span', {}, 'I confirm this removes the community and its content permanently.')),
      el('p', { class: 'muted small' }, 'This is irreversible. Members are removed and the server record is deleted.')),
    footer: [
      el('button', { class: 'btn ghost', type: 'button', onClick: () => modal.close() }, 'Cancel'),
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

// ---- reports ---------------------------------------------------------------

function reportRow(r, refresh) {
  const row = el('div', { class: 'admin-row' });
  row.appendChild(statusChip(r.status));
  const idt = el('div', { class: 'grow', style: { overflow: 'hidden' } });
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
  const det = el('div', { class: 'admin-detail' }, 'Loading detail…');
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
    const rowLine = el('div', { class: 'row-line', style: { gap: '6px', flexWrap: 'wrap' } });
    rowLine.append(sel, note, updateBtn);
    det.appendChild(rowLine);
    det.appendChild(targetBlock(full, refresh));
  } catch (ex) {
    clear(det);
    det.appendChild(el('div', { class: 'form-error' }, ex.message || 'Failed to load detail.'));
  }
}

function targetBlock(full, refresh) {
  const wrap = el('div', { class: 'row-line', style: { gap: '6px', flexWrap: 'wrap', marginTop: '8px' } });
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
  toolbar.append(sel, el('span', { class: 'muted small' }, 'Reports stay scoped: reviewers see actionable cases only.'));
  const listWrap = el('div', { class: 'admin-list' });
  body.append(toolbar, listWrap);
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

// ---- appeals ---------------------------------------------------------------

function appealRow(a, refresh) {
  const row = el('div', { class: 'admin-row' });
  row.appendChild(statusChip(a.status));
  const idt = el('div', { class: 'grow', style: { overflow: 'hidden' } });
  idt.append(
    el('div', { class: 'admin-name' }, esc(a.user_name || a.user_id), ' ', el('span', { class: 'muted small' }, '· ' + esc(a.action_type))),
    el('div', { class: 'muted small' }, 'Action: ' + esc(String(a.action_reason || '').slice(0, 90))),
    el('div', { class: 'muted small' }, 'Appeal: ' + esc(String(a.reason || '').slice(0, 90))));
  row.appendChild(idt);
  row.appendChild(el('div', { class: 'muted small', style: { whiteSpace: 'nowrap' } }, relTime(a.created_at)));
  const decided = a.status === 'APPROVED' || a.status === 'DENIED';
  if (!decided) {
    const acts = el('div', { class: 'row-line', style: { gap: '6px' } });
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
      el('button', { class: 'btn ghost', type: 'button', onClick: () => modal.close() }, 'Cancel'),
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
  body.append(toolbar, listWrap);
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

// ---- audit -----------------------------------------------------------------

function auditRow(a) {
  const row = el('div', { class: 'admin-row' });
  row.appendChild(statusChip(a.action));
  const idt = el('div', { class: 'grow', style: { overflow: 'hidden' } });
  idt.append(
    el('div', { class: 'admin-name' }, libChip(a.target_type), ' ', el('span', { class: 'muted small' }, '#' + esc(a.target_id))),
    el('div', { class: 'muted small' }, (a.actor_name ? 'by ' + esc(a.actor_name) : esc(a.actor_id || '')) + (a.target_name ? ' · ' + esc(a.target_name) : '')),
    a.reason ? el('div', { class: 'muted small' }, esc(String(a.reason).slice(0, 160))) : null);
  row.appendChild(idt);
  row.appendChild(el('div', { class: 'muted small', style: { whiteSpace: 'nowrap' } }, relTime(a.created_at)));
  row.title = fullTime(a.created_at);
  return row;
}

function libChip(type) {
  return el('span', { class: 'admin-tag' }, esc(type || ''));
}

async function renderAudit(body, show, seq) {
  const toolbar = el('div', { class: 'admin-toolbar' });
  const search = el('input', { class: 'input', type: 'search', placeholder: 'Filter by action, e.g. MODERATION_ACCOUNT_BAN…', 'aria-label': 'Filter audit log by action' });
  const info = el('span', { class: 'muted small' }, 'Server keeps the most recent entries per query.');
  toolbar.append(search, info);
  const listWrap = el('div', { class: 'admin-list' });
  body.append(toolbar, listWrap);
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

// ---- entry -----------------------------------------------------------------

export async function renderAdmin(container, { section = 'overview' } = {}) {
  clear(container);
  renderContextHeader({ title: 'Admin', sub: 'Platform trust, safety, and enforcement' });
  const wrap = el('div', { class: 'page atrium' });
  wrap.appendChild(adminTabs(section));
  const body = el('div', { class: 'admin-page' });
  wrap.appendChild(body);
  container.appendChild(wrap);

  // isAdmin is server-computed on /me; refresh it here so a session started
  // before the flag existed still resolves correctly. Guard logic stays on
  // the API — this only decides what the page renders.
  let me = State.me;
  if (!me || me.isAdmin !== true) {
    const fresh = await Api.me().catch(() => null);
    if (fresh) { State.me = fresh; me = fresh; }
  }
  if (!me || me.isAdmin !== true) { body.appendChild(denied()); return; }

  const seq = ++adminSeq;
  const show = (node) => { if (seq === adminSeq) { clear(body); body.appendChild(node); } };
  show(el('div', { class: 'empty-state' }, 'Loading…'));
  try {
    if (section === 'users') await renderUsers(body, show, seq);
    else if (section === 'communities') await renderCommunities(body, show, seq);
    else if (section === 'reports') await renderReports(body, show, seq);
    else if (section === 'appeals') await renderAppeals(body, show, seq);
    else if (section === 'audit') await renderAudit(body, show, seq);
    else await renderOverview(body, show, seq);
  } catch (ex) {
    if (seq !== adminSeq) return;
    clear(body);
    if (ex && (ex.code === 'PERMISSION_DENIED' || ex.code === 'AUTH_REQUIRED')) body.appendChild(denied());
    else body.appendChild(loadError(ex, () => { clear(container); renderAdmin(container, { section }); }));
  }
}

export default { renderAdmin };
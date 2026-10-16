// Instance administration.
//
// The console for the people who run this deployment. It is a separate scope
// from account settings because it answers a different question - what is
// happening here - and every page is gated by the server, not by a flag in the
// client.

import { el, clear } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { avatar, serverMark } from '../components.js';
import { nameOf } from '../../packages/store.js';
import Api from '../../packages/api.js';
import { path, navigate } from '../../packages/nav.js';
import { scopeNav } from '../../packages/registry.js';
import { toast, errorToast, confirmDialog, openDialog, openMenu } from '../ui.js';
import { page, band, panel, prow, notice, section, loading, failure, nothing, empty, relative, stat } from './util.js';
import { continuumSection } from './continuum.js';

// -- shared furniture --------------------------------------------------------

function adminNav(activeId) {
  const nav = el('nav', { class: 'settings-nav', 'aria-label': 'Administration' });
  for (const group of scopeNav('admin')) {
    nav.appendChild(el('div', { class: 'settings-nav-group' },
      group.group ? el('div', { class: 'split-label' }, group.group) : null,
      el('div', { class: 'settings-nav-list' },
        group.items.map((item) => prow({
          href: path(item.route),
          lead: icon(item.icon, { size: 17 }),
          title: item.label,
          active: item.id === activeId,
        })))));
  }
  return nav;
}

function clearAnd(host, node) {
  clear(host);
  host.appendChild(node);
}

function reportCard(title, lines) {
  const card = el('div', { class: 'settings-card' });
  card.appendChild(el('div', { class: 'field-label' }, title));
  for (const line of lines) if (line) card.appendChild(line);
  return card;
}

function labelled(labelText, control) {
  return el('label', { class: 'field' }, el('span', { class: 'field-label' }, labelText), control);
}

function actionButton(label, kind, onClick) {
  return el('button', { class: 'btn btn--' + kind + ' btn--sm', type: 'button', onClick }, label);
}

// -- overview ----------------------------------------------------------------

function overviewSection() {
  const host = el('div', { class: 'settings-stack' });

  async function load() {
    host.replaceChildren(loading('Loading the overview'));
    try {
      const out = await Api.adminOverview();
      const stats = el('div', { class: 'stats settings-card' },
        stat(out.users, 'People'),
        stat(out.servers, 'Communities'),
        stat(out.openReports, 'Open reports'),
        stat(out.openAppeals, 'Open appeals'),
        stat(out.enforcedUsers, 'Enforced accounts'));
      const recent = el('div', { class: 'rows' });
      for (const row of out.recentAudit || []) {
        recent.appendChild(el('div', { class: 'row-item' },
          el('span', { class: 'row-item-icon' }, icon('activity', { size: 16 })),
          el('div', { class: 'row-item-main' },
            el('div', { class: 'row-item-title truncate' }, String(row.action || '')),
            el('div', { class: 'row-item-sub' }, (row.targetType || '') + ' - ' + (row.targetId || ''))),
          el('span', { class: 'row-item-sub' }, relative(row.createdAt))));
      }
      clearAnd(host, stats);
      host.appendChild(section('Recent activity', recent));
    } catch (error) {
      clearAnd(host, failure(error, load));
    }
  }

  load();
  return host;
}

// -- people ------------------------------------------------------------------

function usersSection() {
  const host = el('div', { class: 'settings-stack' });
  const search = el('input', { class: 'input', placeholder: 'Search by username', type: 'search' });
  const results = el('div', { class: 'rows' });
  host.append(search, results);

  let timer = 0;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => load(search.value.trim()), 250);
  });

  async function load(q) {
    results.replaceChildren(loading('Searching'));
    try {
      const rows = await Api.adminUsers({ q: q || '' });
      clear(results);
      if (!rows.length) { results.appendChild(nothing('No accounts match', null)); return; }
      for (const user of rows) results.appendChild(rowFor(user));
    } catch (error) { results.replaceChildren(failure(error, () => load(q))); }
  }

  function rowFor(user) {
    const stateLabel = user.enforcement_state || user.enforcementState || 'active';
    return el('div', { class: 'row-item' },
      avatar({ id: user.id, username: user.username, displayName: user.display_name || user.displayName }, { size: 'sm' }),
      el('div', { class: 'row-item-main' },
        el('div', { class: 'row-item-title truncate' }, nameOf({ username: user.username, displayName: user.display_name || user.displayName })),
        el('div', { class: 'row-item-sub truncate' }, '@' + user.username + ' - ' + stateLabel)),
      el('div', { class: 'row-item-actions' },
        actionButton('Actions', 'ghost', (event) => openUserMenu(event.currentTarget, user))));
  }

  function openUserMenu(anchor, user) {
    openMenu({ anchor, items: menuFor(user), align: 'right' });
  }

  function menuFor(user) {
    return [
      { header: nameOf({ username: user.username, displayName: user.display_name }) },
      { label: 'Suspend', icon: 'clock', onSelect: () => promptEnforce(user, 'USER_SUSPENSION') },
      { label: 'Ban', icon: 'ban', danger: true, onSelect: () => promptEnforce(user, 'USER_BAN') },
      { label: 'Lift enforcement', icon: 'check', onSelect: () => promptLift(user) },
    ];
  }

  function promptEnforce(user, actionType) {
    const reason = el('input', { class: 'input' });
    const minutes = el('input', { class: 'input', type: 'number', min: '1', value: '1440' });
    const dialog = openDialog({
      title: actionType === 'USER_BAN' ? 'Ban this account' : 'Suspend this account',
      foot: [
        { label: 'Cancel', kind: 'ghost', onClick: () => dialog.close() },
        { label: 'Apply', kind: 'danger', onClick: async (event) => {
          event.currentTarget.disabled = true;
          try {
            const body = { actionType, reason: reason.value };
            if (actionType === 'USER_SUSPENSION') body.durationMinutes = Number(minutes.value) || 1440;
            await Api.adminEnforceUser(user.id, body);
            dialog.close(); toast('Applied.', { type: 'success' }); load(search.value.trim());
          } catch (error) { errorToast(error); } finally { event.currentTarget.disabled = false; }
        } },
      ],
    });
    const body = el('div', { class: 'dialog-body' }, labelled('Reason', reason));
    if (actionType === 'USER_SUSPENSION') body.appendChild(labelled('Minutes', minutes));
    dialog.element.insertBefore(body, dialog.element.querySelector('.dialog-foot'));
  }

  async function promptLift(user) {
    const reason = el('input', { class: 'input' });
    const dialog = openDialog({
      title: 'Lift enforcement',
      foot: [
        { label: 'Cancel', kind: 'ghost', onClick: () => dialog.close() },
        { label: 'Lift', kind: 'primary', onClick: async (event) => {
          event.currentTarget.disabled = true;
          try { await Api.adminLiftUser(user.id, reason.value); dialog.close(); toast('Lifted.', { type: 'success' }); load(search.value.trim()); }
          catch (error) { errorToast(error); } finally { event.currentTarget.disabled = false; }
        } },
      ],
    });
    dialog.element.insertBefore(el('div', { class: 'dialog-body' }, labelled('Reason', reason)), dialog.element.querySelector('.dialog-foot'));
  }

  load('');
  return host;
}

// -- communities -------------------------------------------------------------

function communitiesSection() {
  const host = el('div', { class: 'settings-stack' });
  const search = el('input', { class: 'input', placeholder: 'Search communities', type: 'search' });
  const results = el('div', { class: 'rows' });

  async function load(q) {
    results.replaceChildren(loading('Searching'));
    try {
      const rows = await Api.adminServers({ q: q || '' });
      clear(results);
      if (!rows.length) { results.appendChild(nothing('No communities match', null)); return; }
      for (const server of rows) {
        results.appendChild(el('div', { class: 'row-item' },
          serverMark({ id: server.id, name: server.name, icon_url: server.icon_url }, { size: 'sm' }),
          el('div', { class: 'row-item-main' },
            el('div', { class: 'row-item-title truncate' }, server.name),
            el('div', { class: 'row-item-sub truncate' }, (server.owner_name ? 'Owner ' + server.owner_name + ' - ' : '') + (server.enforcement_state || 'active'))),
          el('div', { class: 'row-item-actions' },
            actionButton('Open', 'ghost', () => navigate('/server/' + server.id)),
            actionButton(server.enforcement_state === 'active' ? 'Suspend' : 'Lift', 'default',
              () => promptServer(server)))));
      }
    } catch (error) { results.replaceChildren(failure(error, () => load(q))); }
  }

  function promptServer(server) {
    const suspended = server.enforcement_state !== 'active';
    const reason = el('input', { class: 'input', placeholder: 'What is this for?' });
    const dialog = openDialog({
      title: (suspended ? 'Lift enforcement on ' : 'Suspend ') + server.name,
      foot: [
        { label: 'Cancel', kind: 'ghost', onClick: () => dialog.close() },
        { label: suspended ? 'Lift' : 'Suspend', kind: suspended ? 'primary' : 'danger', onClick: async (event) => {
          event.currentTarget.disabled = true;
          try {
            const why = reason.value.trim();
            if (suspended) await Api.adminLiftServer(server.id, why);
            else await Api.adminSuspendServer(server.id, { reason: why });
            dialog.close();
            toast(suspended ? 'Lifted.' : 'Suspended.', { type: 'success' });
            load(search.value.trim());
          } catch (error) { errorToast(error); } finally { event.currentTarget.disabled = false; }
        } },
      ],
    });
    dialog.element.insertBefore(el('div', { class: 'dialog-body' }, labelled('Reason', reason)),
      dialog.element.querySelector('.dialog-foot'));
  }

  search.addEventListener('input', () => load(search.value.trim()));
  host.append(search, results);
  load('');
  return host;
}

// -- reports -----------------------------------------------------------------

function reportsSection() {
  const host = el('div', { class: 'settings-stack' });
  const filter = el('select', { class: 'input', 'aria-label': 'Filter reports by status' });
  for (const value of ['', 'OPEN', 'INVESTIGATING', 'RESOLVED', 'DISMISSED']) {
    filter.appendChild(el('option', { value }, value || 'All statuses'));
  }
  const listHost = el('div', { class: 'rows' });
  host.append(filter, listHost);

  async function load() {
    listHost.replaceChildren(loading('Loading reports'));
    try {
      const rows = await Api.adminReports(filter.value ? { status: filter.value } : {});
      clear(listHost);
      if (!rows.length) { listHost.appendChild(nothing('No reports', null)); return; }
      for (const report of rows) listHost.appendChild(rowFor(report));
    } catch (error) { listHost.replaceChildren(failure(error, load)); }
  }

  function rowFor(report) {
    const reason = report.reason || report.description || '(no reason)';
    return el('div', { class: 'row-item' },
      el('span', { class: 'row-item-icon' }, icon('flag', { size: 16 })),
      el('div', { class: 'row-item-main' },
        el('div', { class: 'row-item-title truncate' }, reason),
        el('div', { class: 'row-item-sub truncate' }, (report.target_type || '') + ' ' + (report.target_id || '') + ' - by ' + (report.reporter_name || 'someone') + ' - ' + (report.status || ''))),
      el('div', { class: 'row-item-actions' },
        actionButton('Resolve', 'default', () => update(report.id, 'RESOLVED')),
        actionButton('Dismiss', 'ghost', () => update(report.id, 'DISMISSED'))));
  }

  async function update(id, status) {
    try { await Api.adminUpdateReport(id, { status }); toast('Updated.', { type: 'success' }); load(); }
    catch (error) { errorToast(error); }
  }

  filter.addEventListener('change', load);
  load();
  return host;
}

// -- appeals -----------------------------------------------------------------

function appealsSection() {
  const host = el('div', { class: 'settings-stack' });
  const listHost = el('div', { class: 'rows' });
  host.appendChild(listHost);

  async function load() {
    listHost.replaceChildren(loading('Loading appeals'));
    try {
      const rows = await Api.adminAppeals({});
      clear(listHost);
      if (!rows.length) { listHost.appendChild(nothing('No appeals', null)); return; }
      for (const appeal of rows) {
        listHost.appendChild(el('div', { class: 'row-item' },
          el('span', { class: 'row-item-icon' }, icon('mail', { size: 16 })),
          el('div', { class: 'row-item-main' },
            el('div', { class: 'row-item-title truncate' }, appeal.user_name || appeal.username || 'Someone'),
            el('div', { class: 'row-item-sub truncate' }, (appeal.action_type || '') + ' - ' + (appeal.statement || appeal.reason || '') + ' - ' + (appeal.status || ''))),
          el('div', { class: 'row-item-actions' },
            actionButton('Grant', 'primary', () => decide(appeal.id, 'APPROVED')),
            actionButton('Deny', 'ghost', () => decide(appeal.id, 'DENIED')))));
      }
    } catch (error) { listHost.replaceChildren(failure(error, load)); }
  }

  async function decide(id, decision) {
    try { await Api.adminDecideAppeal(id, decision, ''); toast('Decided.', { type: 'success' }); load(); }
    catch (error) { errorToast(error); }
  }

  load();
  return host;
}

// -- audit log ---------------------------------------------------------------

function auditSection() {
  const host = el('div', { class: 'settings-stack' });
  const listHost = el('div', { class: 'rows' });
  host.appendChild(listHost);

  async function load() {
    listHost.replaceChildren(loading('Loading the audit log'));
    try {
      const rows = await Api.adminAudit({});
      clear(listHost);
      if (!rows.length) { listHost.appendChild(nothing('Nothing logged yet', null)); return; }
      for (const entry of rows) {
        listHost.appendChild(el('div', { class: 'row-item' },
          el('span', { class: 'row-item-icon' }, icon('book', { size: 16 })),
          el('div', { class: 'row-item-main' },
            el('div', { class: 'row-item-title truncate' }, String(entry.action || '')),
            el('div', { class: 'row-item-sub truncate' }, (entry.actor_id || 'system') + ' -> ' + (entry.target_type || '') + ' ' + (entry.target_id || '') + (entry.reason ? ' - ' + entry.reason : ''))),
          el('span', { class: 'row-item-sub' }, relative(entry.created_at || entry.createdAt))));
      }
    } catch (error) { listHost.replaceChildren(failure(error, load)); }
  }

  load();
  return host;
}

// -- data requests -----------------------------------------------------------

function gdprSection() {
  const host = el('div', { class: 'settings-stack' });
  const listHost = el('div', { class: 'rows' });
  host.appendChild(listHost);

  async function load() {
    listHost.replaceChildren(loading('Loading requests'));
    try {
      const rows = await Api.adminGdprRequests({});
      clear(listHost);
      if (!rows.length) { listHost.appendChild(nothing('No data requests', null)); return; }
      for (const request of rows) {
        listHost.appendChild(el('div', { class: 'row-item' },
          el('span', { class: 'row-item-icon' }, icon('lock', { size: 16 })),
          el('div', { class: 'row-item-main' },
            el('div', { class: 'row-item-title truncate' }, request.username || request.userId),
            el('div', { class: 'row-item-sub truncate' }, (request.requestType || '') + ' - ' + (request.status || '') + (request.reason ? ' - ' + request.reason : ''))),
          el('div', { class: 'row-item-actions' },
            actionButton('Approve', 'default', () => review(request.id, 'APPROVED')),
            actionButton('Reject', 'ghost', () => review(request.id, 'REJECTED')),
            actionButton('Process', 'danger', () => process(request.id)))));
      }
    } catch (error) { listHost.replaceChildren(failure(error, load)); }
  }

  async function review(id, decision) {
    try { await Api.adminReviewGdprRequest(id, decision, ''); toast('Reviewed.', { type: 'success' }); load(); }
    catch (error) { errorToast(error); }
  }

  async function process(id) {
    const ok = await confirmDialog({ title: 'Process erasure?', body: 'The account and its content are anonymised. This cannot be undone.', confirmLabel: 'Process', danger: true });
    if (!ok) return;
    try { await Api.adminProcessGdprRequest(id); toast('Processed.', { type: 'success' }); load(); }
    catch (error) { errorToast(error); }
  }

  load();
  return host;
}

// -- announcements -----------------------------------------------------------

function announcementsSection() {
  const host = el('div', { class: 'settings-stack' });
  const listHost = el('div', { class: 'rows' });
  const create = el('button', { class: 'btn btn--primary', type: 'button' }, 'New announcement');
  create.addEventListener('click', () => edit(null));
  host.append(create, listHost);

  async function load() {
    listHost.replaceChildren(loading('Loading announcements'));
    try {
      const out = await Api.allAnnouncements();
      const rows = Array.isArray(out) ? out : (out.items || []);
      clear(listHost);
      if (!rows.length) { listHost.appendChild(nothing('No announcements', 'Write one to tell everyone something.')); return; }
      for (const row of rows) {
        listHost.appendChild(el('div', { class: 'row-item' },
          el('span', { class: 'row-item-icon' }, icon('bell', { size: 16 })),
          el('div', { class: 'row-item-main' },
            el('div', { class: 'row-item-title truncate' }, row.body),
            el('div', { class: 'row-item-sub' }, (row.level || 'info') + ' - ' + (row.active ? 'active' : 'inactive'))),
          el('div', { class: 'row-item-actions' },
            actionButton('Edit', 'ghost', () => edit(row)),
            actionButton('Delete', 'danger', async () => {
              const ok = await confirmDialog({ title: 'Delete announcement?', confirmLabel: 'Delete', danger: true });
              if (!ok) return;
              try { await Api.deleteAnnouncement(row.id); toast('Deleted.', { type: 'success' }); load(); }
              catch (error) { errorToast(error); }
            }))));
      }
    } catch (error) { listHost.replaceChildren(failure(error, load)); }
  }

  function edit(row) {
    const body = el('textarea', { class: 'input', rows: '3', maxlength: '500' });
    body.value = row ? row.body : '';
    const level = el('select', { class: 'input' });
    for (const value of ['info', 'warning', 'critical']) level.appendChild(el('option', { value }, value));
    level.value = row ? row.level : 'info';
    const linkLabel = el('input', { class: 'input' });
    linkLabel.value = row ? (row.linkLabel || '') : '';
    const linkHref = el('input', { class: 'input' });
    linkHref.value = row ? (row.linkHref || '') : '';
    const active = el('button', { class: 'switch', type: 'button', role: 'switch', 'aria-label': 'Active', 'aria-checked': String(row ? !!row.active : true) });
    const dialog = openDialog({
      title: row ? 'Edit announcement' : 'New announcement',
      foot: [
        { label: 'Cancel', kind: 'ghost', onClick: () => dialog.close() },
        { label: 'Save', kind: 'primary', onClick: async (event) => {
          event.currentTarget.disabled = true;
          const payload = {
            body: body.value,
            level: level.value,
            linkLabel: linkLabel.value || null,
            linkHref: linkHref.value || null,
            active: active.getAttribute('aria-checked') === 'true',
          };
          try {
            if (row) await Api.updateAnnouncement(row.id, payload);
            else await Api.createAnnouncement(payload);
            dialog.close(); toast('Saved.', { type: 'success' }); load();
          } catch (error) { errorToast(error); } finally { event.currentTarget.disabled = false; }
        } },
      ],
    });
    active.addEventListener('click', () => active.setAttribute('aria-checked', String(active.getAttribute('aria-checked') !== 'true')));
    dialog.element.insertBefore(el('div', { class: 'dialog-body' },
      labelled('Message', body),
      labelled('Level', level),
      labelled('Link label', linkLabel),
      labelled('Link address', linkHref),
      el('div', { class: 'field-row' }, el('div', { class: 'field-row-main' }, el('div', { class: 'field-row-title' }, 'Active')), active),
    ), dialog.element.querySelector('.dialog-foot'));
  }

  load();
  return host;
}

// -- pages -------------------------------------------------------------------

function pagesSection() {
  const host = el('div', { class: 'settings-stack' });
  const listHost = el('div', { class: 'rows' });
  host.appendChild(listHost);

  async function load() {
    listHost.replaceChildren(loading('Loading pages'));
    try {
      const rows = await Api.adminPages();
      clear(listHost);
      for (const row of rows || []) {
        listHost.appendChild(el('div', { class: 'row-item' },
          el('span', { class: 'row-item-icon' }, icon('file', { size: 16 })),
          el('div', { class: 'row-item-main' },
            el('div', { class: 'row-item-title truncate' }, row.title || row.route),
            el('div', { class: 'row-item-sub' }, '/' + row.route + ' - ' + (row.status || '') + (row.legal ? ' - legal' : ''))),
          el('div', { class: 'row-item-actions' },
            el('a', { class: 'btn btn--ghost btn--sm', href: path('/' + row.route), target: '_blank', rel: 'noopener' }, 'View'))));
      }
    } catch (error) { listHost.replaceChildren(failure(error, load)); }
  }

  load();
  return host;
}

// -- configuration -----------------------------------------------------------

// Where a value came from, in the words of the screen rather than the store. A
// saved setting is the administrator's even when the environment seeded it, and
// still calling it "from the environment" is the lie that made the old page
// unreadable.
const SOURCE_LABEL = {
  instance: 'Saved here',
  environment: 'From the environment',
  default: 'Default',
};

// The instance catalogue. Labels, types, bounds, values and what is editable all
// come from the server, so a setting added to the schema appears here without a
// matching change, and one the server would refuse is never drawn as something a
// save could set.
function settingsSection() {
  const host = el('div', { class: 'stack' });

  let catalogue = [];
  let ring = { pendingRestart: [], lastSavedAt: null };
  let activeId = null;
  let saveButton = null;
  let saveCount = null;
  const navMarks = new Map();

  // What the server holds, and what has been typed since. Only the second is
  // written, so a save cannot restate a value nobody touched - and a secret left
  // blank is skipped rather than wiping the stored credential on the way past.
  const saved = new Map();
  const edits = new Map();

  function entriesIn(category) {
    return category.settings || category.entries || [];
  }

  function allEntries() {
    const out = [];
    for (const category of catalogue) for (const entry of entriesIn(category)) out.push(entry);
    return out;
  }

  function entryOf(key) {
    for (const entry of allEntries()) if (entry.key === key) return entry;
    return null;
  }

  function remember(data) {
    catalogue = data.categories || [];
    ring = data.status || { pendingRestart: [], lastSavedAt: null };
    saved.clear();
    edits.clear();
    navMarks.clear();
    for (const entry of allEntries()) {
      // A secret's entry carries no value by design, so there is nothing to
      // compare a typed one against.
      if (entry.type !== 'secret') saved.set(entry.key, entry.value);
    }
    if (!catalogue.some((c) => c.id === activeId)) {
      activeId = catalogue.length ? catalogue[0].id : null;
    }
  }

  async function load() {
    host.replaceChildren(loading('Reading the configuration'));
    try {
      remember(await Api.instanceSettings());
      paint();
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }

  // A setting either takes effect on save or waits for the next start. That
  // difference is the reason this screen exists instead of the .env the
  // deployment writes, so it is stated rather than left to be discovered.
  function restartNotice() {
    const keys = ring.pendingRestart || [];
    if (!keys.length) return null;
    const names = keys.map((key) => (entryOf(key) || {}).label || key);
    return notice({
      tone: 'warning',
      title: names.length === 1
        ? 'One change is waiting for a restart'
        : names.length + ' changes are waiting for a restart',
      text: 'Stored, but the running process still has the old value. Restart the server to put '
        + names.join(', ') + ' into effect.',
    });
  }

  function changedIn(categoryId) {
    const category = catalogue.find((c) => c.id === categoryId);
    if (!category) return 0;
    let count = 0;
    for (const entry of entriesIn(category)) if (edits.has(entry.key)) count++;
    return count;
  }

  function paintMarks() {
    for (const [id, mark] of navMarks) {
      const count = changedIn(id);
      mark.textContent = count ? String(count) : '';
      mark.hidden = !count;
    }
  }

  function categoryTab(id, label) {
    const mark = el('span', { class: 'cfg-nav__mark' });
    navMarks.set(id, mark);
    return el('button', {
      class: 'cfg-nav__item' + (id === activeId ? ' active' : ''),
      type: 'button',
      onClick: () => { if (id !== activeId) { activeId = id; paint(); } },
    }, el('span', { class: 'cfg-nav__label' }, label), mark);
  }

  // -- one setting -------------------------------------------------------------

  function chip(text, warning) {
    return el('span', { class: 'cfg-chip' + (warning ? ' cfg-chip--warning' : '') }, text);
  }

  function noteFor(entry) {
    const parts = [];
    if (entry.type === 'secret') {
      parts.push(chip(entry.set ? 'Stored' : 'Not set', !entry.set));
      if (entry.set && entry.readable === false) parts.push(chip('Cannot be read', true));
    } else {
      parts.push(chip(SOURCE_LABEL[entry.source] || entry.source || 'Default'));
    }
    if (entry.seededFrom) parts.push(chip('Seeded by ' + entry.seededFrom));
    if (entry.locked && entry.lockedReason) parts.push(chip(entry.lockedReason, true));
    if ((ring.pendingRestart || []).includes(entry.key)) parts.push(chip('Restart to apply', true));
    else if (entry.restartRequired && edits.has(entry.key)) parts.push(chip('Needs a restart', true));
    return el('div', { class: 'cfg-chips' }, parts);
  }

  function isChanged(entry, value) {
    if (entry.type === 'secret') {
      return String(value === undefined || value === null ? '' : value).length > 0;
    }
    const original = saved.get(entry.key);
    if (original === value) return false;
    if (original === null || original === undefined) return value !== '' && value !== null && value !== undefined;
    if (value === null || value === undefined) return String(original) !== '';
    return String(original) !== String(value);
  }

  function edit(entry, value) {
    if (isChanged(entry, value)) edits.set(entry.key, value);
    else edits.delete(entry.key);
    refresh();
  }

  function readControl(control) {
    return control.dataset.kind === 'integer' ? (Number(control.value) || 0) : control.value;
  }

  function controlFor(entry) {
    const value = edits.has(entry.key) ? edits.get(entry.key) : entry.value;
    if ((entry.type || 'string') === 'boolean') {
      const button = el('button', {
        class: 'switch', type: 'button', role: 'switch',
        'aria-checked': String(!!value), 'aria-label': entry.label || entry.key,
      });
      button.addEventListener('click', () => {
        const next = button.getAttribute('aria-checked') !== 'true';
        button.setAttribute('aria-checked', String(next));
        edit(entry, next);
      });
      return button;
    }
    // A setting with a closed set of answers is a dropdown, not a text box. The
    // list comes from the server, so a value the server would refuse is never
    // something the form offers in the first place.
    if (Array.isArray(entry.allowed) && entry.allowed.length) {
      const select = el('select', { class: 'input input--compact', 'aria-label': entry.label || entry.key });
      for (const option of entry.allowed) {
        select.appendChild(el('option', { value: option }, option === '' ? 'Not set' : option));
      }
      select.value = value === undefined || value === null ? '' : String(value);
      select.addEventListener('change', () => edit(entry, select.value));
      return select;
    }
    const kind = entry.type || 'string';
    const input = el('input', {
      class: 'input input--compact',
      type: kind === 'secret' ? 'password' : kind === 'integer' ? 'number' : kind === 'url' ? 'url' : 'text',
      min: entry.min != null ? entry.min : null,
      max: entry.max != null ? entry.max : null,
      placeholder: kind === 'secret' ? (entry.set ? 'Stored - type to replace' : 'Not set') : null,
      autocomplete: kind === 'secret' ? 'new-password' : 'off',
      'aria-label': entry.label || entry.key,
    });
    input.dataset.kind = kind;
    if (kind !== 'secret') input.value = value === undefined || value === null ? '' : String(value);
    input.addEventListener('input', () => edit(entry, readControl(input)));
    return input;
  }

  function resetAction(entry) {
    if (entry.locked || entry.source !== 'instance') return null;
    const button = el('button', {
      class: 'btn btn--ghost btn--sm', type: 'button',
      'aria-label': 'Reset ' + (entry.label || entry.key) + ' to the default',
      onClick: async () => {
        button.disabled = true;
        try {
          remember(await Api.resetInstanceSetting(entry.key));
          paint();
          toast((entry.label || entry.key) + ' is back to its default.', { type: 'success' });
        } catch (error) {
          button.disabled = false;
          errorToast(error);
        }
      },
    }, 'Reset');
    return button;
  }

  function entryRow(entry) {
    return prow({
      top: true,
      class: 'cfg-entry' + (entry.locked ? ' cfg-entry--locked' : ''),
      title: entry.label || entry.key,
      sub: entry.description,
      note: noteFor(entry),
      control: entry.locked
        ? el('span', { class: 'cfg-locked' }, icon('lock', { size: 15 }))
        : controlFor(entry),
      actions: resetAction(entry),
    });
  }

  // -- the panes ---------------------------------------------------------------

  // Mail delivery is its own panel because the generic rows cannot say whether the
  // instance can actually send anything: that is a property of the mode as a whole,
  // not of any one key. A mode change writes mail.mode through the same save path as
  // every other setting, so it is stored, audited and restart-checked identically.
  function mailPanel() {
    const status = el('p', { class: 'cfg-mail__status prow-sub', role: 'status' }, 'Reading the mail configuration...');
    const modes = el('div', { class: 'cfg-mail__modes', role: 'radiogroup', 'aria-label': 'Delivery mode' });
    const detail = el('div', { class: 'cfg-mail__detail' });

    const card = panel({
      icon: 'mail',
      title: 'Mail delivery',
      note: 'How this instance sends mail',
      rows: [
        prow({ title: 'Status', sub: status }),
        prow({
          title: 'Delivery mode',
          sub: 'Pick how outgoing mail leaves this instance.',
          note: modes,
        }),
        prow({
          title: 'Send a test message',
          sub: 'Confirms the current mode can actually deliver.',
          note: detail,
        }),
      ],
    });

    let info = null;

    async function changeMode(provider) {
      try {
        remember(await Api.updateInstanceSettings({ 'mail.mode': provider.mode }));
        paint();
        toast(provider.label + ' is now the delivery mode.', { type: 'success' });
      } catch (error) {
        errorToast(error);
      }
    }

    function render() {
      if (!info) return;
      const problems = (info.status && info.status.problems) || [];
      status.textContent = info.status && info.status.ready
        ? 'Mail is configured and ready to send.'
        : 'Mail is not ready yet. ' + (problems[0] || 'Nothing is configured.');

      modes.replaceChildren();
      for (const provider of info.providers || []) {
        const current = info.current === provider.mode;
        modes.appendChild(el('button', {
          class: 'cfg-mail__mode' + (current ? ' active' : ''),
          type: 'button',
          role: 'radio',
          'aria-checked': current ? 'true' : 'false',
          onClick: () => { if (!current) changeMode(provider); },
        },
          el('strong', {}, provider.label),
          el('span', { class: 'cfg-mail__mode-summary' }, provider.summary),
        ));
      }

      detail.replaceChildren();
      for (const problem of problems) detail.appendChild(el('p', { class: 'cfg-mail__problem' }, problem));

      // A disabled instance says so rather than offering a button that could only
      // ever report a failure the operator did not cause.
      if (info.current === 'disabled') {
        detail.appendChild(el('p', { class: 'prow-sub' },
          'Delivery is off, so there is nothing to test. Choose another mode first.'));
        return;
      }

      const address = el('input', {
        class: 'input input--compact', type: 'email',
        placeholder: 'you@example.com',
        'aria-label': 'Address to send a test message to',
      });
      const outcome = el('span', { class: 'prow-sub', role: 'status' });
      const send = el('button', { class: 'btn btn--default btn--sm', type: 'button' }, 'Send');
      send.addEventListener('click', async () => {
        const to = address.value.trim();
        if (!to) { outcome.textContent = 'Enter an address first.'; return; }
        send.disabled = true;
        outcome.textContent = 'Sending...';
        try {
          const out = await Api.mailTestSend(to);
          outcome.textContent = (out && out.detail) || 'Sent.';
        } catch (error) {
          // The server's own wording names the cause; an operator who cannot see
          // why a test failed cannot fix it.
          outcome.textContent = error && error.message ? error.message : 'Could not send.';
        } finally {
          send.disabled = false;
        }
      });
      detail.appendChild(el('div', { class: 'field-row-controls' }, address, send, outcome));
    }

    Api.mailConsole().then((data) => { info = data; render(); })
      .catch((error) => {
        status.textContent = error && error.message ? error.message : 'The mail configuration could not be read.';
      });
    return card;
  }

  function categoryPanel(category) {
    const entries = entriesIn(category);

    saveCount = el('span', { class: 'cfg-count' }, 'No changes yet');
    saveButton = el('button', {
      class: 'btn btn--primary btn--sm', type: 'button', disabled: true, onClick: save,
    }, 'Save changes');

    return panel({
      title: category.label,
      note: entries.length + (entries.length === 1 ? ' setting' : ' settings'),
      rows: entries.map(entryRow),
      foot: [saveCount, saveButton],
    });
  }

  // -- the whole page ----------------------------------------------------------

  function paint() {
    saveButton = null;
    saveCount = null;
    navMarks.clear();

    const nav = el('nav', { class: 'cfg-nav', 'aria-label': 'Configuration categories' });
    for (const category of catalogue) nav.appendChild(categoryTab(category.id, category.label));

    const pane = el('div', { class: 'cfg-pane' });
    const category = catalogue.find((c) => c.id === activeId);
    if (!category) {
      pane.appendChild(empty({
        icon: 'settings',
        title: 'Nothing to configure',
        text: 'The server returned no configuration categories.',
      }));
    } else {
      pane.appendChild(categoryPanel(category));
      if (category.id === 'mail') pane.appendChild(mailPanel());
    }

    const waiting = (ring.pendingRestart || []).length ? restartNotice() : null;
    host.replaceChildren(...[waiting, el('div', { class: 'cfg-layout' }, nav, pane)].filter(Boolean));
    refresh();
  }

  function refresh() {
    paintMarks();
    if (saveCount) {
      saveCount.textContent = edits.size
        ? edits.size + (edits.size === 1 ? ' change' : ' changes')
        : 'No changes yet';
    }
    if (saveButton) saveButton.disabled = !edits.size;
  }

  async function save() {
    if (!edits.size) return;
    const values = {};
    for (const [key, value] of edits) values[key] = value;

    // A consequential setting is the one that needs saying yes to rather than
    // clicking save, because it locks people out or opens the door.
    const consequential = [];
    for (const entry of allEntries()) {
      if (entry.consequential && values[entry.key] !== undefined) consequential.push(entry.label || entry.key);
    }
    if (consequential.length) {
      const agreed = await confirmDialog({
        title: 'Apply these changes?',
        body: consequential.join(', ') + ' changes what people can do on this instance, and takes effect as soon as it is saved.',
        confirmLabel: 'Save',
      });
      if (!agreed) return;
      values.__confirm = true;
    }

    saveButton.disabled = true;
    saveButton.setAttribute('aria-busy', 'true');
    try {
      remember(await Api.updateInstanceSettings(values));
      paint();
      toast('Saved.', { type: 'success' });
    } catch (error) {
      if (saveButton) {
        saveButton.disabled = false;
        saveButton.removeAttribute('aria-busy');
      }
      errorToast(error);
    }
  }

  load();
  return host;
}

// -- the page ----------------------------------------------------------------

const SECTIONS = {
  overview: overviewSection,
  users: usersSection,
  communities: communitiesSection,
  reports: reportsSection,
  appeals: appealsSection,
  audit: auditSection,
  gdpr: gdprSection,
  announcements: announcementsSection,
  pages: pagesSection,
  settings: settingsSection,
  database: databaseSection,
  continuum: continuumSection,
};

// -- the database ------------------------------------------------------------

// Where the instance keeps everything. The one setting that cannot live in the
// settings table, because the settings table is inside it - so the server writes
// it to its own bootstrap file and this screen is the only thing that edits it.
//
// A password never reaches this screen. The server reports whether one is set and
// a field left blank keeps the stored one, which is what makes it safe to draw a
// form that a refresh cannot blank out.

const DB_SOURCE = {
  instance: 'Saved here',
  previous: 'The configuration it replaced',
  environment: 'The environment',
};

function dbEngine(config) {
  return config && config.client === 'mysql' ? 'MySQL or MariaDB' : 'SQLite';
}

function dbWhere(config) {
  if (!config) return 'Nothing is configured yet.';
  if (config.client === 'sqlite') return config.file;
  return config.user + '@' + config.host + ':' + config.port + '/' + config.name;
}

function dbNote(text) {
  return el('p', { class: 'settings-note' }, text);
}

function dbField(value, type) {
  const input = el('input', { class: 'input', type: type || 'text', autocomplete: 'off' });
  input.value = value === undefined || value === null ? '' : String(value);
  return input;
}

function dbSwitch(on, label) {
  const button = el('button', {
    class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(!!on), 'aria-label': label,
  });
  button.addEventListener('click', () => {
    button.setAttribute('aria-checked', String(button.getAttribute('aria-checked') !== 'true'));
  });
  return button;
}

function databaseSection() {
  const host = el('div', { class: 'settings-stack' });
  let model = null;

  async function load() {
    host.replaceChildren(loading('Reading the database configuration'));
    try { model = await Api.databaseConfig(); paint(); }
    catch (error) { host.replaceChildren(failure(error, load)); }
  }

  async function reread() {
    try { model = await Api.databaseConfig(); paint(); }
    catch (error) { errorToast(error); }
  }

  // -- what needs saying before anything else ----------------------------------

  function warnings() {
    const out = [];
    if (model.saved.problem) {
      out.push(notice({
        tone: 'danger',
        title: 'The saved connection cannot be read',
        text: model.saved.problem + ' The running server is using whatever it managed to open at start.',
      }));
    }
    if (model.environmentProblem) {
      out.push(notice({
        tone: 'warning',
        title: 'The database environment is incomplete',
        text: model.environmentProblem,
      }));
    }
    if (!model.runtime.connected) {
      const failures = model.runtime.failures || [];
      out.push(notice({
        tone: 'danger',
        title: 'There is no connection to the database',
        text: failures.length
          ? failures.map((f) => (DB_SOURCE[f.source] || f.source) + ': ' + f.error).join(' ')
          : 'The server has not been able to open a connection.',
      }));
    }
    if (model.pendingRestart) {
      out.push(notice({
        tone: 'warning',
        title: 'A saved connection is waiting to take over',
        text: 'The process is still using ' + dbWhere(model.effective) + '. Restart it, or switch now without one.',
        actions: [
          el('button', { class: 'btn btn--primary btn--sm', type: 'button', onClick: applyNow }, 'Switch now'),
          el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: reread }, 'Check again'),
        ],
      }));
    }
    return out;
  }

  // -- what the process is connected to ---------------------------------------

  function inUsePanel() {
    const live = model.effective;
    const rows = [
      prow({ title: 'Engine', control: el('span', { class: 'cfg-chip' }, dbEngine(live)) }),
      prow({ title: 'Location', sub: dbWhere(live) }),
    ];
    if (live && live.client === 'mysql') {
      rows.push(prow({
        title: 'Password',
        control: el('span', {
          class: 'cfg-chip' + (live.passwordSet ? '' : ' cfg-chip--warning'),
        }, live.passwordSet ? 'Set' : 'Not set'),
      }));
      rows.push(prow({
        title: 'TLS',
        control: el('span', { class: 'cfg-chip' }, live.ssl ? 'Required' : 'Off'),
      }));
    }
    rows.push(prow({ title: 'Decided by', control: el('span', { class: 'cfg-chip' }, DB_SOURCE[model.source] || 'Not set') }));
    if (model.saved.present && model.environment) {
      rows.push(prow({ title: 'The environment would use', sub: dbWhere(model.environment) }));
    }
    return panel({
      title: 'In use now',
      note: model.runtime.connected ? 'Connected' : 'Not connected',
      rows,
    });
  }

  // -- the form ---------------------------------------------------------------

  function changePanel() {
    const start = model.effective || model.saved.config || model.environment || { client: 'sqlite' };
    const isMysql = start.client === 'mysql';

    const engine = el('select', { class: 'input', 'aria-label': 'Database engine' },
      el('option', { value: 'sqlite' }, 'SQLite - a file on this server'),
      el('option', { value: 'mysql' }, 'MySQL or MariaDB - a database server'));
    engine.value = isMysql ? 'mysql' : 'sqlite';

    const file = dbField(start.client === 'sqlite' ? start.file : '');
    const dbHost = dbField(isMysql ? start.host : '');
    const port = dbField(isMysql ? start.port : '3306', 'number');
    const name = dbField(isMysql ? start.name : '');
    const user = dbField(isMysql ? start.user : '');
    const password = el('input', {
      class: 'input', type: 'password', autocomplete: 'new-password',
      placeholder: isMysql && start.passwordSet ? 'Stored - type to replace' : 'Not set',
      'aria-label': 'Database password',
    });
    const tls = dbSwitch(isMysql && start.ssl, 'Require TLS');
    const limit = dbField(isMysql ? start.connectionLimit : '10', 'number');

    // Only offered when there is a stored password to forget. Otherwise a blank
    // field already means "no password".
    const forget = isMysql && start.passwordSet ? dbSwitch(false, 'Forget the stored password') : null;

    const sqliteFields = el('div', { class: 'stack stack--tight' },
      labelled('Database file', file),
      dbNote('An absolute path, or one relative to the server process. It is created if it does not exist.'));

    const mysqlFields = el('div', { class: 'stack stack--tight' },
      labelled('Host', dbHost),
      labelled('Port', port),
      labelled('Database name', name),
      labelled('User', user),
      labelled('Password', password),
      dbNote('Leave it blank to keep the stored password. A different host, database or user needs its own.'),
      forget ? labelled('Forget the stored password', forget) : null,
      labelled('Require TLS', tls),
      labelled('Connection limit', limit));

    function syncEngine() {
      const mysql = engine.value === 'mysql';
      sqliteFields.style.display = mysql ? 'none' : '';
      mysqlFields.style.display = mysql ? '' : 'none';
    }
    engine.addEventListener('change', syncEngine);
    syncEngine();

    function draft() {
      if (engine.value === 'sqlite') return { client: 'sqlite', file: file.value.trim() };
      const body = {
        client: 'mysql',
        host: dbHost.value.trim(),
        port: Number(port.value) || 3306,
        name: name.value.trim(),
        user: user.value.trim(),
        ssl: tls.getAttribute('aria-checked') === 'true',
        connectionLimit: Number(limit.value) || 10,
      };
      // A blank password is not an empty one. Leaving it out is how the server is
      // told to keep the credential it has.
      if (password.value) body.password = password.value;
      if (forget && forget.getAttribute('aria-checked') === 'true') body.clearPassword = true;
      return body;
    }

    const result = el('div', { class: 'stack stack--tight' });

    const test = actionButton('Test connection', 'default', async () => {
      test.disabled = true;
      result.replaceChildren(notice({
        tone: 'info', title: 'Testing', text: 'Opening one connection and asking for a single row.',
      }));
      try {
        const out = await Api.testDatabaseConfig(draft());
        result.replaceChildren(out.ok
          ? notice({ tone: 'success', title: 'It answered', text: 'Saving will use this connection.' })
          : notice({ tone: 'danger', title: 'It did not answer', text: out.error || 'The server refused the connection.' }));
      } catch (error) {
        result.replaceChildren(notice({
          tone: 'danger', title: 'It did not answer', text: (error && error.message) || 'The connection failed.',
        }));
      } finally { test.disabled = false; }
    });

    const save = actionButton('Save', 'primary', async () => {
      const ok = await confirmDialog({
        title: 'Store this connection?',
        body: 'The server reaches it first: a configuration that cannot be connected to is never written, so the one that works stays. The running process keeps the connection it has until it restarts, or until you switch below.',
        confirmLabel: 'Store it',
        danger: true,
      });
      if (!ok) return;
      save.disabled = true;
      try {
        model = await Api.saveDatabaseConfig(Object.assign(draft(), { __confirm: true }));
        paint();
        toast('Stored. Restart the server, or switch now.', { type: 'success' });
      } catch (error) {
        errorToast(error);
      } finally { save.disabled = false; }
    });

    return panel({
      title: 'Change the connection',
      note: 'Reached before it is stored',
      body: el('div', { class: 'stack' },
        labelled('Database engine', engine),
        sqliteFields,
        mysqlFields),
      foot: [result, el('div', { class: 'panel-actions' }, test, save)],
    });
  }

  // -- the saved value, and the way back ---------------------------------------

  function managePanel() {
    const rows = [];
    if (model.saved.previous) {
      rows.push(prow({
        title: 'Return to the previous connection',
        sub: 'Back to ' + dbWhere(model.saved.previous) + '.',
        actions: actionButton('Return', 'default', rollback),
      }));
    }
    if (model.saved.present) {
      rows.push(prow({
        title: 'Forget the saved connection',
        sub: 'The environment decides the database again at the next start.',
        actions: actionButton('Forget', 'ghost', forgetSaved),
      }));
    }
    if (!rows.length) return null;
    return panel({
      title: 'Saved configuration',
      note: model.saved.savedAt ? 'Stored ' + relative(model.saved.savedAt) : null,
      rows,
    });
  }

  async function applyNow() {
    const ok = await confirmDialog({
      title: 'Switch the live connection?',
      body: 'The saved connection is opened and prepared first. If it cannot be reached, the running one is left exactly as it is.',
      confirmLabel: 'Switch now',
    });
    if (!ok) return;
    try {
      model = await Api.applyDatabaseConfig();
      paint();
      toast('Connected to ' + dbWhere(model.effective) + '.', { type: 'success' });
    } catch (error) { errorToast(error); }
  }

  async function rollback() {
    const ok = await confirmDialog({
      title: 'Return to the previous connection?',
      body: 'The running process keeps its current connection until it restarts, or until you switch.',
      confirmLabel: 'Return',
    });
    if (!ok) return;
    try {
      model = await Api.rollbackDatabaseConfig();
      paint();
      toast('Stored.', { type: 'success' });
    } catch (error) { errorToast(error); }
  }

  async function forgetSaved() {
    const ok = await confirmDialog({
      title: 'Forget the saved connection?',
      body: 'The environment takes over again at the next start. Nothing changes while the process is running.',
      confirmLabel: 'Forget it',
      danger: true,
    });
    if (!ok) return;
    try {
      model = await Api.clearDatabaseConfig();
      paint();
      toast('Forgotten.', { type: 'success' });
    } catch (error) { errorToast(error); }
  }

  function paint() {
    const nodes = warnings();
    nodes.push(inUsePanel());
    nodes.push(changePanel());
    const manage = managePanel();
    if (manage) nodes.push(manage);
    host.replaceChildren(...nodes);
  }

  load();
  return host;
}

export function renderAdmin(ctx) {
  const content = el('div', { class: 'settings-content' });
  const node = page({ wide: true },
    band({
      eyebrow: 'Administration',
      icon: 'shield',
      title: ctx.page.label || 'Administration',
      lede: ctx.page.blurb || null,
    }),
    el('div', { class: 'settings-layout' }, adminNav(ctx.page.id), content));

  for (const tab of ctx.page.tabs || []) {
    const build = SECTIONS[tab];
    if (!build) continue;
    content.appendChild(build());
  }

  return { node, head: [] };
}

export default { renderAdmin };

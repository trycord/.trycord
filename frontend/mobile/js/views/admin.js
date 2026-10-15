// Instance administration, on a phone.
//
// One screen per destination in the admin scope, with the scope's own list as a
// horizontal strip above it. It is the Mobile module's own tree over the shared
// platform: the catalogue, the labels and the bounds come from the server, so a
// setting the server would refuse is never drawn as something a save could set.
//
// The actions here are the same requests the desktop module makes. Nothing in
// this file reaches past the API client.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { avatar, serverMark, empty, loading, failure } from '../components.js';
import { nameOf } from '../../../packages/store.js';
import { path, navigate } from '../../../packages/nav.js';
import { scopeNav } from '../../../packages/registry.js';
import { toast, menu, sheet, confirm } from '../ui.js';
import { relativeTime } from '../../../packages/format.js';
import Api from '../../../packages/api.js';
import { screen, notice, stat } from './util.js';

function field(label, control, note) {
  return el('label', { class: 'm-field' },
    el('span', { class: 'm-field__label' }, label),
    control,
    note ? el('span', { class: 'm-field__note' }, note) : null);
}

function group(title, children) {
  return el('section', { class: 'm-section' },
    el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, title)),
    children);
}

function switchControl(initial, onChange, label) {
  let value = !!initial;
  const control = el('button', {
    class: 'm-switch' + (value ? ' is-on' : ''), type: 'button', role: 'switch',
    'aria-checked': String(value), 'aria-label': label || 'Toggle',
  });
  control.addEventListener('click', () => {
    value = !value;
    control.setAttribute('aria-checked', String(value));
    control.classList.toggle('is-on', value);
    onChange(value);
  });
  return control;
}

function debounce(fn, wait) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

// -- overview ----------------------------------------------------------------

function overviewBody() {
  const host = el('div', { class: 'm-stack' });

  async function load() {
    host.replaceChildren(loading('Reading the instance'));
    try {
      const out = await Api.adminOverview();
      const strip = el('div', { class: 'm-strip' },
        stat(String(out.users || 0), 'people'),
        stat(String(out.servers || 0), 'communities'),
        stat(String(out.reports || out.openReports || 0), 'reports'),
        stat(String(out.audit || 0), 'audit'));
      const recent = el('div', { class: 'm-list' });
      const rows = out.recentAudit || out.recent || [];
      if (!rows.length) {
        recent.appendChild(el('div', { class: 'm-row' }, el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__sub' }, 'Nothing logged yet.'))));
      }
      for (const row of rows) {
        recent.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__lead' }, icon('activity', { size: 17 })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title truncate' }, String(row.action || '')),
            el('span', { class: 'm-row__sub truncate' }, (row.targetType || row.target_type || '') + ' ' + (row.targetId || row.target_id || ''))),
          el('span', { class: 'm-row__actions' }, relativeTime(row.createdAt || row.created_at))));
      }
      host.replaceChildren(strip, group('What changed lately', recent));
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }

  load();
  return host;
}

// -- people ------------------------------------------------------------------

function usersBody() {
  const host = el('div', { class: 'm-stack' });
  const search = el('input', { class: 'm-input', placeholder: 'Search by username', type: 'search', 'aria-label': 'Search people' });
  const results = el('div', { class: 'm-list' });
  host.append(search, results);
  const run = debounce((q) => load(q), 250);
  search.addEventListener('input', () => run(search.value.trim()));

  async function load(q) {
    results.replaceChildren(loading('Searching'));
    try {
      const rows = await Api.adminUsers({ q: q || '' });
      results.replaceChildren();
      if (!rows.length) {
        results.appendChild(el('div', { class: 'm-row' }, el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__sub' }, 'No accounts match.'))));
        return;
      }
      for (const user of rows) results.appendChild(rowFor(user));
    } catch (error) {
      results.replaceChildren(failure(error, () => load(q)));
    }
  }

  function stateOf(user) {
    return user.enforcement_state || user.enforcementState || 'active';
  }

  function rowFor(user) {
    const name = user.display_name || user.displayName || user.username;
    return el('div', { class: 'm-row' },
      el('span', { class: 'm-row__lead' }, avatar({ id: user.id, username: user.username, displayName: name }, { size: 'md', decorative: true })),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title truncate' }, name),
        el('span', { class: 'm-row__sub truncate' }, '@' + user.username + ' \u00b7 ' + stateOf(user))),
      el('span', { class: 'm-row__actions' }, el('button', {
        class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
        onClick: () => menuFor(user),
      }, 'Actions')));
  }

  function menuFor(user) {
    menu({
      title: user.display_name || user.username,
      items: [
        { label: 'Suspend', icon: 'clock', onSelect: () => promptEnforce(user, 'USER_SUSPENSION') },
        { label: 'Ban', icon: 'ban', danger: true, onSelect: () => promptEnforce(user, 'USER_BAN') },
        { label: 'Lift enforcement', icon: 'check', onSelect: () => promptLift(user) },
      ],
    });
  }

  function promptEnforce(user, actionType) {
    const reason = el('input', { class: 'm-input', placeholder: 'What is this for?', 'aria-label': 'Reason' });
    const minutes = el('input', { class: 'm-input', type: 'number', min: '1', value: '1440', 'aria-label': 'Minutes' });
    const isBan = actionType === 'USER_BAN';
    const layer = sheet({
      title: isBan ? 'Ban this account' : 'Suspend this account',
      body: el('div', { class: 'm-stack' }, field('Reason', reason), isBan ? null : field('Minutes', minutes)),
      footer: el('button', {
        class: 'm-btn m-btn--block' + (isBan ? ' m-btn--danger' : ' m-btn--primary'), type: 'button',
        onClick: async (event) => {
          event.currentTarget.disabled = true;
          try {
            const body = { actionType, reason: reason.value };
            if (!isBan) body.minutes = Number(minutes.value) || 1440;
            await Api.adminEnforceUser(user.id, body);
            layer.close();
            toast('Saved.', { type: 'success' });
            load(search.value.trim());
          } catch (error) { toast(error.message, { type: 'danger' }); event.currentTarget.disabled = false; }
        },
      }, isBan ? 'Ban' : 'Suspend'),
    });
  }

  function promptLift(user) {
    const reason = el('input', { class: 'm-input', placeholder: 'What is this for?', 'aria-label': 'Reason' });
    const layer = sheet({
      title: 'Lift enforcement',
      body: field('Reason', reason),
      footer: el('button', {
        class: 'm-btn m-btn--block m-btn--primary', type: 'button',
        onClick: async (event) => {
          event.currentTarget.disabled = true;
          try { await Api.adminLiftUser(user.id, reason.value); layer.close(); toast('Lifted.', { type: 'success' }); load(search.value.trim()); }
          catch (error) { toast(error.message, { type: 'danger' }); event.currentTarget.disabled = false; }
        },
      }, 'Lift'),
    });
  }

  load('');
  return host;
}

// -- communities -------------------------------------------------------------

function communitiesBody() {
  const host = el('div', { class: 'm-stack' });
  const search = el('input', { class: 'm-input', placeholder: 'Search communities', type: 'search', 'aria-label': 'Search communities' });
  const results = el('div', { class: 'm-list' });
  host.append(search, results);
  const run = debounce((q) => load(q), 250);
  search.addEventListener('input', () => run(search.value.trim()));

  async function load(q) {
    results.replaceChildren(loading('Searching'));
    try {
      const rows = await Api.adminServers({ q: q || '' });
      results.replaceChildren();
      if (!rows.length) {
        results.appendChild(el('div', { class: 'm-row' }, el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__sub' }, 'No communities match.'))));
        return;
      }
      for (const server of rows) {
        const state = server.enforcement_state || 'active';
        results.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__lead' }, serverMark({ id: server.id, name: server.name, icon_url: server.icon_url }, { size: 'md' })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title truncate' }, server.name),
            el('span', { class: 'm-row__sub truncate' }, (server.owner_name ? 'Owner ' + server.owner_name + ' \u00b7 ' : '') + state)),
          el('span', { class: 'm-row__actions' },
            el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => navigate('/server/' + server.id) }, 'Open'),
            el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => promptServer(server) }, state === 'active' ? 'Suspend' : 'Lift'))));
      }
    } catch (error) {
      results.replaceChildren(failure(error, () => load(q)));
    }
  }

  function promptServer(server) {
    const suspended = (server.enforcement_state || 'active') !== 'active';
    const reason = el('input', { class: 'm-input', placeholder: 'What is this for?', 'aria-label': 'Reason' });
    const layer = sheet({
      title: (suspended ? 'Lift enforcement on ' : 'Suspend ') + server.name,
      body: field('Reason', reason),
      footer: el('button', {
        class: 'm-btn m-btn--block' + (suspended ? ' m-btn--primary' : ' m-btn--danger'), type: 'button',
        onClick: async (event) => {
          event.currentTarget.disabled = true;
          try {
            const why = reason.value.trim();
            if (suspended) await Api.adminLiftServer(server.id, why);
            else await Api.adminSuspendServer(server.id, { reason: why });
            layer.close();
            toast(suspended ? 'Lifted.' : 'Suspended.', { type: 'success' });
            load(search.value.trim());
          } catch (error) { toast(error.message, { type: 'danger' }); event.currentTarget.disabled = false; }
        },
      }, suspended ? 'Lift' : 'Suspend'),
    });
  }

  load('');
  return host;
}

// -- reports -----------------------------------------------------------------

const REPORT_STATUSES = ['', 'OPEN', 'INVESTIGATING', 'RESOLVED', 'DISMISSED'];

function reportsBody() {
  const host = el('div', { class: 'm-stack' });
  const filter = el('select', { class: 'm-input m-input--select', 'aria-label': 'Filter reports by status' });
  for (const value of REPORT_STATUSES) filter.appendChild(el('option', { value }, value || 'All statuses'));
  const list = el('div', { class: 'm-list' });
  host.append(filter, list);
  filter.addEventListener('change', () => load());

  async function load() {
    list.replaceChildren(loading('Loading reports'));
    try {
      const rows = await Api.adminReports(filter.value ? { status: filter.value } : {});
      list.replaceChildren();
      if (!rows.length) {
        list.appendChild(el('div', { class: 'm-row' }, el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__sub' }, 'No reports.'))));
        return;
      }
      for (const report of rows) list.appendChild(rowFor(report));
    } catch (error) {
      list.replaceChildren(failure(error, load));
    }
  }

  function rowFor(report) {
    const reason = report.reason || report.description || '(no reason)';
    return el('div', { class: 'm-row' },
      el('span', { class: 'm-row__lead' }, icon('flag', { size: 17 })),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title truncate' }, reason),
        el('span', { class: 'm-row__sub truncate' }, (report.target_type || '') + ' ' + (report.target_id || '') + ' \u00b7 by ' + (report.reporter_name || 'someone') + ' \u00b7 ' + (report.status || ''))),
      el('span', { class: 'm-row__actions' },
        el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => update(report.id, 'RESOLVED') }, 'Resolve'),
        el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => update(report.id, 'DISMISSED') }, 'Dismiss')));
  }

  async function update(id, status) {
    try { await Api.adminUpdateReport(id, { status }); toast('Updated.', { type: 'success' }); load(); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  }

  load();
  return host;
}

// -- appeals -----------------------------------------------------------------

function appealsBody() {
  const host = el('div', { class: 'm-stack' });
  const list = el('div', { class: 'm-list' });
  host.appendChild(list);

  async function load() {
    list.replaceChildren(loading('Loading appeals'));
    try {
      const rows = await Api.adminAppeals({});
      list.replaceChildren();
      if (!rows.length) {
        list.appendChild(el('div', { class: 'm-row' }, el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__sub' }, 'No appeals.'))));
        return;
      }
      for (const appeal of rows) {
        list.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__lead' }, icon('mail', { size: 17 })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title truncate' }, appeal.user_name || appeal.username || 'Someone'),
            el('span', { class: 'm-row__sub truncate' }, (appeal.action_type || '') + ' \u00b7 ' + (appeal.statement || appeal.reason || '') + ' \u00b7 ' + (appeal.status || ''))),
          el('span', { class: 'm-row__actions' },
            el('button', { class: 'm-btn m-btn--sm m-btn--primary', type: 'button', onClick: () => decide(appeal.id, 'APPROVED') }, 'Grant'),
            el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => decide(appeal.id, 'DENIED') }, 'Deny'))));
      }
    } catch (error) {
      list.replaceChildren(failure(error, load));
    }
  }

  async function decide(id, decision) {
    try { await Api.adminDecideAppeal(id, decision, ''); toast('Decided.', { type: 'success' }); load(); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  }

  load();
  return host;
}

// -- audit -------------------------------------------------------------------

function auditBody() {
  const host = el('div', { class: 'm-stack' });
  const list = el('div', { class: 'm-list' });
  host.appendChild(list);

  async function load() {
    list.replaceChildren(loading('Loading the audit log'));
    try {
      const rows = await Api.adminAudit({});
      list.replaceChildren();
      if (!rows.length) {
        list.appendChild(el('div', { class: 'm-row' }, el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__sub' }, 'Nothing logged yet.'))));
        return;
      }
      for (const entry of rows) {
        list.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__lead' }, icon('book', { size: 17 })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title truncate' }, String(entry.action || '')),
            el('span', { class: 'm-row__sub truncate' }, (entry.actor_id || 'system') + ' \u2192 ' + (entry.target_type || '') + ' ' + (entry.target_id || '') + (entry.reason ? ' \u00b7 ' + entry.reason : ''))),
          el('span', { class: 'm-row__actions' }, relativeTime(entry.created_at || entry.createdAt))));
      }
    } catch (error) {
      list.replaceChildren(failure(error, load));
    }
  }

  load();
  return host;
}

// -- data requests -----------------------------------------------------------

function gdprBody() {
  const host = el('div', { class: 'm-stack' });
  const list = el('div', { class: 'm-list' });
  host.appendChild(list);

  async function load() {
    list.replaceChildren(loading('Loading requests'));
    try {
      const rows = await Api.adminGdprRequests({});
      list.replaceChildren();
      if (!rows.length) {
        list.appendChild(el('div', { class: 'm-row' }, el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__sub' }, 'No data requests.'))));
        return;
      }
      for (const request of rows) {
        list.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__lead' }, icon('lock', { size: 17 })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title truncate' }, request.username || request.userId || 'Someone'),
            el('span', { class: 'm-row__sub truncate' }, (request.requestType || '') + ' \u00b7 ' + (request.status || '') + (request.reason ? ' \u00b7 ' + request.reason : ''))),
          el('span', { class: 'm-row__actions' },
            el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => review(request.id, 'APPROVED') }, 'Approve'),
            el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => review(request.id, 'REJECTED') }, 'Deny'),
            el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => process(request) }, 'Process'))));
      }
    } catch (error) {
      list.replaceChildren(failure(error, load));
    }
  }

  async function review(id, decision) {
    try { await Api.adminReviewGdprRequest(id, decision, ''); toast('Reviewed.', { type: 'success' }); load(); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  }

  async function process(request) {
    const sure = await confirm({
      title: 'Process this request?',
      text: 'Erasing is final: the account and its content go. Export requests are handed back to the person.',
      confirmLabel: 'Process', danger: true,
    });
    if (!sure) return;
    try { await Api.adminProcessGdprRequest(request.id); toast('Processed.', { type: 'success' }); load(); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  }

  load();
  return host;
}

// -- announcements -----------------------------------------------------------

function announcementsBody() {
  const host = el('div', { class: 'm-stack' });
  const list = el('div', { class: 'm-list' });
  const create = el('button', {
    class: 'm-btn m-btn--sm m-btn--primary', type: 'button',
    onClick: () => editAnnouncement(null, onSaved),
  }, 'New announcement');
  host.appendChild(el('div', { class: 'm-section' },
    el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'Announcements'), create),
    list));

  function onSaved() { load(); }

  async function load() {
    list.replaceChildren(loading('Loading announcements'));
    try {
      const out = await Api.allAnnouncements();
      const rows = Array.isArray(out) ? out : (out.items || []);
      list.replaceChildren();
      if (!rows.length) {
        list.appendChild(el('div', { class: 'm-row' }, el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__sub' }, 'Nothing announced.'))));
        return;
      }
      for (const row of rows) {
        list.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__lead' }, icon('bell', { size: 17 })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title truncate' }, row.body),
            el('span', { class: 'm-row__sub' }, (row.level || 'info') + ' \u00b7 ' + (row.active ? 'live' : 'hidden'))),
          el('span', { class: 'm-row__actions' },
            el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => editAnnouncement(row, onSaved) }, 'Edit'),
            el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => remove(row) }, 'Delete'))));
      }
    } catch (error) {
      list.replaceChildren(failure(error, load));
    }
  }

  async function remove(row) {
    const sure = await confirm({ title: 'Delete announcement?', confirmLabel: 'Delete', danger: true });
    if (!sure) return;
    try { await Api.deleteAnnouncement(row.id); toast('Deleted.', { type: 'success' }); load(); }
    catch (error) { toast(error.message, { type: 'danger' }); }
  }

  load();
  return host;
}

function editAnnouncement(row, done) {
  const body = el('textarea', { class: 'm-input m-input--area', rows: '3', maxlength: '500', 'aria-label': 'Message' }, row ? row.body : '');
  const level = el('select', { class: 'm-input m-input--select', 'aria-label': 'Level' });
  for (const value of ['info', 'warning', 'critical']) level.appendChild(el('option', { value }, value));
  level.value = row ? row.level : 'info';
  const linkLabel = el('input', { class: 'm-input', value: row ? (row.linkLabel || '') : '', 'aria-label': 'Link label' });
  const linkHref = el('input', { class: 'm-input', value: row ? (row.linkHref || '') : '', 'aria-label': 'Link address' });
  const active = switchControl(row ? !!row.active : true, () => {}, 'Active');
  const layer = sheet({
    title: row ? 'Edit announcement' : 'New announcement',
    body: el('div', { class: 'm-stack' },
      field('Message', body),
      field('Level', level),
      field('Link label', linkLabel),
      field('Link address', linkHref),
      el('div', { class: 'm-row' },
        el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, 'Active')),
        el('span', { class: 'm-row__actions' }, active))),
    footer: el('button', {
      class: 'm-btn m-btn--block m-btn--primary', type: 'button',
      onClick: async (event) => {
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
          layer.close();
          toast('Saved.', { type: 'success' });
          done();
        } catch (error) { toast(error.message, { type: 'danger' }); event.currentTarget.disabled = false; }
      },
    }, 'Save'),
  });
}

// -- pages -------------------------------------------------------------------

function pagesBody() {
  const host = el('div', { class: 'm-stack' });
  const list = el('div', { class: 'm-list' });
  host.appendChild(list);

  async function load() {
    list.replaceChildren(loading('Loading pages'));
    try {
      const rows = await Api.adminPages();
      list.replaceChildren();
      for (const row of rows || []) {
        list.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__lead' }, icon('file', { size: 17 })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title truncate' }, row.title || row.route),
            el('span', { class: 'm-row__sub' }, '/' + row.route + ' \u00b7 ' + (row.status || '') + (row.legal ? ' \u00b7 legal' : ''))),
          el('span', { class: 'm-row__actions' },
            el('a', { class: 'm-btn m-btn--sm m-btn--ghost', href: path('/' + row.route), target: '_blank', rel: 'noopener' },
              'View', el('span', { class: 'm-row__lead' }, icon('external', { size: 14 }))))));
      }
    } catch (error) {
      list.replaceChildren(failure(error, load));
    }
  }

  load();
  return host;
}

// -- configuration -----------------------------------------------------------

function instanceSettingsBody() {
  const host = el('div', { class: 'm-stack' });
  let catalogue = [];
  let status = { pendingRestart: [], lastSavedAt: null };
  let activeId = null;
  const saved = new Map();
  const edits = new Map();
  const strip = el('div', { class: 'm-seg m-seg--scroll', role: 'tablist', 'aria-label': 'Setting categories' });
  const body = el('div', { class: 'm-stack' });
  const saveBar = el('div', { class: 'm-savebar' });
  const restartNote = el('div');
  const saveNote = el('span', { class: 'm-row__sub' });

  host.append(strip, body, el('div', { class: 'm-stack' }, saveBar));

  function allEntries() {
    const out = [];
    for (const category of catalogue) for (const entry of category.settings || category.entries || []) out.push(entry);
    return out;
  }
  function entryOf(key) {
    return (catalogue.flatMap((c) => c.settings || c.entries || []).find((entry) => entry.key === key)) || { key };
  }
  function statusNote() { return body; }

  function remember(data) {
    catalogue = (data && data.categories) || [];
    status = (data && data.status) || { pendingRestart: [], lastSavedAt: null };
    saved.clear();
    edits.clear();
    for (const entry of allEntries()) if (entry.type !== 'secret') saved.set(entry.key, entry.value);
    if (!catalogue.some((c) => c.id === activeId)) activeId = catalogue.length ? catalogue[0].id : null;
  }

  async function load() {
    host.replaceChildren(loading('Reading the configuration'));
    try {
      remember(await Api.instanceSettings());
      host.replaceChildren(strip, body, saveBar);
      paint();
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }

  function paint() {
    strip.replaceChildren();
    for (const category of catalogue) {
      const count = entriesOf(category).filter((entry) => edits.has(entry.key)).length;
      strip.appendChild(el('button', {
        class: 'm-seg__item' + (category.id === activeId ? ' is-active' : ''), type: 'button', role: 'tab',
        'aria-selected': category.id === activeId ? 'true' : 'false',
        onClick: () => { if (category.id !== activeId) { activeId = category.id; paint(); } },
      }, category.label + (count ? ' \u00b7 ' + count : '')));
    }
    const category = catalogue.find((c) => c.id === activeId);
    body.replaceChildren();
    if (!category) {
      body.appendChild(el('div', { class: 'm-row' }, el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__sub' }, 'Nothing to configure.'))));
    } else {
      const list = el('div', { class: 'm-stack' });
      for (const entry of entriesOf(category)) list.appendChild(entryRow(entry));
      body.appendChild(group(category.label, list));
    }
    paintSaveBar();
  }

  function entriesOf(category) {
    return category.settings || category.entries || [];
  }

  function paintSaveBar() {
    saveBar.replaceChildren();
    if (status.pendingRestart && status.pendingRestart.length) {
      const names = status.pendingRestart.map((key) => (entryOf(key) || {}).label || key);
      saveBar.appendChild(notice({
        tone: 'warning',
        title: names.length === 1 ? 'One change is waiting for a restart' : names.length + ' changes are waiting for a restart',
        text: 'Stored, but the running process still has the old value. Restart the server to put ' + names.join(', ') + ' into effect.',
      }));
    }
    const changed = edits.size;
    const save = el('button', {
      class: 'm-btn m-btn--block m-btn--primary', type: 'button', disabled: changed ? null : true,
      onClick: saveEdits,
    }, changed ? 'Save ' + changed + ' change' + (changed === 1 ? '' : 's') : 'No changes');
    saveBar.appendChild(save);
  }

  function entryRow(entry) {
    const label = entry.label || entry.key;
    const control = controlFor(entry);
    const reset = resetAction(entry);
    const row = el('div', { class: 'm-row' + (entry.locked ? ' is-locked' : '') },
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title' }, label),
        el('span', { class: 'm-row__sub' }, entry.help || entry.description || '')),
      el('span', { class: 'm-row__actions' }, reset, control));
    return row;
  }

  function valueOf(entry) {
    return edits.has(entry.key) ? edits.get(entry.key) : entry.value;
  }

  function isChanged(entry, value) {
    if (entry.type === 'secret') return !!value;
    const original = saved.get(entry.key);
    if (original === value) return false;
    if (original === null || original === undefined) return value !== '' && value !== null && value !== undefined;
    if (value === null || value === undefined) return String(original) !== '';
    return String(original) !== String(value);
  }

  function edit(entry, value) {
    if (isChanged(entry, value)) edits.set(entry.key, value);
    else edits.delete(entry.key);
    paint();
  }

  function controlFor(entry) {
    const value = valueOf(entry);
    if ((entry.type || 'string') === 'boolean') {
      return switchControl(!!value, (next) => edit(entry, next), entry.label || entry.key);
    }
    if (Array.isArray(entry.allowed) && entry.allowed.length) {
      const select = el('select', { class: 'm-input m-input--select', 'aria-label': entry.label || entry.key });
      for (const option of entry.allowed) select.appendChild(el('option', { value: option }, option === '' ? 'Not set' : option));
      select.value = value === undefined || value === null ? '' : String(value);
      select.addEventListener('change', () => edit(entry, select.value));
      return select;
    }
    const type = entry.type === 'number' || entry.type === 'integer' ? 'number'
      : entry.type === 'secret' ? 'password' : entry.type === 'url' ? 'url' : 'text';
    const input = el('input', {
      class: 'm-input m-input--compact', type, 'aria-label': entry.label || entry.key,
      value: entry.type === 'secret' ? null : (value === undefined || value === null ? '' : String(value)),
      placeholder: entry.type === 'secret' ? (entry.set ? 'Stored - type to replace' : 'Not set') : null,
      autocomplete: entry.type === 'secret' ? 'new-password' : 'off',
    });
    input.addEventListener('input', () => edit(entry, input.value));
    return input;
  }

  function resetAction(entry) {
    if (entry.locked || entry.source !== 'instance') return null;
    return el('button', {
      class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', 'aria-label': 'Reset ' + (entry.label || entry.key),
      onClick: async (event) => {
        event.currentTarget.disabled = true;
        try {
          remember(await Api.resetInstanceSetting(entry.key));
          paint();
          toast((entry.label || entry.key) + ' is back to its default.', { type: 'success' });
        } catch (error) { event.currentTarget.disabled = false; toast(error.message, { type: 'danger' }); }
      },
    }, 'Reset');
  }

  async function saveEdits() {
    if (!edits.size) return;
    const payload = Object.fromEntries(edits);
    try {
      remember(await Api.updateInstanceSettings(payload));
      paint();
      toast('Saved.', { type: 'success' });
    } catch (error) { toast(error.message, { type: 'danger' }); }
  }

  load();
  return host;
}

// -- database ----------------------------------------------------------------

function databaseBody() {
  const host = el('div', { class: 'm-stack' });
  let model = null;

  async function load() {
    host.replaceChildren(loading('Reading the database configuration'));
    try { model = await Api.databaseConfig(); paint(); }
    catch (error) { host.replaceChildren(failure(error, load)); }
  }

  function engine(config) {
    return config && config.client === 'mysql' ? 'MySQL or MariaDB' : 'SQLite';
  }

  function where(config) {
    if (!config) return 'Nothing is configured yet.';
    if (config.client === 'sqlite') return config.file;
    return config.user + '@' + config.host + ':' + config.port + '/' + config.name;
  }

  function changeForm() {
    const start = model.effective || (model.saved && model.saved.config) || model.environment || { client: 'sqlite' };
    const isMysql = start.client === 'mysql';
    const select = el('select', { class: 'm-input m-input--select', 'aria-label': 'Database engine' },
      el('option', { value: 'sqlite' }, 'SQLite - a file on this server'),
      el('option', { value: 'mysql' }, 'MySQL or MariaDB - a database server'));
    select.value = isMysql ? 'mysql' : 'sqlite';
    const text = (value, type) => el('input', { class: 'm-input', type: type || 'text', value: value === undefined || value === null ? '' : String(value), autocomplete: 'off' });
    const file = text(isMysql ? '' : start.file);
    const dbHost = text(isMysql ? start.host : '');
    const port = text(isMysql ? start.port : '3306', 'number');
    const name = text(isMysql ? start.name : '');
    const user = text(isMysql ? start.user : '');
    const password = el('input', { class: 'm-input', type: 'password', autocomplete: 'off', 'aria-label': 'Password' });
    const ssl = switchControl(!!(isMysql && start.ssl), () => {}, 'Require TLS');
    const limit = text(isMysql ? start.connectionLimit : '10', 'number');

    const sqliteFields = el('div', { class: 'm-stack' }, field('File', file));
    const mysqlFields = el('div', { class: 'm-stack' },
      field('Host', dbHost), field('Port', port), field('Database', name),
      field('User', user), field('Password', password),
      el('div', { class: 'm-row' },
        el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, 'Require TLS')),
        el('span', { class: 'm-row__actions' }, ssl)),
      field('Connection limit', limit));
    function sync() {
      const mysql = select.value === 'mysql';
      sqliteFields.hidden = mysql;
      mysqlFields.hidden = !mysql;
    }
    select.addEventListener('change', sync);
    sync();

    function draft() {
      if (select.value === 'sqlite') return { client: 'sqlite', file: file.value.trim() };
      const body = {
        client: 'mysql', host: dbHost.value.trim(), port: Number(port.value) || 3306,
        name: name.value.trim(), user: user.value.trim(),
        ssl: ssl.getAttribute('aria-checked') === 'true', connectionLimit: Number(limit.value) || 10,
      };
      if (password.value) body.password = password.value;
      return body;
    }

    const result = el('div', { class: 'm-stack' });
    const test = el('button', {
      class: 'm-btn m-btn--ghost', type: 'button',
      onClick: async (event) => {
        event.currentTarget.disabled = true;
        try {
          const out = await Api.testDatabaseConfig(draft());
          result.replaceChildren(notice(out.ok
            ? { tone: 'success', title: 'It answered', text: 'Saving will use this connection.' }
            : { tone: 'danger', title: 'It did not answer', text: out.error || 'The server refused the connection.' }));
        } catch (error) {
          result.replaceChildren(notice({ tone: 'danger', title: 'It did not answer', text: error.message }));
        } finally { event.currentTarget.disabled = false; }
      },
    }, 'Test');
    const save = el('button', {
      class: 'm-btn m-btn--primary', type: 'button',
      onClick: async (event) => {
        const sure = await confirm({
          title: 'Store this connection?',
          text: 'The server reaches it first: one that cannot be connected to is never written.',
          confirmLabel: 'Store it', danger: true,
        });
        if (!sure) return;
        event.currentTarget.disabled = true;
        try {
          model = await Api.saveDatabaseConfig(Object.assign(draft(), { __confirm: true }));
          paint();
          toast('Stored. Restart the server, or switch now.', { type: 'success' });
        } catch (error) { toast(error.message, { type: 'danger' }); }
        finally { event.currentTarget.disabled = false; }
      },
    }, 'Store');

    return group('Change the connection', el('div', { class: 'm-stack' },
      field('Engine', select), sqliteFields, mysqlFields, result,
      el('div', { class: 'm-actions' }, test, save)));
  }

  function warnings() {
    const out = [];
    if (model.saved && model.saved.problem) {
      out.push(notice({
        tone: 'danger', title: 'The saved connection cannot be read',
        text: model.saved.problem + ' The running server is using whatever it opened at start.',
      }));
    }
    if (!model.runtime || !model.runtime.connected) {
      const failures = (model.runtime && model.runtime.failures) || [];
      out.push(notice({
        tone: 'danger', title: 'There is no database connection',
        text: failures.length ? failures.map((f) => f.source + ': ' + f.error).join(' ') : 'The server could not open a connection.',
      }));
    }
    if (model.pendingRestart) {
      out.push(notice({
        tone: 'warning', title: 'A saved connection is waiting to take over',
        text: 'The process is still using ' + where(model.effective) + '.',
        actions: el('div', { class: 'm-actions' },
          el('button', {
            class: 'm-btn m-btn--sm m-btn--primary', type: 'button',
            onClick: async () => {
              const sure = await confirm({ title: 'Switch the live connection?', text: 'The saved connection is opened first; the running one is left as it is if that fails.', confirmLabel: 'Switch now' });
              if (!sure) return;
              try { model = await Api.applyDatabaseConfig(); paint(); toast('Connected.', { type: 'success' }); }
              catch (error) { toast(error.message, { type: 'danger' }); }
            },
          }, 'Switch now'),
          el('button', { class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: rereread }, 'Check again')),
      }));
    }
    return out;
  }

  async function rereread() {
    try { model = await Api.databaseConfig(); paint(); } catch (error) { toast(error.message, { type: 'danger' }); }
  }

  function paint() {
    const live = model.effective;
    const nodes = warnings();
    nodes.push(group('In use now', el('div', { class: 'm-list' },
      el('div', { class: 'm-row' }, el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, 'Engine')), el('span', { class: 'm-row__actions' }, engine(live))),
      el('div', { class: 'm-row' }, el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, 'Location'), el('span', { class: 'm-row__sub' }, where(live)))))));
    nodes.push(changeForm());
    if (model.saved && model.saved.previous) {
      nodes.push(group('Saved configuration', el('div', { class: 'm-list' },
        el('div', { class: 'm-row' },
          el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, 'Return to the previous connection')),
          el('span', { class: 'm-row__actions' }, el('button', {
            class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
            onClick: async () => {
              const sure = await confirm({ title: 'Return to the previous connection?', confirmLabel: 'Return' });
              if (!sure) return;
              try { model = await Api.rollbackDatabaseConfig(); paint(); toast('Stored.', { type: 'success' }); }
              catch (error) { toast(error.message, { type: 'danger' }); }
            },
          }, 'Return'))))));
    }
    if (model.saved && model.saved.present) {
      nodes.push(group('Saved configuration', el('div', { class: 'm-list' },
        el('div', { class: 'm-row' },
          el('span', { class: 'm-row__body' }, el('span', { class: 'm-row__title' }, 'Forget the saved connection')),
          el('span', { class: 'm-row__actions' }, el('button', {
            class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
            onClick: async () => {
              const sure = await confirm({ title: 'Forget the saved connection?', text: 'The environment decides the database again at the next start.', confirmLabel: 'Forget it', danger: true });
              if (!sure) return;
              try { model = await Api.clearDatabaseConfig(); paint(); toast('Forgotten.', { type: 'success' }); }
              catch (error) { toast(error.message, { type: 'danger' }); }
            },
          }, 'Forget'))))));
    }
    host.replaceChildren(...nodes);
  }

  load();
  return host;
}

// -- the admin shell ---------------------------------------------------------

export function renderAdmin(ctx) {
  const page = ctx.page;
  const initial = ctx.query.get('section') || page.id;

  const bodies = {
    admin: overviewBody,
    'admin.users': usersBody,
    'admin.communities': communitiesBody,
    'admin.reports': reportsBody,
    'admin.appeals': appealsBody,
    'admin.audit': auditBody,
    'admin.gdpr': gdprBody,
    'admin.announcements': announcementsBody,
    'admin.pages': pagesBody,
    'admin.settings': instanceSettingsBody,
    'admin.database': databaseBody,
  };
  const active = bodies[initial] ? initial : 'admin';

  const strip = el('div', { class: 'm-seg m-seg--scroll', role: 'tablist', 'aria-label': 'Instance administration' });
  for (const group of scopeNav('admin')) {
    for (const item of group.items) {
      strip.appendChild(el('a', {
        class: 'm-seg__item' + (item.id === active ? ' is-active' : ''), role: 'tab',
        href: item.route ? path(item.route) : path('/admin'),
        'aria-selected': item.id === active ? 'true' : 'false',
      }, item.label));
    }
  }

  const host = el('div', { class: 'm-stack' });
  const node = screen(
    el('div', { class: 'm-hero m-hero--quiet' },
      el('h1', { class: 'm-hero__title' }, page.label || 'Administration'),
      el('div', { class: 'm-hero__sub' }, page.blurb || 'This instance.')),
    strip, host);

  return { node, head: { lead: 'back', title: page.label || 'Administration' }, onMount() { host.replaceChildren(bodies[active]()); } };
}

export default { renderAdmin };

// Admin: the people and the moderation queue.
// Overview, the accounts, the communities, the reports, the appeals, the audit
// log and the data requests. Every action names what it does in its own label,
// and every enforcement asks once beside it so a slip needs a second slip.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { head, card, row, blank, fault, fold, facts, hold } from '../ui/page.js';
import { errorToast, toast, confirmDialog, openMenu } from '../ui/overlays.js';
import { readPrefs, patchPrefs, OVERVIEW_WIDGETS } from '../prefs.js';

// -- overview ----------------------------------------------------------------

// The names the server reports for a report or appeal, in the words a reader
// reads. The server's statuses are kept - they are the ones the queues are
// filtered by - and only the presentation is spelled out.
function statusWord(status) {
  const words = {
    OPEN: 'Open',
    INVESTIGATING: 'Being investigated',
    RESOLVED: 'Resolved',
    DISMISSED: 'Dismissed',
    UNDER_REVIEW: 'Under review',
    UPHELD: 'Upheld',
    REJECTED: 'Rejected',
  };
  return words[status] || String(status || '').replace(/_/g, ' ');
}

// One distribution of statuses (reports or appeals) as fact cells. The counts
// are the overview's own; a status the instance has never seen simply does
// not appear rather than pretending to be zero.
function statusFacts(list) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return null;
  return facts(items.map((entry) => ({
    value: String(entry.n),
    label: statusWord(entry.status),
  })));
}

export function adminOverview() {
  const body = el('div', { class: 'fold fold--tight' });
  const arrange = el('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, icon('grid', { size: 15 }), 'Widgets');

  const WIDGET_LABELS = {
    queue: ['The queues', 'activity'],
    reports: ['Reports by status', 'flag'],
    appeals: ['Appeals by status', 'inbox'],
    audit: ['Recent audit', 'clock'],
  };

  arrange.addEventListener('click', (event) => {
    openMenu({
      anchor: event.currentTarget,
      items: OVERVIEW_WIDGETS.map((id) => ({
        label: WIDGET_LABELS[id][0], icon: WIDGET_LABELS[id][1],
        checked: readPrefs().overviewWidgets.indexOf(id) !== -1,
        onSelect: () => {
          const current = readPrefs().overviewWidgets;
          const next = current.indexOf(id) === -1 ? current.concat([id]) : current.filter((entry) => entry !== id);
          patchPrefs({ overviewWidgets: next.length ? next : OVERVIEW_WIDGETS.slice() });
          paint();
        },
      })),
    });
  });

  // The overview itself: the queues at the top - the work, before the
  // scenery - then the two status distributions, then the last few audit
  // entries. Every number is the endpoint's; nothing here is computed by
  // guessing, and a widget the reader switched off simply is not drawn.
  const paint = async () => {
    const wanted = readPrefs().overviewWidgets;
    body.replaceChildren(hold('Reading the instance'));
    try {
      const data = await Api.adminOverview();
      const widgets = [];

      if (wanted.indexOf('queue') !== -1) {
        widgets.push(card({
          label: 'The queues', glyph: 'activity',
          body: facts([
            { value: String(data.users), label: 'Accounts' },
            { value: String(data.servers), label: 'Communities' },
            { value: String(data.enforcedUsers), label: 'Enforced accounts' },
            { value: String(data.openReports), label: 'Open reports' },
            { value: String(data.openAppeals), label: 'Open appeals' },
          ]),
        }));
      }

      if (wanted.indexOf('reports') !== -1) {
        const distribution = statusFacts(data.reports);
        widgets.push(card({
          label: 'Reports by status', glyph: 'flag',
          body: distribution || blank({
            glyph: 'flag',
            title: 'No reports yet',
            text: 'A filed report lands here with its status.',
          }),
        }));
      }

      if (wanted.indexOf('appeals') !== -1) {
        const distribution = statusFacts(data.appeals);
        widgets.push(card({
          label: 'Appeals by status', glyph: 'inbox',
          body: distribution || blank({
            glyph: 'inbox',
            title: 'No appeals yet',
            text: 'An appeal against an enforcement lands here with its status.',
          }),
        }));
      }

      if (wanted.indexOf('audit') !== -1) {
        const entries = Array.isArray(data.recentAudit) ? data.recentAudit : [];
        widgets.push(card({
          label: 'Recent audit', glyph: 'clock',
          body: entries.length
            ? el('div', { class: 'rowlist' },
              entries.map((entry) => row({
                title: entry.action,
                sub: entry.targetType + (entry.targetId ? ' · ' + entry.targetId : ''),
              })))
            : blank({
              glyph: 'clock',
              title: 'Nothing recorded yet',
              text: 'Administrative actions land here as they happen.',
            }),
        }));
      }

      body.replaceChildren(...widgets);
    } catch (e) {
      body.replaceChildren(fold([fault(e, paint)]));
    }
  };

  return {
    node: fold([
      head({
        kicker: 'Instance',
        title: 'Overview',
        lede: 'The work waiting, the state of the queues, and what changed lately.',
        actions: arrange,
      }),
      body,
    ]),
    onMount: paint,
    cleanup() {},
  };
}

// -- people ------------------------------------------------------------------

export function adminPeople() {
  const results = el('div', { class: 'rowlist' });
  const input = el('input', {
    class: 'input', type: 'search', placeholder: 'Search an account',
    'aria-label': 'Search accounts by name',
    autocomplete: 'off', spellcheck: 'false',
  });

  const paintRows = async (q) => {
    try {
      const rows = await Api.adminUsers(q ? { q, limit: '25' } : { limit: '25' });
      const items = Array.isArray(rows) ? rows : (rows && rows.items) || [];
      results.replaceChildren(...(items.length ? items.map((u) => row({
        lead: el('span', { class: 'role-dot' },
          icon(u.enforced ? 'shield-off' : 'user', { size: 15 })),
        title: u.displayName || u.username || 'An account',
        sub: u.enforced ? 'Enforced: ' + String(u.enforcement || 'unknown') : '@' + (u.username || ''),
        side: el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'Actions for the account ' + (u.username || ''),
          onClick: (event) => userActions(event, u, () => paintRows(input.value.trim())),
        }, icon('more', { size: 15 })),
        // The same actions, raised by a right-click on the row itself.
        menu: () => userActionItems(u, () => paintRows(input.value.trim())),
      })) : [blank({
        glyph: 'user', title: 'No account by that name',
        text: 'The search reads names and handles; try fewer letters.',
      })]));
    } catch (e) {
      results.replaceChildren(fold([fault(e, () => paintRows(input.value.trim()))]));
    }
  };

  let timer = null;
  input.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; paintRows(input.value.trim()); }, 240);
  });

  return {
    node: fold([
      head({
        kicker: 'Moderation',
        title: 'People',
        lede: 'Search an account, and act on it once on purpose.',
      }),
      card({
        label: 'Accounts', glyph: 'users',
        body: fold([input, results]),
      }),
    ]),
    onMount: () => paintRows(''),
    cleanup() { if (timer) clearTimeout(timer); },
  };
}

function userActionItems(user, refresh) {
  return [
    { header: user.displayName || user.username || 'An account' },
    {
      label: 'Suspend for one day', icon: 'clock',
      onSelect: () => enforceWith(user, refresh, {
        kind: 'suspend', duration: '1d', reason: 'Suspended by an administrator',
      }),
    },
    {
      label: 'Suspend permanently', icon: 'clock', danger: true,
      onSelect: () => enforceWith(user, refresh, {
        kind: 'suspend', reason: 'Suspended by an administrator',
      }),
    },
    {
      label: 'Ban', icon: 'ban', danger: true,
      onSelect: () => enforceWith(user, refresh, { kind: 'ban', reason: 'Banned by an administrator' }),
    },
    {
      label: 'Lift enforcement', icon: 'check', checked: true,
      onSelect: () => lift(user, refresh),
    },
    {
      label: 'Approve account', icon: 'check',
      onSelect: async () => {
        try {
          await Api.approveUser(user.id);
          toast('Approved');
          refresh();
        } catch (e) { errorToast(e); }
      },
    },
  ];
}

function userActions(event, user, refresh) {
  openMenu({ anchor: event.currentTarget, items: userActionItems(user, refresh) });
}

// Apply an enforcement action to an account.
//
// The body is the **server's** contract, not a shorthand of our own. It used
// to send `{ kind, duration, reason }`, and the server reads `actionType`,
// `reason`, `expiresInHours` and `confirm` - so every one of these actions
// was refused with "invalid action type for user target" and the menu items
// did nothing at all.
//
// The mapping is here, in one place, so that a change to the server's
// vocabulary is a change to one table rather than to three call sites.
const ENFORCEMENT = {
  // A warning: a note on the account, and nothing more.
  warn: { actionType: 'WARNING' },
  // A suspension for a while. The hours are how long it lasts; without them
  // the suspension is until it is lifted.
  suspend: { actionType: 'SUSPENSION' },
  // An account ban. The server asks for an explicit confirmation, because a
  // ban is the one action that cannot be taken back by lifting it.
  ban: { actionType: 'ACCOUNT_BAN', confirm: true },
};

async function enforceWith(user, refresh, plan) {
  const mapping = ENFORCEMENT[plan.kind];
  if (!mapping) {
    errorToast({ message: 'That enforcement is not one this console can apply.' });
    return;
  }
  const body = Object.assign({}, mapping, { reason: plan.reason });
  if (plan.duration === '1d') body.expiresInHours = 24;

  const yes = await confirmDialog({
    title: (plan.kind === 'ban' ? 'Ban ' : 'Suspend ') + (user.username || 'this account') + '?',
    body: plan.kind === 'ban'
      ? 'The person loses access to everything on this instance, and the action '
        + 'has to be undone on purpose. The reason is recorded.'
      : 'The person loses access until the enforcement is lifted on purpose.',
    confirmLabel: plan.kind === 'ban' ? 'Ban the account' : 'Apply enforcement',
    danger: true,
  });
  if (!yes) return;
  try {
    await Api.adminEnforceUser(user.id, body);
    toast('Enforcement applied');
    refresh();
  } catch (e) { errorToast(e); }
}

async function lift(user, refresh) {
  try {
    await Api.adminLiftUser(user.id, 'Lifted by an administrator');
    toast('The enforcement is lifted');
    refresh();
  } catch (e) { errorToast(e); }
}

// -- communities -------------------------------------------------------------

export function adminCommunities() {
  const list = el('div', { class: 'rowlist' });

  return {
    node: fold([
      head({
        kicker: 'Moderation',
        title: 'Communities',
        lede: 'Every community on this instance.',
      }),
      card({ label: 'Communities', glyph: 'users', body: list, flush: true }),
    ]),
    onMount: async () => {
      try {
        const rows = await Api.adminServers({ limit: '50' });
        const items = Array.isArray(rows) ? rows : (rows && rows.items) || [];
        list.replaceChildren(...(items.length ? items.map((s) => row({
          lead: el('span', { class: 'role-dot' }, icon('users', { size: 15 })),
          title: s.name || 'A community',
          sub: (s.memberCount || s.member_count || 0) + ' members',
          side: s.suspended ? el('span', { class: 'chip chip--quiet' }, 'suspended') : null,
        })) : [blank({
          glyph: 'users', title: 'No communities yet',
          text: 'Communities appear here once someone creates one.',
        })]));
      } catch (e) {
        list.replaceChildren(fold([fault(e, null)]));
      }
    },
    cleanup() {},
  };
}

// -- reports -----------------------------------------------------------------

export function adminReports() {
  const list = el('div', { class: 'rowlist' });

  const paint = async () => {
    list.replaceChildren(hold('Reading the reports'));
    try {
      const rows = await Api.adminReports({ limit: '50' });
      const items = Array.isArray(rows) ? rows : (rows && rows.items) || [];
      list.replaceChildren(...(items.length ? items.map((r) => row({
        lead: el('span', { class: 'role-dot' }, icon('flag', { size: 15 })),
        title: r.reason || 'A report',
        sub: (r.reporterUsername ? 'by ' + r.reporterUsername : '') + (r.targetType ? ' · ' + r.targetType : ''),
        side: el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'Update the report',
          onClick: () => resolveReport(r, paint),
        }, 'Resolve'),
        menu: () => [
          { label: 'Resolve the report', icon: 'check', onSelect: () => resolveReport(r, paint) },
        ],
      })) : [blank({
        glyph: 'flag', title: 'No reports',
        text: 'Reports raised by members appear here.',
      })]));
    } catch (e) {
      list.replaceChildren(fold([fault(e, paint)]));
    }
  };

  return {
    node: fold([
      head({
        kicker: 'Moderation',
        title: 'Reports',
        lede: 'Reports raised by members.',
      }),
      card({ label: 'Reports', glyph: 'flag', body: list, flush: true }),
    ]),
    onMount: paint,
    cleanup() {},
  };
}

// The actions on one report, one appeal and one data request. The row's
// buttons and its context menu offer the same things, so they are written
// once.
async function resolveReport(report, refresh) {
  try {
    await Api.adminUpdateReport(report.id, { status: 'resolved' });
    toast('Report updated');
    refresh();
  } catch (e) { errorToast(e); }
}

async function decideAppeal(appeal, decision, refresh) {
  try {
    await Api.adminDecideAppeal(appeal.id, decision, decision === 'approve'
      ? 'Approved by an administrator' : 'Denied by an administrator');
    toast(decision === 'approve' ? 'Approved' : 'Denied');
    refresh();
  } catch (e) { errorToast(e); }
}

async function reviewRequest(request, decision, refresh) {
  try {
    await Api.adminReviewGdprRequest(request.id, decision, decision === 'approve'
      ? 'Approved by an administrator' : 'Denied by an administrator');
    toast(decision === 'approve' ? 'Approved' : 'Denied');
    refresh();
  } catch (e) { errorToast(e); }
}

// -- appeals -----------------------------------------------------------------

export function adminAppeals() {
  const list = el('div', { class: 'rowlist' });

  const paint = async () => {
    list.replaceChildren(hold('Reading the appeals'));
    try {
      const rows = await Api.adminAppeals({ limit: '50' });
      const items = Array.isArray(rows) ? rows : (rows && rows.items) || [];
      list.replaceChildren(...(items.length ? items.map((a) => row({
        lead: el('span', { class: 'role-dot' }, icon('mail', { size: 15 })),
        title: a.username || 'An appeal',
        sub: a.reason || '',
        side: el('span', { class: 'rowtools' },
          el('button', {
            class: 'btn btn--primary btn--sm', type: 'button',
            onClick: () => decideAppeal(a, 'approve', paint),
          }, 'Approve'),
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: () => decideAppeal(a, 'deny', paint),
          }, 'Deny')),
        menu: () => [
          { label: 'Approve the appeal', icon: 'check', onSelect: () => decideAppeal(a, 'approve', paint) },
          { label: 'Deny the appeal', icon: 'x', danger: true, onSelect: () => decideAppeal(a, 'deny', paint) },
        ],
      })) : [blank({
        glyph: 'mail', title: 'No appeals',
        text: 'Requests to reconsider an enforcement land here.',
      })]));
    } catch (e) {
      list.replaceChildren(fold([fault(e, paint)]));
    }
  };

  return {
    node: fold([
      head({
        kicker: 'Moderation',
        title: 'Appeals',
        lede: 'Requests to reconsider an enforcement.',
      }),
      card({ label: 'Appeals', glyph: 'mail', body: list, flush: true }),
    ]),
    onMount: paint,
    cleanup() {},
  };
}

// -- audit -------------------------------------------------------------------

export function adminAudit() {
  const list = el('div', { class: 'rowlist' });

  return {
    node: fold([
      head({
        kicker: 'Moderation',
        title: 'Audit log',
        lede: 'Administrative actions, most recent first.',
      }),
      card({ label: 'Actions', glyph: 'book', body: list, flush: true }),
    ]),
    onMount: async () => {
      try {
        const rows = await Api.adminAudit({ limit: '50' });
        const items = Array.isArray(rows) ? rows : (rows && rows.items) || [];
        list.replaceChildren(...(items.length ? items.map((a) => row({
          lead: el('span', { class: 'role-dot' }, icon('book', { size: 15 })),
          title: a.action || 'An action',
          sub: (a.actorUsername || '') + (a.target ? ' · ' + a.target : ''),
          meta: a.createdAt || a.created_at || '',
        })) : [blank({
          glyph: 'book', title: 'Nothing logged yet',
          text: 'Administrative actions appear here as they happen.',
        })]));
      } catch (e) {
        list.replaceChildren(fold([fault(e, null)]));
      }
    },
    cleanup() {},
  };
}

// -- gdpr --------------------------------------------------------------------

export function adminGdpr() {
  const list = el('div', { class: 'rowlist' });

  const paint = async () => {
    list.replaceChildren(hold('Reading the requests'));
    try {
      const rows = await Api.adminGdprRequests({ limit: '50' });
      const items = Array.isArray(rows) ? rows : (rows && rows.items) || [];
      list.replaceChildren(...(items.length ? items.map((r) => row({
        lead: el('span', { class: 'role-dot' }, icon('lock', { size: 15 })),
        title: r.username || 'A request',
        sub: r.type || r.kind || 'data request',
        side: el('span', { class: 'rowtools' },
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: () => reviewRequest(r, 'approve', paint),
          }, 'Approve'),
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: async () => {
              try {
                await Api.adminProcessGdprRequest(r.id);
                toast('Processed');
                paint();
              } catch (e) { errorToast(e); }
            },
          }, 'Process')),
        menu: () => [
          { label: 'Approve the request', icon: 'check', onSelect: () => reviewRequest(r, 'approve', paint) },
          {
            label: 'Process the request', icon: 'zap', danger: true,
            onSelect: async () => {
              try {
                await Api.adminProcessGdprRequest(r.id);
                toast('Processed');
                paint();
              } catch (e) { errorToast(e); }
            },
          },
        ],
      })) : [blank({
        glyph: 'lock', title: 'No data requests',
        text: 'Erasure and access requests land here.',
      })]));
    } catch (e) {
      list.replaceChildren(fold([fault(e, paint)]));
    }
  };

  return {
    node: fold([
      head({
        kicker: 'Moderation',
        title: 'Data requests',
        lede: 'Erasure and access requests.',
      }),
      card({ label: 'Requests', glyph: 'lock', body: list, flush: true }),
    ]),
    onMount: paint,
    cleanup() {},
  };
}

// -- approvals ---------------------------------------------------------------

export function adminApprovals() {
  const list = el('div', { class: 'rowlist' });

  const paint = async () => {
    list.replaceChildren(hold('Reading the waiting accounts'));
    try {
      const data = await Api.adminApprovals();
      if (!data || data.enabled === false) {
        list.replaceChildren(blank({
          glyph: 'check',
          title: 'Approval is off',
          text: 'Registration approval is not enabled for this instance.',
        }));
        return;
      }
      const items = Array.isArray(data.pending) ? data.pending : [];
      if (!items.length) {
        list.replaceChildren(blank({
          glyph: 'check', title: 'Nobody waiting',
          text: 'Every account that asked has been let in.',
        }));
        return;
      }
      list.replaceChildren(...items.map((u) => row({
        lead: el('span', { class: 'role-dot' }, icon('user', { size: 15 })),
        title: u.displayName || u.username || 'An account',
        sub: '@' + (u.username || '') + ' · ' + (u.createdAt || ''),
        side: el('button', {
          class: 'btn btn--primary btn--sm', type: 'button',
          'aria-label': 'Approve ' + (u.username || 'this account'),
          onClick: async () => {
            try {
              await Api.approveUser(u.id);
              toast('Approved');
              paint();
            } catch (e) { errorToast(e); }
          },
        }, 'Approve'),
      })));
    } catch (e) {
      list.replaceChildren(fold([fault(e, paint)]));
    }
  };

  return {
    node: fold([
      head({
        kicker: 'Moderation',
        title: 'Approvals',
        lede: 'Accounts waiting to be let in.',
      }),
      card({ label: 'Waiting', glyph: 'check', body: list, flush: true }),
    ]),
    onMount: paint,
    cleanup() {},
  };
}

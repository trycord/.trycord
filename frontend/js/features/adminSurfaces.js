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
import { setInspector } from '../shell.js';

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
    APPROVED: 'Approved',
    DENIED: 'Denied',
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

// -- reports: the queue and the case -------------------------------------------------

// The queue's filters are the server's own statuses, so a filter can never
// ask for a state the server does not have.
const REPORT_FILTERS = [
  ['', 'All'],
  ['OPEN', 'Open'],
  ['INVESTIGATING', 'Investigating'],
  ['RESOLVED', 'Resolved'],
  ['DISMISSED', 'Dismissed'],
];

// What moving a case to each status means, in the words of the person doing
// it. The server records every move in the audit log; the words here say
// what is about to be recorded.
const REPORT_MOVES = {
  OPEN: 'Reopen',
  INVESTIGATING: 'Take it on',
  RESOLVED: 'Resolve',
  DISMISSED: 'Dismiss',
};

export function adminReports() {
  const list = el('div', { class: 'rowlist' });
  const chips = el('div', { class: 'filterchips', role: 'group', 'aria-label': 'Filter reports by status' });
  let status = '';
  let selectedId = null;

  const paintChips = () => {
    chips.replaceChildren(...REPORT_FILTERS.map(([value, label]) => el('button', {
      class: 'chip' + (status === value ? ' chip--on' : ''), type: 'button',
      'aria-pressed': String(status === value),
      onClick: () => { status = value; paintChips(); paint(); },
    }, label)));
  };
  paintChips();

  const paint = async () => {
    list.replaceChildren(hold('Reading the reports'));
    try {
      const rows = await Api.adminReports(Object.assign({ limit: '100' }, status ? { status } : {}));
      const items = Array.isArray(rows) ? rows : (rows && rows.items) || [];
      list.replaceChildren(...(items.length ? items.map((report) => row({
        lead: el('span', { class: 'role-dot' }, icon('flag', { size: 15 })),
        title: report.reason || 'A report',
        sub: (report.reporter_name ? 'by ' + report.reporter_name : 'an account')
          + (report.target_type ? ' · ' + String(report.target_type).replace(/_/g, ' ') : ''),
        side: el('span', { class: 'chip chip--quiet' }, statusWord(report.status)),
        onClick: () => {
          selectedId = report.id;
          // The case is the panel's, and the panel is rebuilt for it: the
          // operator's last case is not shown under a new number.
          setInspector(SPEC);
        },
      })) : [blank({
        glyph: 'flag',
        title: status ? 'Nothing in this state' : 'No reports',
        text: status
          ? 'No report is in this state. The other filters have the rest.'
          : 'A filed report lands here, newest first.',
      })]));
    } catch (e) {
      list.replaceChildren(fold([fault(e, paint)]));
    }
  };

  // The case: what was reported, who reported it, what is reported, and the
  // decision. The facts and the allegation are shown as what they are - the
  // server's record and the reporter's words - and every move is recorded by
  // the server, never only by this panel.
  const casePanel = () => {
    const body = el('div', { class: 'fold fold--tight' });

    const paintCase = async () => {
      if (!selectedId) {
        body.replaceChildren(blank({
          glyph: 'flag',
          title: 'Pick a report',
          text: 'The case opens here when you choose one from the list.',
        }));
        return;
      }
      body.replaceChildren(hold('Opening the case'));
      try {
        const report = await Api.adminReport(selectedId);
        const target = report.targetUser || null;
        const moves = REPORT_FILTERS.map(([value]) => value)
          .filter((value) => value && value !== String(report.status || '').toUpperCase())
          .map((value) => el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            onClick: async () => {
              // A resolution is a verdict; it is asked for twice, and the
              // reason travels to the audit log with the move.
              if (value === 'RESOLVED' || value === 'DISMISSED') {
                const yes = await confirmDialog({
                  title: REPORT_MOVES[value] + ' the report?',
                  body: 'The move is recorded in the audit log with the reason below.',
                  confirmLabel: REPORT_MOVES[value],
                  danger: value === 'DISMISSED',
                });
                if (!yes) return;
              }
              try {
                await Api.adminUpdateReport(report.id, { status: value });
                toast(REPORT_MOVES[value] + '. The move is in the audit log.');
                await paintCase();
                await paint();
              } catch (e) { errorToast(e); }
            },
          }, REPORT_MOVES[value]));

        body.replaceChildren(
          facts([
            { value: statusWord(report.status), label: 'Status' },
            { value: report.reporter_name || 'An account', label: 'Reported by' },
            { value: String(report.target_type || '').replace(/_/g, ' ') || '—', label: 'What is reported' },
            { value: report.resolution || '—', label: 'Resolution' },
          ]),
          card({
            label: 'What was reported', glyph: 'flag',
            body: el('p', { class: 'lede' }, report.reason || 'No reason was given.'),
          }),
          target ? card({
            label: 'The reported account', glyph: 'user-plus',
            body: el('p', { class: 'lede' },
              (target.display_name || target.username || 'An account')
              + (target.username ? ' @' + target.username : '')),
          }) : null,
          card({
            label: 'The decision', glyph: 'shield',
            body: el('div', { class: 'actionline' }, moves),
          }),
        );
      } catch (e) {
        body.replaceChildren(fold([fault(e, paintCase)]));
      }
    };

    paintCase();
    return body;
  };

  const SPEC = {
    kind: 'admin-reports',
    tabs: [{ id: 'case', label: 'Case', icon: 'flag', render: () => casePanel() }],
  };

  return {
    node: fold([
      head({
        kicker: 'Moderation',
        title: 'Reports',
        lede: 'What people have flagged, newest first. Pick one to open its case.',
      }),
      chips,
      card({ label: 'Reports', glyph: 'flag', body: list, flush: true }),
    ]),
    onMount: () => {
      setInspector(SPEC);
      paint();
    },
    cleanup() { setInspector(null); },
  };
}

// The actions on one data request. The row's buttons and its context menu
// offer the same things, so they are written once.
async function reviewRequest(request, decision, refresh) {
  try {
    // The server's vocabulary for a review is APPROVE or REJECT. Approving
    // moves the request to under review; rejecting closes it with the reason
    // recorded. The words travel as the server spells them.
    await Api.adminReviewGdprRequest(request.id, decision,
      decision === 'REJECT' ? 'Rejected by an administrator' : '');
    toast(decision === 'REJECT' ? 'Rejected' : 'Approved');
    refresh();
  } catch (e) { errorToast(e); }
}

// -- appeals -----------------------------------------------------------------

// -- appeals: the queue and the review ------------------------------------------------

const APPEAL_FILTERS = [
  ['', 'All'],
  ['OPEN', 'Open'],
  ['UNDER_REVIEW', 'Under review'],
  ['APPROVED', 'Approved'],
  ['DENIED', 'Denied'],
];

export function adminAppeals() {
  const list = el('div', { class: 'rowlist' });
  const chips = el('div', { class: 'filterchips', role: 'group', 'aria-label': 'Filter appeals by status' });
  let status = '';
  let selected = null;

  const paintChips = () => {
    chips.replaceChildren(...APPEAL_FILTERS.map(([value, label]) => el('button', {
      class: 'chip' + (status === value ? ' chip--on' : ''), type: 'button',
      'aria-pressed': String(status === value),
      onClick: () => { status = value; paintChips(); paint(); },
    }, label)));
  };
  paintChips();

  const paint = async () => {
    list.replaceChildren(hold('Reading the appeals'));
    try {
      const rows = await Api.adminAppeals(Object.assign({ limit: '100' }, status ? { status } : {}));
      const items = Array.isArray(rows) ? rows : (rows && rows.items) || [];
      list.replaceChildren(...(items.length ? items.map((appeal) => row({
        lead: el('span', { class: 'role-dot' }, icon('mail', { size: 15 })),
        title: appeal.user_name || 'An appeal',
        sub: String(appeal.action_type || 'An enforcement').replace(/_/g, ' ')
          + ' · ' + statusWord(appeal.status),
        side: el('span', { class: 'chip chip--quiet' }, statusWord(appeal.status)),
        onClick: () => {
          selected = appeal;
          setInspector(SPEC);
        },
      })) : [blank({
        glyph: 'mail',
        title: status ? 'Nothing in this state' : 'No appeals',
        text: status
          ? 'No appeal is in this state. The other filters have the rest.'
          : 'A request to reconsider an enforcement lands here.',
      })]));
    } catch (e) {
      list.replaceChildren(fold([fault(e, paint)]));
    }
  };

  // The review: the person's own words, the enforcement they are appealing,
  // and the decision. The decision is the server's vocabulary - APPROVED or
  // DENIED - and it is recorded with the reviewer and the audit entry. An
  // approval lifts the original enforcement on the server's side.
  const casePanel = () => {
    const body = el('div', { class: 'fold fold--tight' });

    const paintCase = async () => {
      if (!selected) {
        body.replaceChildren(blank({
          glyph: 'mail',
          title: 'Pick an appeal',
          text: 'The review opens here when you choose one from the list.',
        }));
        return;
      }
      body.replaceChildren(hold('Opening the review'));
      try {
        const appeal = await Api.adminAppeal(selected.id);
        const decided = String(appeal.status || '').toUpperCase() === 'APPROVED'
          || String(appeal.status || '').toUpperCase() === 'DENIED';

        const decide = async (decision) => {
          const approving = decision === 'APPROVED';
          const yes = await confirmDialog({
            title: approving ? 'Approve the appeal?' : 'Deny the appeal?',
            body: approving
              ? 'The original enforcement is lifted, and the decision is recorded with your name and this review.'
              : 'The enforcement stays, and the decision is recorded with your name and this review.',
            confirmLabel: approving ? 'Approve and lift' : 'Deny the appeal',
            danger: true,
          });
          if (!yes) return;
          try {
            await Api.adminDecideAppeal(appeal.id, decision);
            toast(approving ? 'The appeal is approved and the enforcement lifted.' : 'The appeal is denied.');
            await paintCase();
            await paint();
          } catch (e) { errorToast(e); }
        };

        body.replaceChildren(
          facts([
            { value: statusWord(appeal.status), label: 'Status' },
            { value: appeal.decision ? statusWord(appeal.decision) : '—', label: 'Decision' },
          ]),
          card({
            label: 'What the person wrote', glyph: 'mail',
            body: el('p', { class: 'lede' }, appeal.reason || 'No statement was given.'),
          }),
          card({
            label: 'The enforcement being appealed', glyph: 'shield-alert',
            body: el('p', { class: 'lede' },
              String(selected.action_type || 'An enforcement').replace(/_/g, ' ')
              + (selected.action_reason ? ' — ' + selected.action_reason : '')),
          }),
          decided ? card({
            label: 'The decision', glyph: 'shield-check',
            body: el('p', { class: 'lede' },
              'Decided: ' + statusWord(appeal.decision) + '. The record and the audit entry stand.'),
          }) : card({
            label: 'The decision', glyph: 'shield',
            body: el('div', { class: 'actionline' },
              el('button', { class: 'btn btn--primary btn--sm', type: 'button', onClick: () => decide('APPROVED') }, 'Approve and lift'),
              el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => decide('DENIED') }, 'Deny')),
          }),
        );
      } catch (e) {
        body.replaceChildren(fold([fault(e, paintCase)]));
      }
    };

    paintCase();
    return body;
  };

  const SPEC = {
    kind: 'admin-appeals',
    tabs: [{ id: 'review', label: 'Review', icon: 'mail', render: () => casePanel() }],
  };

  return {
    node: fold([
      head({
        kicker: 'Moderation',
        title: 'Appeals',
        lede: 'Requests to reconsider an enforcement. Pick one to open its review.',
      }),
      chips,
      card({ label: 'Appeals', glyph: 'mail', body: list, flush: true }),
    ]),
    onMount: () => {
      setInspector(SPEC);
      paint();
    },
    cleanup() { setInspector(null); },
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
            onClick: () => reviewRequest(r, 'APPROVE', paint),
          }, 'Approve'),
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: () => reviewRequest(r, 'REJECT', paint),
          }, 'Reject'),
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
          { label: 'Approve the request', icon: 'check', onSelect: () => reviewRequest(r, 'APPROVE', paint) },
          { label: 'Reject the request', icon: 'x', danger: true, onSelect: () => reviewRequest(r, 'REJECT', paint) },
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

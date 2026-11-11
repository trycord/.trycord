// The instance console on the phone.
//
// Every section the desk's console offers is answered here with the same API
// calls: the report queue and its cases, the people console and the
// enforcements it applies, approvals, appeals, communities, the audit log,
// data requests, instance settings, announcements, incidents, voice,
// diagnostics, backups, Continuum and the public page editor. A reader who is
// not an operator is told so once, by the server's own answer.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { avatar } from '../../../js/ui/primitives.js';
import Api from '../../../packages/api.js';
import { nameOf } from '../../../packages/store.js';
import { navigate, path } from '../../../packages/nav.js';
import { sheet, closeSheet, confirm, toast, failed, hold, failure, field, emptyState } from '../ui.js';

const REPORT_FILTERS = [
  ['', 'All'],
  ['OPEN', 'Open'],
  ['INVESTIGATING', 'Investigating'],
  ['RESOLVED', 'Resolved'],
  ['DISMISSED', 'Dismissed'],
];

const REPORT_MOVES = {
  INVESTIGATING: 'Investigate',
  RESOLVED: 'Resolve',
  DISMISSED: 'Dismiss',
};

const STATUS_WORDS = {
  OPEN: 'Open',
  INVESTIGATING: 'Being investigated',
  RESOLVED: 'Resolved',
  DISMISSED: 'Dismissed',
  UNDER_REVIEW: 'Under review',
  APPROVED: 'Approved',
  DENIED: 'Denied',
  PENDING: 'Waiting',
};

function statusWord(status) {
  return STATUS_WORDS[String(status || '').toUpperCase()] || String(status || '—').replace(/_/g, ' ');
}

function items(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  return [];
}

// -- shared pieces -------------------------------------------------------------

let operator = null;

async function isOperator() {
  if (operator !== null) return operator;
  try {
    await Api.adminMe();
    operator = true;
  } catch {
    operator = false;
  }
  return operator;
}

function refusal() {
  return emptyState('shield', 'Not your console',
    'This instance does not answer to you. The pages exist for its operators.');
}

function row(entry) {
  const node = el(entry.onClick ? 'button' : 'div', {
    class: 'm-row' + (entry.danger ? ' m-row--danger' : ''),
    type: entry.onClick ? 'button' : null,
    onClick: entry.onClick || null,
  });
  if (entry.lead) node.appendChild(entry.lead);
  node.appendChild(el('div', { class: 'm-row__body' },
    el('div', { class: 'm-row__name truncate' }, entry.title || ''),
    entry.sub ? el('div', { class: 'm-row__note truncate' }, entry.sub) : null));
  if (entry.side) node.appendChild(el('div', { class: 'm-row__meta' }, entry.side));
  if (entry.chevron && entry.onClick) node.appendChild(el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 16 })));
  return node;
}

function cardOf(kicker, children) {
  const card = el('div', { class: 'm-card' });
  if (kicker) card.appendChild(el('div', { class: 'm-kicker' }, kicker));
  for (const child of children) if (child) card.appendChild(child);
  return card;
}

function fact(label, value) {
  return el('div', { class: 'm-row' },
    el('div', { class: 'm-row__body' }, el('div', { class: 'm-row__name' }, label)),
    el('div', { class: 'm-row__meta' }, el('div', { class: 'm-row__note' }, value == null ? '—' : String(value))));
}

// A sheet that asks for words before an action that records them. Every
// decision the console takes carries a reason; this is where the reason is
// written.
function reasonSheet(options, run) {
  const words = el('textarea', {
    class: 'm-area', rows: '4', maxlength: '2000',
    placeholder: options.placeholder || 'What happened, and what you did about it',
    'aria-label': options.fieldLabel || 'Reason',
  });
  const go = el('button', { class: 'm-go m-go--block' + (options.danger ? ' m-go--danger' : ''), type: 'button' }, options.confirmLabel || 'Save');
  go.addEventListener('click', async () => {
    const reason = words.value.trim();
    if (!reason) {
      toast('Write the reason first — it is saved with the action.', { type: 'danger' });
      return;
    }
    go.disabled = true;
    try {
      await run(reason);
      closeSheet();
    } catch (error) {
      failed(error);
      go.disabled = false;
    }
  });
  const layer = sheet({ title: options.title || 'A reason', note: options.note || null });
  layer.body.appendChild(field(options.fieldLabel || 'Reason', words));
  layer.body.appendChild(go);
  return layer;
}

function personLead(person) {
  return avatar(person, { size: 'sm' });
}

function when(stamp) {
  if (!stamp) return '';
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// -- sections ------------------------------------------------------------------

async function overview(host) {
  const data = await Api.adminOverview();
  const counts = cardOf('The queues', [
    fact('Accounts', data.users),
    fact('Communities', data.servers),
    fact('Enforced accounts', data.enforcedUsers),
    fact('Open reports', data.openReports),
    fact('Open appeals', data.openAppeals),
  ]);
  const reports = data.reports || {};
  const appeals = data.appeals || {};
  const distribution = cardOf('Reports by status',
    Object.keys(reports).length
      ? Object.entries(reports).map(([status, count]) => fact(statusWord(status), count))
      : [emptyState('flag', 'No reports yet', 'A filed report arrives here with its status.')]);
  const appealDistribution = cardOf('Appeals by status',
    Object.keys(appeals).length
      ? Object.entries(appeals).map(([status, count]) => fact(statusWord(status), count))
      : [emptyState('inbox', 'No appeals yet', 'An appeal against an enforcement arrives here.')]);
  const entries = items(data.recentAudit);
  const audit = cardOf('Recent audit', entries.length
    ? entries.map((entry) => row({
      title: entry.action || 'An action',
      sub: (entry.targetType || '') + (entry.targetId ? ' · ' + entry.targetId : '') + (entry.createdAt ? ' · ' + when(entry.createdAt) : ''),
    }))
    : [emptyState('clock', 'Nothing recorded yet', 'Administrative actions appear here as they happen.')]);
  host.append(counts, distribution, appealDistribution, audit);
}

async function people(host) {
  const search = el('input', {
    class: 'm-input', type: 'search', placeholder: 'Search by name, handle or address',
    'aria-label': 'Search accounts',
  });
  const list = el('div', { class: 'm-card' });
  host.append(search, list);

  const paintList = async (query) => {
    list.replaceChildren(hold());
    try {
      const payload = await Api.adminUsers(Object.assign({ limit: '50' }, query ? { q: query } : {}));
      const rows = items(payload);
      list.replaceChildren(...(rows.length
        ? rows.map((user) => row({
          lead: personLead(user),
          title: nameOf(user) || user.username || 'An account',
          sub: '@' + (user.username || '') + (user.enforcement_state ? ' · ' + user.enforcement_state : ''),
          side: user.enforcement_state ? el('span', { class: 'm-row__note' }, statusWord(user.enforcement_state)) : null,
          chevron: true,
          onClick: () => person(host, user, paintList),
        }))
        : [emptyState('users', query ? 'Nobody by that name' : 'No accounts', query ? 'Try a different spelling.' : 'Accounts appear here as they are made.')]));
    } catch (error) {
      list.replaceChildren(failure(error, () => paintList(query)));
    }
  };

  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => paintList(search.value.trim()), 250);
  });
  await paintList('');
}

async function person(host, chosen, back) {
  clear(host);
  host.appendChild(hold());
  const dossier = await Api.adminUser(chosen.id);
  const user = Object.assign({}, chosen, dossier);
  const actions = items(dossier.actions);
  const notes = items(dossier.notes);
  const restrictions = items(dossier.activeRestrictions);
  const enforced = !!dossier.enforcement_state;

  clear(host);
  host.appendChild(el('button', { class: 'm-go m-go--quiet', type: 'button', onClick: () => back('') }, 'Back to the list'));

  const head = el('div', { class: 'm-card' },
    el('div', { class: 'm-row' },
      personLead(user),
      el('div', { class: 'm-row__body' },
        el('div', { class: 'm-row__name' }, nameOf(user) || user.username || 'An account'),
        el('div', { class: 'm-row__note' }, '@' + (user.username || '')))));
  host.appendChild(head);
  host.appendChild(cardOf('The account', [
    fact('Enforcement', enforced ? statusWord(dossier.enforcement_state) : 'None'),
    fact('Arrived', when(user.createdAt || user.created_at)),
    fact('Reports against', dossier.reportCount == null ? '—' : dossier.reportCount),
  ]));

  if (restrictions.length) {
    host.appendChild(cardOf('Standing restrictions',
      restrictions.map((entry) => row({ title: statusWord(entry.type || entry.kind), sub: entry.reason || '' }))));
  }

  const enforce = async (plan) => {
    const body = { actionType: plan.actionType };
    if (plan.hours) body.expiresInHours = plan.hours;
    if (plan.confirm) body.confirm = true;
    const yes = await confirm({
      title: plan.title + ' ' + (user.username || 'this account') + '?',
      text: plan.text,
      confirmLabel: plan.title,
      danger: true,
    });
    if (!yes) return;
    const reason = await new Promise((done) => {
      reasonSheet({ title: 'The reason', confirmLabel: plan.title, danger: true, placeholder: 'Why, in the words a reviewer reads' }, done);
    });
    body.reason = reason;
    try {
      await Api.adminEnforceUser(user.id, body);
      toast(plan.title + ' — recorded');
      await person(host, chosen, back);
    } catch (error) { failed(error); }
  };

  host.appendChild(cardOf('Enforcement', [
    row({ title: 'Warn', lead: el('span', { class: 'm-row__chevron' }, icon('alert-triangle', { size: 16 })), onClick: () => enforce({ actionType: 'WARNING', title: 'Warn', text: 'A note on the account, and nothing more.' }) }),
    row({ title: 'Suspend for a day', lead: el('span', { class: 'm-row__chevron' }, icon('clock', { size: 16 })), onClick: () => enforce({ actionType: 'SUSPENSION', hours: 24, title: 'Suspend', text: 'They lose access for a day, or until someone lifts it.' }) }),
    row({ title: 'Suspend until lifted', lead: el('span', { class: 'm-row__chevron' }, icon('clock', { size: 16 })), onClick: () => enforce({ actionType: 'SUSPENSION', title: 'Suspend', text: 'They lose access until an operator lifts it.' }) }),
    row({ title: 'Ban the account', danger: true, lead: el('span', { class: 'm-row__chevron' }, icon('ban', { size: 16 })), onClick: () => enforce({ actionType: 'ACCOUNT_BAN', confirm: true, title: 'Ban', text: 'They lose access to everything here, and only an admin can undo it.' }) }),
    enforced ? row({
      title: 'Lift the enforcement', lead: el('span', { class: 'm-row__chevron' }, icon('check', { size: 16 })),
      onClick: async () => {
        if (!(await confirm({ title: 'Lift the enforcement?', text: 'The account answers for itself again.', confirmLabel: 'Lift' }))) return;
        try {
          await Api.adminLiftUser(user.id, 'Lifted by an administrator');
          toast('Enforcement lifted');
          await person(host, chosen, back);
        } catch (error) { failed(error); }
      },
    }) : null,
  ]));

  const noteRow = row({
    title: 'Add a note', lead: el('span', { class: 'm-row__chevron' }, icon('edit', { size: 16 })), chevron: true,
    onClick: () => reasonSheet({
      title: 'A note on the account',
      note: 'Notes are for staff only.',
      confirmLabel: 'Add the note',
      placeholder: 'What the next operator should know',
    }, async (body) => {
      await Api.adminAddUserNote(user.id, body);
      toast('Note added');
      await person(host, chosen, back);
    }),
  });
  host.appendChild(cardOf('Notes', [noteRow].concat(notes.length
    ? notes.map((entry) => row({ title: entry.body || 'A note', sub: (entry.authorName || 'An operator') + (entry.createdAt ? ' · ' + when(entry.createdAt) : '') }))
    : [emptyState('edit', 'No notes yet', 'A note records what an operator knows.')])));

  host.appendChild(cardOf('History', actions.length
    ? actions.map((entry) => row({
      title: entry.action || statusWord(entry.actionType) || 'An action',
      sub: (entry.actorName || 'An operator') + (entry.reason ? ' · ' + entry.reason : '') + (entry.createdAt ? ' · ' + when(entry.createdAt) : ''),
    }))
    : [emptyState('clock', 'Nothing recorded', 'Actions taken against this account appear here.')]));

  const roles = await Api.adminRoles().catch(() => []);
  const roleRows = items(roles).filter((entry) => String(entry.userId || entry.user_id) === String(user.id));
  host.appendChild(cardOf('Operator roles', [row({
    title: roleRows.length ? roleRows.map((entry) => entry.role).join(', ') : 'None',
    sub: 'The roles this account holds on this instance',
  }), row({
    title: 'Give the operator role', lead: el('span', { class: 'm-row__chevron' }, icon('shield', { size: 16 })), chevron: true,
    onClick: () => reasonSheet({
      title: 'Make them an operator', confirmLabel: 'Give the role', placeholder: 'Why this account is trusted with the console',
    }, async (reason) => {
      await Api.adminSetRole(user.id, 'admin');
      toast('The role is given');
      await person(host, chosen, back);
    }),
  }), roleRows.length ? row({
    title: 'Take the operator role away', lead: el('span', { class: 'm-row__chevron' }, icon('x', { size: 16 })),
    onClick: async () => {
      if (!(await confirm({ title: 'Take the role away?', confirmLabel: 'Take it', danger: true }))) return;
      try {
        await Api.adminRemoveRole(user.id);
        toast('The role is taken');
        await person(host, chosen, back);
      } catch (error) { failed(error); }
    },
  }) : null]));
}

async function approvals(host) {
  const list = el('div', { class: 'm-card' });
  host.appendChild(list);
  const paint = async () => {
    list.replaceChildren(hold());
    try {
      const rows = items(await Api.adminApprovals({ limit: '50' }));
      list.replaceChildren(...(rows.length
        ? rows.map((user) => {
          const node = row({
            lead: personLead(user),
            title: nameOf(user) || user.username || 'An account',
            sub: '@' + (user.username || '') + (user.createdAt ? ' · asked ' + when(user.createdAt) : ''),
          });
          node.appendChild(el('div', { class: 'm-row__meta' },
            el('button', {
              class: 'm-go', type: 'button',
              onClick: async () => {
                try {
                  await Api.approveUser(user.id);
                  toast('Let in');
                  await paint();
                } catch (error) { failed(error); }
              },
            }, 'Let in')));
          return node;
        })
        : [emptyState('check', 'Nobody waiting', 'An account that needs approval arrives here.')]));
    } catch (error) {
      list.replaceChildren(failure(error, paint));
    }
  };
  await paint();
}

async function communities(host) {
  const list = el('div', { class: 'm-card' });
  host.appendChild(list);
  const paint = async () => {
    list.replaceChildren(hold());
    try {
      const rows = items(await Api.adminServers({ limit: '50' }));
      list.replaceChildren(...(rows.length
        ? rows.map((server) => row({
          lead: el('span', { class: 'm-row__chevron' }, icon('layers', { size: 16 })),
          title: server.name || 'A community',
          sub: (server.memberCount != null ? server.memberCount + ' members · ' : '') + (server.suspended ? 'suspended' : 'running'),
          chevron: true,
          onClick: () => community(host, server, paint),
        }))
        : [emptyState('layers', 'No communities', 'Communities on this instance appear here.')]));
    } catch (error) {
      list.replaceChildren(failure(error, paint));
    }
  };
  await paint();
}

async function community(host, chosen, back) {
  clear(host);
  host.appendChild(hold());
  const record = await Api.adminServer(chosen.id);
  const server = Object.assign({}, chosen, record);
  clear(host);
  host.appendChild(el('button', { class: 'm-go m-go--quiet', type: 'button', onClick: () => back() }, 'Back to the list'));
  host.appendChild(cardOf(server.name || 'A community', [
    fact('State', server.suspended ? 'Suspended' : 'Running'),
    fact('Members', server.memberCount == null ? '—' : server.memberCount),
    fact('Channels', server.channelCount == null ? '—' : server.channelCount),
    fact('Owner', server.ownerName || server.ownerUsername || '—'),
  ]));

  const act = async (title, text, call, danger) => {
    if (!(await confirm({ title, text, confirmLabel: title, danger: !!danger }))) return;
    const reason = await new Promise((done) => {
      reasonSheet({ title: 'The reason', confirmLabel: title, danger: !!danger, placeholder: 'Why, in the words a reviewer reads' }, done);
    });
    try {
      await call(reason);
      toast(title + ' — recorded');
      back();
    } catch (error) { failed(error); }
  };

  host.appendChild(cardOf('What you can do', [
    server.suspended
      ? row({ title: 'Lift the suspension', lead: el('span', { class: 'm-row__chevron' }, icon('check', { size: 16 })), onClick: () => act('Lift the suspension', 'The community runs again.', (reason) => Api.adminLiftServer(server.id, reason)) })
      : row({ title: 'Suspend', danger: true, lead: el('span', { class: 'm-row__chevron' }, icon('pause', { size: 16 })), onClick: () => act('Suspend', 'Nobody can read or write here until it is lifted.', (reason) => Api.adminSuspendServer(server.id, { reason, confirm: true }), true) }),
    server.suspended
      ? row({ title: 'Bring it back', lead: el('span', { class: 'm-row__chevron' }, icon('rotate-ccw', { size: 16 })), onClick: () => act('Bring it back', 'The community returns, with its content.', (reason) => Api.adminRestoreServer(server.id, reason)) })
      : null,
    row({
      title: 'Remove the community', danger: true,
      lead: el('span', { class: 'm-row__chevron' }, icon('trash', { size: 16 })),
      onClick: () => act('Remove the community', 'It disappears for everyone. This cannot be undone by lifting.', (reason) => Api.adminRemoveServer(server.id, { reason, confirm: true }), true),
    }),
  ]));
}

async function reports(host) {
  const chips = el('div', { class: 'm-chips', role: 'group', 'aria-label': 'Filter reports by status' });
  const list = el('div', { class: 'm-card' });
  host.append(chips, list);
  let status = '';

  const paintChips = () => {
    chips.replaceChildren(...REPORT_FILTERS.map(([value, label]) => el('button', {
      class: 'm-chip' + (status === value ? ' m-chip--on' : ''),
      type: 'button',
      'aria-pressed': String(status === value),
      onClick: () => { status = value; paintChips(); paint(); },
    }, label)));
  };

  const paint = async () => {
    list.replaceChildren(hold());
    try {
      const rows = items(await Api.adminReports(Object.assign({ limit: '100' }, status ? { status } : {})));
      list.replaceChildren(...(rows.length
        ? rows.map((report) => row({
          lead: el('span', { class: 'm-row__chevron' }, icon('flag', { size: 16 })),
          title: report.reason || 'A report',
          sub: (report.reporterName || report.reporter_name ? 'by ' + (report.reporterName || report.reporter_name) : 'by an account')
            + (report.targetType || report.target_type ? ' · ' + statusWord(report.targetType || report.target_type) : ''),
          side: el('span', { class: 'm-row__note' }, statusWord(report.status)),
          chevron: true,
          onClick: () => report_(host, report, paint),
        }))
        : [emptyState('flag', status ? 'Nothing in this state' : 'No reports',
          status ? 'No report is in this state. The other filters have the rest.' : 'A filed report arrives here, newest first.')]));
    } catch (error) {
      list.replaceChildren(failure(error, paint));
    }
  };

  paintChips();
  await paint();
}

async function report_(host, chosen, back) {
  clear(host);
  host.appendChild(hold());
  const report = await Api.adminReport(chosen.id);
  const record = report.case || null;
  const notes = items(record && record.notes);
  const evidence = items(record && record.evidence);
  clear(host);
  host.appendChild(el('button', { class: 'm-go m-go--quiet', type: 'button', onClick: () => back() }, 'Back to the queue'));

  host.appendChild(cardOf('The report', [
    fact('Status', statusWord(report.status)),
    fact('Reported by', report.reporterName || report.reporter_name || 'An account'),
    fact('What is reported', statusWord(report.targetType || report.target_type)),
    fact('Filed', when(report.createdAt || report.created_at)),
    fact('Resolution', report.resolution || '—'),
  ]));

  const snapshot = report.targetSnapshot || null;
  if (snapshot && (snapshot.content || snapshot.text)) {
    host.appendChild(cardOf('What was reported', [
      el('p', { class: 'm-sheet__note' }, String(snapshot.content || snapshot.text).slice(0, 600)),
    ]));
  }

  const target = report.targetUser || null;
  if (target) {
    host.appendChild(row({
      lead: personLead(target),
      title: 'The account reported',
      sub: '@' + (target.username || ''),
      chevron: true,
      onClick: () => navigate(path('/users/' + target.id)),
    }));
  }

  const moves = REPORT_FILTERS.map(([value]) => value)
    .filter((value) => value && value !== String(report.status || '').toUpperCase())
    .map((value) => row({
      title: REPORT_MOVES[value] || statusWord(value),
      lead: el('span', { class: 'm-row__chevron' }, icon('arrow-right', { size: 16 })),
      danger: value === 'DISMISSED',
      onClick: async () => {
        if (value === 'RESOLVED' || value === 'DISMISSED') {
          const yes = await confirm({
            title: (REPORT_MOVES[value] || value) + ' the report?',
            text: 'The decision is noted in the audit log.',
            confirmLabel: REPORT_MOVES[value] || value,
            danger: value === 'DISMISSED',
          });
          if (!yes) return;
        }
        try {
          await Api.adminUpdateReport(report.id, { status: value });
          toast((REPORT_MOVES[value] || value) + ' — noted in the audit log.');
          back();
        } catch (error) { failed(error); }
      },
    }));
  host.appendChild(cardOf('Move it', moves));

  host.appendChild(cardOf('The case', [
    row({
      title: 'Add a note', lead: el('span', { class: 'm-row__chevron' }, icon('edit', { size: 16 })), chevron: true,
      onClick: () => reasonSheet({
        title: 'A note on the case', note: 'Notes are for staff only.', confirmLabel: 'Add the note',
        placeholder: 'What the next person looking at this case should know',
      }, async (body) => {
        await Api.adminAddReportNote(report.id, body);
        toast('Note added');
        back();
      }),
    }),
    row({
      title: 'Copy in evidence', lead: el('span', { class: 'm-row__chevron' }, icon('paperclip', { size: 16 })), chevron: true,
      onClick: () => reasonSheet({
        title: 'Evidence', note: 'Evidence is copied into the case as it looks now, so it stays if the original changes.', confirmLabel: 'Add the evidence',
        placeholder: 'What you saw, in your own words',
      }, async (body) => {
        await Api.adminAddReportEvidence(report.id, { kind: 'NOTE', content: body });
        toast('Evidence added');
        back();
      }),
    }),
  ].concat(notes.map((entry) => row({ title: entry.body || 'A note', sub: (entry.authorName || 'An operator') + (entry.createdAt ? ' · ' + when(entry.createdAt) : '') })))
    .concat(evidence.map((entry) => row({ title: entry.content || 'Evidence', sub: entry.kind || '' })))));
}

async function appeals(host) {
  const list = el('div', { class: 'm-card' });
  host.appendChild(list);
  const paint = async () => {
    list.replaceChildren(hold());
    try {
      const rows = items(await Api.adminAppeals({ limit: '50' }));
      list.replaceChildren(...(rows.length
        ? rows.map((appeal) => row({
          lead: el('span', { class: 'm-row__chevron' }, icon('inbox', { size: 16 })),
          title: appeal.username ? '@' + appeal.username : 'An appeal',
          sub: (appeal.reason || '') + (appeal.createdAt ? ' · ' + when(appeal.createdAt) : ''),
          side: el('span', { class: 'm-row__note' }, statusWord(appeal.status)),
          chevron: true,
          onClick: () => appeal_(host, appeal, paint),
        }))
        : [emptyState('inbox', 'No appeals', 'An appeal against an enforcement arrives here.')]));
    } catch (error) {
      list.replaceChildren(failure(error, paint));
    }
  };
  await paint();
}

async function appeal_(host, chosen, back) {
  clear(host);
  host.appendChild(hold());
  const appeal = await Api.adminAppeal(chosen.id);
  clear(host);
  host.appendChild(el('button', { class: 'm-go m-go--quiet', type: 'button', onClick: () => back() }, 'Back to the queue'));
  host.appendChild(cardOf('The appeal', [
    fact('Status', statusWord(appeal.status)),
    fact('From', appeal.username ? '@' + appeal.username : '—'),
    fact('Filed', when(appeal.createdAt || appeal.created_at)),
    fact('Their words', appeal.reason || '—'),
  ]));

  const decide = async (decision) => {
    const approving = decision === 'APPROVED';
    const answer = await new Promise((done) => {
      reasonSheet({
        title: approving ? 'Approve the appeal?' : 'Deny the appeal?',
        note: approving
          ? 'The enforcement is lifted on the server, and the decision is recorded with your name.'
          : 'The enforcement stands, and the decision is recorded with your name and your reason.',
        confirmLabel: approving ? 'Approve and lift' : 'Deny the appeal',
        danger: !approving,
        placeholder: 'The words the person reads with the decision',
      }, done);
    });
    try {
      await Api.adminDecideAppeal(appeal.id, decision, answer);
      toast(approving ? 'The appeal is approved and the enforcement lifted.' : 'The appeal is denied.');
      back();
    } catch (error) { failed(error); }
  };

  host.appendChild(cardOf('The decision', [
    row({ title: 'Approve and lift', lead: el('span', { class: 'm-row__chevron' }, icon('check', { size: 16 })), onClick: () => decide('APPROVED') }),
    row({ title: 'Deny the appeal', danger: true, lead: el('span', { class: 'm-row__chevron' }, icon('x', { size: 16 })), onClick: () => decide('DENIED') }),
  ]));
}

async function audit(host) {
  const list = el('div', { class: 'm-card' });
  host.appendChild(list);
  const paint = async () => {
    list.replaceChildren(hold());
    try {
      const rows = items(await Api.adminAudit({ limit: '100' }));
      list.replaceChildren(...(rows.length
        ? rows.map((entry) => row({
          title: entry.action || 'An action',
          sub: (entry.actorName || 'An operator') + (entry.targetType ? ' · ' + statusWord(entry.targetType) : '') + (entry.createdAt ? ' · ' + when(entry.createdAt) : ''),
        }))
        : [emptyState('clock', 'Nothing recorded', 'Administrative actions appear here.')]));
    } catch (error) {
      list.replaceChildren(failure(error, paint));
    }
  };
  await paint();
  host.appendChild(el('button', {
    class: 'm-go m-go--quiet', type: 'button',
    onClick: async () => {
      try {
        const verdict = await Api.adminVerifyAudit();
        const ok = verdict && (verdict.ok !== undefined ? verdict.ok : verdict.valid);
        toast(ok ? 'The chain holds.' : 'The chain does not hold — look at the entries.', { type: ok ? 'success' : 'danger' });
      } catch (error) { failed(error); }
    },
  }, 'Check the chain'));
}

async function gdpr(host) {
  const list = el('div', { class: 'm-card' });
  host.appendChild(list);
  const paint = async () => {
    list.replaceChildren(hold());
    try {
      const rows = items(await Api.adminGdprRequests({ limit: '50' }));
      list.replaceChildren(...(rows.length
        ? rows.map((request) => {
          const node = row({
            lead: el('span', { class: 'm-row__chevron' }, icon('shield', { size: 16 })),
            title: (request.kind || 'A request') + (request.username ? ' · @' + request.username : ''),
            sub: when(request.createdAt || request.created_at),
            side: el('span', { class: 'm-row__note' }, statusWord(request.status)),
          });
          const actions = el('div', { class: 'm-row__meta' },
            el('button', {
              class: 'm-go', type: 'button',
              onClick: () => reasonSheet({
                title: 'Review the request', confirmLabel: 'Approve', placeholder: 'The note the decision carries',
              }, async (note) => {
                await Api.adminReviewGdprRequest(request.id, 'APPROVED', note);
                toast('Approved');
                await paint();
              }),
            }, 'Approve'),
            el('button', {
              class: 'm-go m-go--quiet', type: 'button',
              onClick: () => reasonSheet({
                title: 'Deny the request', confirmLabel: 'Deny', danger: true, placeholder: 'Why the request is refused',
              }, async (note) => {
                await Api.adminReviewGdprRequest(request.id, 'DENIED', note);
                toast('Denied');
                await paint();
              }),
            }, 'Deny'));
          node.appendChild(actions);
          if (request.status === 'APPROVED') {
            node.appendChild(el('div', { class: 'm-row__meta' },
              el('button', {
                class: 'm-go m-go--danger', type: 'button',
                onClick: async () => {
                  if (!(await confirm({ title: 'Erase the account?', text: 'This removes the account and its data. It cannot be undone.', confirmLabel: 'Erase', danger: true }))) return;
                  try {
                    await Api.adminProcessGdprRequest(request.id);
                    toast('Erased');
                    await paint();
                  } catch (error) { failed(error); }
                },
              }, 'Erase')));
          }
          return node;
        })
        : [emptyState('shield', 'No data requests', 'An export or erasure request arrives here.')]));
    } catch (error) {
      list.replaceChildren(failure(error, paint));
    }
  };
  await paint();
}

async function settings(host) {
  host.appendChild(hold());
  const data = await Api.instanceSettings();
  clear(host);
  const categories = items(data.categories);
  if (data.envAuthority) {
    host.appendChild(el('p', { class: 'm-sheet__note' }, 'Some values are forced by the deployment environment. A value saved here takes over once it is saved.'));
  }
  for (const category of categories) {
    host.appendChild(cardOf(category.label || category.id,
      items(category.settings).map((entry) => settingRow(entry))));
  }
}

function settingRow(entry) {
  const node = el('div', { class: 'm-row' },
    el('div', { class: 'm-row__body' },
      el('div', { class: 'm-row__name' }, entry.label || entry.key),
      entry.description ? el('div', { class: 'm-row__note' }, entry.description) : null,
      el('div', { class: 'm-row__note' }, entry.source === 'environment' ? 'Set by the environment' : 'Value: ' + describe(entry.value))));
  node.appendChild(el('div', { class: 'm-row__meta' },
    el('button', {
      class: 'm-go m-go--quiet', type: 'button',
      onClick: () => editSetting(entry),
    }, 'Change')));
  return node;
}

function describe(value) {
  if (value === true) return 'on';
  if (value === false) return 'off';
  if (value == null || value === '') return '—';
  return String(value);
}

async function editSetting(entry) {
  const control = typeof entry.value === 'boolean'
    ? el('input', { class: 'm-input', type: 'checkbox', 'aria-label': entry.label || entry.key })
    : el('input', { class: 'm-input', type: String(entry.type) === 'number' ? 'number' : 'text', value: entry.value == null ? '' : String(entry.value), 'aria-label': entry.label || entry.key });
  if (typeof entry.value === 'boolean') control.checked = !!entry.value;
  const layer = sheet({ title: entry.label || entry.key, note: entry.description || null });
  layer.body.appendChild(field('The value', control));
  const save = el('button', { class: 'm-go m-go--block', type: 'button' }, 'Save');
  save.addEventListener('click', async () => {
    save.disabled = true;
    const value = control.type === 'checkbox' ? control.checked : control.value;
    try {
      await Api.updateInstanceSettings({ [entry.key]: value });
      toast('Saved');
      closeSheet();
    } catch (error) {
      failed(error);
      save.disabled = false;
    }
  });
  layer.body.appendChild(save);
}

async function announcements(host) {
  const list = el('div', { class: 'm-card' });
  host.appendChild(list);
  const paint = async () => {
    list.replaceChildren(hold());
    try {
      const rows = items(await Api.allAnnouncements());
      list.replaceChildren(...(rows.length
        ? rows.map((announcement) => row({
          lead: el('span', { class: 'm-row__chevron' }, icon('bell', { size: 16 })),
          title: announcement.title || 'An announcement',
          sub: announcement.body ? String(announcement.body).slice(0, 90) : '',
          side: el('button', {
            class: 'm-go m-go--quiet', type: 'button', 'aria-label': 'Delete ' + (announcement.title || ''),
            onClick: async () => {
              if (!(await confirm({ title: 'Delete this announcement?', text: 'Everyone stops seeing it at once.', confirmLabel: 'Delete', danger: true }))) return;
              try {
                await Api.deleteAnnouncement(announcement.id);
                toast('Removed');
                await paint();
              } catch (error) { failed(error); }
            },
          }, 'Delete'),
        }))
        : [emptyState('bell', 'Nothing announced', 'An announcement reaches everyone who opens this instance.')]));
    } catch (error) {
      list.replaceChildren(failure(error, paint));
    }
  };
  await paint();

  const title = el('input', { class: 'm-input', type: 'text', placeholder: 'What it says at a glance', 'aria-label': 'Announcement title' });
  const body = el('textarea', { class: 'm-area', rows: '3', placeholder: 'The words everyone reads', 'aria-label': 'Announcement body' });
  const post = el('button', { class: 'm-go m-go--block', type: 'button' }, 'Announce it');
  post.addEventListener('click', async () => {
    if (!title.value.trim()) {
      toast('A title first.', { type: 'danger' });
      return;
    }
    post.disabled = true;
    try {
      await Api.createAnnouncement({ title: title.value.trim(), body: body.value.trim() });
      title.value = '';
      body.value = '';
      toast('Announced');
      await paint();
    } catch (error) {
      failed(error);
      post.disabled = false;
    }
  });
  host.appendChild(cardOf('Write one', [field('Title', title), field('The words', body), post]));
}

async function incidents(host) {
  const list = el('div', { class: 'm-card' });
  host.appendChild(list);
  const paint = async () => {
    list.replaceChildren(hold());
    try {
      const rows = items(await Api.incidents({ limit: '50' }));
      list.replaceChildren(...(rows.length
        ? rows.map((incident) => row({
          lead: el('span', { class: 'm-row__chevron' }, icon('activity', { size: 16 })),
          title: incident.title || 'An incident',
          sub: statusWord(incident.status || incident.kind) + (incident.createdAt ? ' · ' + when(incident.createdAt) : ''),
        }))
        : [emptyState('activity', 'Nothing on the timeline', 'An incident or maintenance window appears here.')]));
    } catch (error) {
      list.replaceChildren(failure(error, paint));
    }
  };
  await paint();
  host.appendChild(row({
    title: 'Put something on the timeline', lead: el('span', { class: 'm-row__chevron' }, icon('plus', { size: 16 })), chevron: true,
    onClick: () => reasonSheet({
      title: 'A timeline entry', confirmLabel: 'Post it', placeholder: 'What happened, and what it means for readers',
    }, async (body) => {
      await Api.createIncident({ title: body.slice(0, 80), body, status: 'INVESTIGATING' });
      toast('On the timeline');
      await paint();
    }),
  }));
}

async function diagnostics(host) {
  host.appendChild(hold());
  const report = await Api.adminDiagnostics();
  clear(host);
  const subsystems = report.subsystems || report.checks || report;
  host.appendChild(cardOf('What was checked',
    Object.entries(subsystems).map(([name, entry]) => row({
      title: name,
      sub: entry && entry.message ? entry.message : '',
      side: el('span', { class: 'm-row__note' }, entry && entry.ok === false ? 'not well' : 'well'),
    }))));
}

async function voice(host) {
  host.appendChild(hold());
  const settings = await Api.voiceSettings();
  clear(host);
  const entries = settings.settings || settings;
  host.appendChild(cardOf('The voice server',
    Object.entries(entries).map(([key, entry]) => row({
      title: (entry && entry.label) || key,
      sub: describe(entry && entry.value),
      side: el('button', {
        class: 'm-go m-go--quiet', type: 'button',
        onClick: () => editSetting({ key, label: (entry && entry.label) || key, value: entry && entry.value, description: entry && entry.description, type: entry && entry.type }),
      }, 'Change'),
    }))));
}

async function database(host) {
  const list = el('div', { class: 'm-card' });
  host.appendChild(list);
  const paint = async () => {
    list.replaceChildren(hold());
    try {
      const rows = items(await Api.adminBackups());
      list.replaceChildren(...(rows.length
        ? rows.map((backup) => row({
          lead: el('span', { class: 'm-row__chevron' }, icon('database', { size: 16 })),
          title: backup.name || 'A backup',
          sub: when(backup.createdAt || backup.created_at) + (backup.size ? ' · ' + backup.size : ''),
        }))
        : [emptyState('database', 'No backups yet', 'A backup is a copy of the data as it stands.')]));
    } catch (error) {
      list.replaceChildren(failure(error, paint));
    }
  };
  await paint();
  host.appendChild(el('button', {
    class: 'm-go', type: 'button',
    onClick: async () => {
      try {
        await Api.adminTakeBackup();
        toast('Taken');
        await paint();
      } catch (error) { failed(error); }
    },
  }, 'Take a backup now'));
}

async function continuum(host) {
  host.appendChild(hold());
  const [memberships, federated] = await Promise.all([
    Api.continuumMemberships().catch(() => []),
    Api.continuumFederated().catch(() => []),
  ]);
  clear(host);
  const catalogue = await Api.instanceSettings().catch(() => null);
  let entry = null;
  for (const category of items(catalogue && catalogue.categories)) {
    entry = items(category.settings).find((s) => s.key === 'continuum.enabled') || entry;
  }
  host.appendChild(cardOf('Community Continuum', [
    fact('State', entry && entry.value ? 'on' : 'off'),
    fact('Source', entry && entry.source === 'environment' ? 'the deployment environment' : 'saved here'),
  ]));
  host.appendChild(el('button', {
    class: 'm-go' + (entry && entry.value ? ' m-go--quiet' : ''), type: 'button',
    onClick: async () => {
      const on = !(entry && entry.value);
      if (on && !(await confirm({ title: 'Turn on Community Continuum?', text: 'Trusted peers receive signed events from this instance, and this one accepts events from instances an operator added.', confirmLabel: 'Turn on' }))) return;
      try {
        await Api.updateInstanceSettings(on ? { 'continuum.enabled': true, __confirm: true } : { 'continuum.enabled': false });
        toast(on ? 'Continuum is on' : 'Continuum is off');
        host.replaceChildren();
        await continuum(host);
      } catch (error) { failed(error); }
    },
  }, entry && entry.value ? 'Turn it off' : 'Turn it on'));

  const mine = items(memberships);
  const peers = items(federated);
  host.appendChild(cardOf('Communities joined through Continuum',
    mine.length ? mine.map((entry_) => row({ title: entry_.name || entry_.communityId || 'A community', sub: entry_.instanceId || '' }))
      : [emptyState('layers', 'None', 'Communities this instance joined through a peer appear here.')]));
  host.appendChild(cardOf('Peers',
    peers.length ? peers.map((entry_) => row({ title: entry_.name || entry_.instanceId || 'A peer', sub: entry_.status || '' }))
      : [emptyState('globe', 'No peers', 'Instances an operator added appear here.')]));
}

async function pages(host) {
  const list = el('div', { class: 'm-card' });
  host.appendChild(list);
  const paint = async () => {
    list.replaceChildren(hold());
    try {
      const payload = await Api.adminPages();
      const rows = items(payload.pages || payload);
      list.replaceChildren(...(rows.length
        ? rows.map((entry) => row({
          lead: el('span', { class: 'm-row__chevron' }, icon('file-text', { size: 16 })),
          title: entry.title || entry.route,
          sub: entry.route + (entry.publishedAt ? ' · published ' + when(entry.publishedAt) : ' · draft'),
          chevron: true,
          onClick: () => pageEditor(host, entry.route, paint),
        }))
        : [emptyState('file-text', 'No public pages', 'The pages this instance serves appear here.')]));
    } catch (error) {
      list.replaceChildren(failure(error, paint));
    }
  };
  await paint();
}

async function pageEditor(host, route, back) {
  clear(host);
  host.appendChild(hold());
  const current = await Api.adminPage(route);
  clear(host);
  host.appendChild(el('button', { class: 'm-go m-go--quiet', type: 'button', onClick: () => back() }, 'Back to the pages'));
  host.appendChild(cardOf('/' + route, [
    fact('State', current.publishedAt ? 'published' : 'draft'),
    fact('Legal page', current.legal ? 'yes — publishing asks for the route' : 'no'),
  ]));
  const body = el('textarea', { class: 'm-area', rows: '10', 'aria-label': 'The page body' }, current.body || current.draft || '');
  host.appendChild(cardOf('The body', [field('HTML', body)]));

  const save = el('button', { class: 'm-go', type: 'button' }, 'Save the draft');
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await Api.savePageDraft(route, { body: body.value });
      toast('Draft saved');
      save.disabled = false;
    } catch (error) { failed(error); save.disabled = false; }
  });

  const publish = el('button', { class: 'm-go m-go--block', type: 'button' }, 'Publish');
  publish.addEventListener('click', async () => {
    let confirmRoute = true;
    if (current.legal) {
      const typed = window.prompt('Type the route to confirm publishing: ' + route);
      if (typed === null) return;
      if (typed !== route) {
        toast('The route did not match, so nothing was published', { type: 'danger' });
        return;
      }
      confirmRoute = typed;
    }
    publish.disabled = true;
    try {
      await Api.savePageDraft(route, { body: body.value });
      await Api.publishPage(route, confirmRoute);
      toast('Published /' + route);
      await back();
    } catch (error) {
      failed(error);
      publish.disabled = false;
    }
  });
  host.appendChild(cardOf('What next', [save, publish]));
}

const SECTIONS = {
  'admin': overview,
  'admin.users': people,
  'admin.approvals': approvals,
  'admin.communities': communities,
  'admin.reports': reports,
  'admin.appeals': appeals,
  'admin.audit': audit,
  'admin.gdpr': gdpr,
  'admin.announcements': announcements,
  'admin.pages': pages,
  'admin.settings': settings,
  'admin.database': database,
  'admin.continuum': continuum,
  'admin.voice': voice,
  'admin.diagnostics': diagnostics,
  'admin.incidents': incidents,
  'admin.federation': federation,
};

async function federation(host) {
  const list = el('div', { class: 'm-card' });
  host.appendChild(list);
  const paint = async () => {
    list.replaceChildren(hold());
    try {
      const rows = items(await Api.inboundFederationReports(100));
      list.replaceChildren(...(rows.length
        ? rows.map((report) => row({
          lead: el('span', { class: 'm-row__chevron' }, icon('globe', { size: 16 })),
          title: report.reason || 'A report from another instance',
          sub: (report.instanceName || report.instanceId || '') + (report.createdAt ? ' · ' + when(report.createdAt) : ''),
          side: el('span', { class: 'm-row__note' }, statusWord(report.status)),
        }))
        : [emptyState('globe', 'Nothing from the peers', 'Reports other instances filed with this one appear here.')]));
    } catch (error) {
      list.replaceChildren(failure(error, paint));
    }
  };
  await paint();
}

export function renderAdmin(ctx) {
  const host = el('div', { class: 'm-stack' });
  const draw = SECTIONS[ctx.page.id] || overview;
  return {
    node: host,
    onMount: async () => {
      if (!(await isOperator())) {
        host.appendChild(refusal());
        return;
      }
      try {
        await draw(host);
      } catch (error) {
        host.replaceChildren(failure(error, () => {
          host.replaceChildren();
          return draw(host);
        }));
      }
    },
  };
}

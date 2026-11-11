// Admin: the people and the moderation queue.
// Overview, the accounts, the communities, the reports, the appeals, the audit
// log and the data requests. Every action names what it does in its own label,
// and every enforcement asks once beside it so a slip needs a second slip.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { head, card, row, blank, fault, fold, facts, hold } from '../ui/page.js';
import { errorToast, toast, confirmDialog, openMenu, openDialog } from '../ui/overlays.js';
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
  const list = el('div', { class: 'rowlist' });
  const search = el('input', {
    class: 'input', type: 'search', placeholder: 'Search an account',
    'aria-label': 'Search accounts by name',
    autocomplete: 'off', spellcheck: 'false',
  });
  let selected = null;

  const refresh = () => {
    // The rows and the open case both live off the server's answer, and an
    // action from either side has to leave both honest.
    paintRows(search.value.trim());
    if (selected) setInspector(PERSON_SPEC);
  };

  const paintRows = async (searchQ) => {
    try {
      const rows = await Api.adminUsers(searchQ ? { q: searchQ, limit: '25' } : { limit: '25' });
      const items = Array.isArray(rows) ? rows : (rows && rows.items) || [];
      list.replaceChildren(...(items.length ? items.map((u) => row({
        lead: el('span', { class: 'role-dot' },
          icon(u.enforced ? 'shield-off' : 'user', { size: 15 })),
        title: u.displayName || u.username || 'An account',
        sub: u.enforced
          ? 'Enforced: ' + String(u.enforcement || 'unknown')
          : '@' + (u.username || ''),
        side: el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'Actions for the account ' + (u.username || ''),
          onClick: (event) => userActions(event, u, refresh),
        }, icon('more', { size: 15 })),
        onClick: () => {
          // The row is the record: the list endpoint is the account's only
          // directory return, so the case reads it from here and the action
          // history from the account's own endpoint.
          selected = u;
          setInspector(PERSON_SPEC);
        },
        // The same actions, raised by a right-click on the row itself.
        menu: () => userActionItems(u, refresh),
      })) : [blank({
        glyph: 'user', title: 'No account by that name',
        text: 'The search reads names and handles; try fewer letters.',
      })]));
    } catch (e) {
      list.replaceChildren(fold([fault(e, () => paintRows(search.value.trim()))]));
    }
  };

  let timer = null;
  search.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; paintRows(search.value.trim()); }, 240);
  });

  // The person: the account's own record, the actions recorded against it,
  // and the decisions the operator can take from here. Every decision is an
  // endpoint the server guards, applied once on purpose.
  const personPanel = () => {
    const body = el('div', { class: 'fold fold--tight' });

    const paintPerson = async () => {
      if (!selected) {
        body.replaceChildren(blank({
          glyph: 'user',
          title: 'Pick an account',
          text: 'Pick one from the list to see everything on it.',
        }));
        return;
      }
      body.replaceChildren(hold('Opening the case'));
      try {
        // The dossier, not just the action history: the account's own
        // endpoint returns the notes, the standing restrictions, the cases
        // and the reports, so the record here is what the server would act
        // on - not only the row the list happened to carry.
        const dossier = await Api.adminUser(selected.id);
        const actions = Array.isArray(dossier.actions) ? dossier.actions : [];
        const notes = Array.isArray(dossier.notes) ? dossier.notes : [];
        const restrictions = Array.isArray(dossier.activeRestrictions) ? dossier.activeRestrictions : [];
        const profile = dossier.repeatOffender || null;

        const addNote = async () => {
          const answer = await askCommunityEnforcement({
            title: 'Add a note',
            body: 'Notes are for staff only — the account never sees them. Say what the next person looking at this account should know.',
            confirmLabel: 'Add note',
            fieldLabel: 'The note',
            placeholder: 'What should the next admin know?',
          });
          if (!answer || !answer.reason) return;
          try {
            await Api.adminAddUserNote(selected.id, answer.reason);
            toast('Note added');
            await paintPerson();
          } catch (e) { errorToast(e); }
        };

        const liftRestriction = async (restriction) => {
          const answer = await askCommunityEnforcement({
            title: 'Lift the ' + String(restriction.kind || 'restriction').replace(/_/g, ' ') + '?',
            body: 'They get that use back right away.',
            confirmLabel: 'Lift',
            reason: 'The restriction is no longer needed.',
            fieldLabel: 'Reason',
          });
          if (!answer || !answer.reason) return;
          try {
            await Api.adminLiftRestriction(selected.id, restriction.id, answer.reason);
            toast('The restriction is lifted');
            refresh();
          } catch (e) { errorToast(e); }
        };

        const enforced = !!dossier.enforcement_state;
        // Few buttons, matched to the state: suspend and ban while active,
        // lift while an enforcement stands. The one-day variant stays in the
        // row menu for whoever wants it.
        const decisions = el('div', { class: 'actionline' },
          enforced ? el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            onClick: () => lift(selected, refresh),
          }, 'Lift enforcement') : el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            onClick: () => enforceWith(selected, refresh, { kind: 'warn', reason: 'Warned by an administrator' }),
          }, 'Warn'),
          ...(enforced ? [] : [
            el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              onClick: () => enforceWith(selected, refresh, {
                kind: 'suspend', reason: 'Suspended by an administrator',
              }),
            }, 'Suspend'),
            el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button', danger: true,
              onClick: () => enforceWith(selected, refresh, { kind: 'ban', reason: 'Banned by an administrator' }),
            }, 'Ban'),
          ]));

        body.replaceChildren(
          facts([
            { value: enforced ? 'Enforced' : 'Active', label: 'Status' },
            { value: selected.displayName || dossier.displayName || 'An account', label: 'Account' },
            { value: selected.username || dossier.username ? '@' + (selected.username || dossier.username) : '—', label: 'Handle' },
            { value: enforced ? (selected.enforcement || dossier.enforcement_state) : '—', label: 'Enforcement' },
          ]),
          profile ? card({
            label: 'The pattern', glyph: 'activity',
            body: el('div', { class: 'fold fold--tight' },
              el('p', { class: 'lede' }, [
                profile.totalActions + (profile.totalActions === 1 ? ' action' : ' actions') + ' on the record',
                profile.activeWarnings ? profile.activeWarnings + ' active warnings' : null,
                profile.bans ? profile.bans + ' bans' : null,
                profile.openReports ? profile.openReports + ' open reports' : null,
              ].filter(Boolean).join(' · ')
                + (profile.flagged ? '. The account is flagged by the pattern.' : ''))),
          }) : null,
          card({
            label: 'The record', glyph: 'user',
            body: el('p', { class: 'lede' },
              (dossier.createdAt || selected.createdAt)
                ? 'Joined ' + String(dossier.createdAt || selected.createdAt).slice(0, 10) + '.'
                : 'The account has no creation date recorded.'),
          }),
          card({
            label: 'The restrictions (' + restrictions.length + ')', glyph: 'lock',
            body: el('div', { class: 'fold fold--tight' },
              restrictions.length
                ? el('div', { class: 'rowlist' }, restrictions.map((r) => row({
                  lead: el('span', { class: 'role-dot' }, icon('lock', { size: 15 })),
                  title: String(r.kind || 'A restriction').replace(/_/g, ' '),
                  sub: [r.reason, r.expiresAt && 'expires ' + String(r.expiresAt).slice(0, 10)].filter(Boolean).join(' · ') || '—',
                  meta: r.createdAt || '',
                  menu: () => [{
                    label: 'Lift the restriction', icon: 'check', checked: true,
                    onSelect: () => liftRestriction(r),
                  }],
                })))
                : blank({
                  glyph: 'lock',
                  title: 'No standing restrictions',
                  text: 'A restriction takes one use away without removing the account; it would be listed here.',
                })),
          }),
          card({
            label: 'The notes (' + notes.length + ')', glyph: 'pencil',
            body: el('div', { class: 'fold fold--tight' },
              notes.length
                ? el('div', { class: 'rowlist' }, notes.map((n) => recordRow(n, 'pencil')))
                : blank({
                  glyph: 'pencil',
                  title: 'No notes yet',
                  text: 'A note is what one operator leaves for the next.',
                }),
              el('div', { class: 'actionline' },
                el('button', {
                  class: 'btn btn--ghost btn--sm', type: 'button',
                  onClick: addNote,
                }, 'Add a note'))),
          }),
          card({
            label: 'Actions on this account', glyph: 'clock',
            body: actions.length
              ? el('div', { class: 'rowlist' }, actions.map((a) => row({
                title: a.actionType || a.action || 'An action',
                sub: [a.actor_name && 'by ' + a.actor_name,
                  a.reason,
                  a.expiresAt && 'expires ' + String(a.expiresAt).slice(0, 10),
                ].filter(Boolean).join(' · ') || '—',
                meta: a.createdAt || '',
              })))
              : blank({
                glyph: 'clock',
                title: 'No actions recorded',
                text: 'Actions taken on this account show up here.',
              }),
          }),
          card({
            label: 'The decisions', glyph: 'shield',
            body: decisions,
          }),
        );
      } catch (e) {
        body.replaceChildren(fold([fault(e, paintPerson)]));
      }
    };

    paintPerson();
    return body;
  };

  const PERSON_SPEC = {
    kind: 'admin-people',
    tabs: [{ id: 'case', label: 'Case', icon: 'user', render: () => personPanel() }],
  };

  return {
    node: fold([
      head({
        kicker: 'Moderation',
        title: 'People',
        lede: 'Find an account and see everything on it.',
      }),
      card({ label: 'Accounts', glyph: 'users', body: fold([search, list]), flush: true }),
    ]),
    onMount: () => { setInspector(PERSON_SPEC); paintRows(''); },
    cleanup() { setInspector(null); },
  };
}

function userActionItems(user, refresh) {
  return [
    { header: user.displayName || user.username || 'An account' },
    {
      label: 'Warn', icon: 'alert-triangle',
      onSelect: () => enforceWith(user, refresh, { kind: 'warn', reason: 'Warned by an administrator' }),
    },
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

  const answer = await askCommunityEnforcement({
    title: (plan.kind === 'ban' ? 'Ban ' : plan.kind === 'warn' ? 'Warn ' : 'Suspend ') + (user.username || 'this account') + '?',
    body: plan.kind === 'ban'
      ? 'They lose access to everything here, and only an admin can undo it. Your reason is saved.'
      : plan.kind === 'warn'
        ? 'A warning is a note on the account, and nothing more. Your reason is saved.'
        : 'They lose access until someone lifts it. Your reason is saved.',
    confirmLabel: plan.kind === 'ban' ? 'Ban' : plan.kind === 'warn' ? 'Warn' : 'Suspend',
    danger: plan.kind === 'ban' || plan.kind === 'suspend',
    fieldLabel: 'Reason',
    reason: plan.reason,
    placeholder: 'The words that travel with the action',
  });
  if (!answer || !answer.reason) return;
  try {
    await Api.adminEnforceUser(user.id, Object.assign({}, body, { reason: answer.reason }));
    toast('Done');
    refresh();
  } catch (e) { errorToast(e); }
}

async function lift(user, refresh) {
  try {
    await Api.adminLiftUser(user.id, 'Lifted by an administrator');
    toast('Enforcement lifted');
    refresh();
  } catch (e) { errorToast(e); }
}

// -- communities -------------------------------------------------------------

// What an enforcement state says, in the words the console reads. The
// server's states are kept - `suspended` and `removed` are its vocabulary -
// and only the presentation is spelled out. A removal also arrives as a
// deletion stamp, so both are read.
function communityState(server) {
  if (server.deletedAt || server.enforcementState === 'removed') return 'removed';
  if (server.enforcementState) return 'suspended';
  return '';
}

// One enforcement dialog: what the action does, the reason the record will
// carry, and the button that does it. The server refuses an enforcement
// without a reason - the reason is written into the audit chain and read
// back to the community's owner - so the console asks for real words rather
// than filing a canned line under an operator's name. Backing out resolves
// null, and nothing is sent.
function askCommunityEnforcement(plan) {
  return new Promise((resolve) => {
    const field = el('textarea', {
      class: 'input', rows: '3', maxlength: '2000',
      'aria-label': plan.fieldLabel || 'Reason',
      placeholder: plan.placeholder || 'Tell them why',
    });
    if (plan.reason) field.value = plan.reason;

    const proceed = el('button', {
      class: 'btn ' + (plan.danger ? 'btn--danger' : 'btn--primary'), type: 'button',
      onClick: () => {
        const reason = String(field.value || '').trim();
        if (!reason) { field.focus(); return; }
        dialog.close({ reason });
      },
    }, plan.confirmLabel || 'Apply');

    const dialog = openDialog({
      title: plan.title,
      sub: plan.body || null,
      body: el('label', { class: 'field' },
        el('span', { class: 'field-label' }, plan.fieldLabel || 'Reason'),
        field),
      foot: [
        el('button', {
          class: 'btn btn--ghost', type: 'button',
          onClick: () => dialog.close(null),
        }, 'Cancel'),
        proceed,
      ],
      onClose: (result) => resolve(result || null),
    });
  });
}

// Apply a community enforcement. The bodies are the server's contract, not a
// shorthand of this console's: suspend reads `reason` and an optional
// `expiresInHours`, removal asks for `confirm` explicitly because a removal
// is not undone by lifting it - the community comes back only through a
// deliberate restore. Lift and restore each carry the reason the record
// requires.
async function enforceCommunity(server, refresh, plan) {
  const answer = await askCommunityEnforcement({
    title: plan.title,
    body: plan.body,
    confirmLabel: plan.confirmLabel,
    danger: plan.danger,
    reason: plan.reason,
  });
  if (!answer) return;
  try {
    if (plan.kind === 'lift') {
      await Api.adminLiftServer(server.id, answer.reason);
    } else if (plan.kind === 'restore') {
      await Api.adminRestoreServer(server.id, answer.reason);
    } else if (plan.kind === 'remove') {
      await Api.adminRemoveServer(server.id, { reason: answer.reason, confirm: true });
    } else {
      const body = { reason: answer.reason };
      if (plan.duration === '1d') body.expiresInHours = 24;
      await Api.adminSuspendServer(server.id, body);
    }
    toast(plan.done || 'The enforcement is applied');
    refresh();
  } catch (e) { errorToast(e); }
}

// The actions one community carries, in the menu beside its row and in the
// record's own decisions. A lift is offered only while a suspension stands,
// a restore only while a removal stands - the menu never offers an action
// the server would refuse.
function communityActionItems(server, refresh) {
  const state = communityState(server);
  const name = server.name || 'A community';
  const items = [
    { header: name, sub: (server.memberCount || 0) + ' members' },
    {
      label: 'Suspend for one day', icon: 'clock',
      onSelect: () => enforceCommunity(server, refresh, {
        kind: 'suspend', duration: '1d',
        title: 'Suspend ' + name + ' for one day?',
        body: 'Members lose access for 24 hours, then it opens back up on its own. The owner gets an email with your reason.',
        confirmLabel: 'Suspend',
        reason: 'Suspended by an administrator',
      }),
    },
    {
      label: 'Suspend permanently', icon: 'clock', danger: true,
      onSelect: () => enforceCommunity(server, refresh, {
        kind: 'suspend',
        title: 'Suspend ' + name + '?',
        body: 'Members lose access until someone lifts the suspension. The owner gets an email with your reason.',
        confirmLabel: 'Suspend',
        reason: 'Suspended by an administrator',
      }),
    },
    {
      label: 'Remove the community', icon: 'ban', danger: true,
      onSelect: () => enforceCommunity(server, refresh, {
        kind: 'remove',
        title: 'Remove ' + name + '?',
        body: 'The community goes offline for everyone and only comes back if an admin restores it. The owner gets an email with your reason.',
        confirmLabel: 'Remove',
        reason: 'Removed by an administrator',
      }),
    },
  ];
  if (state === 'suspended') {
    items.push({
      label: 'Lift the suspension', icon: 'check', checked: true,
      onSelect: () => enforceCommunity(server, refresh, {
        kind: 'lift',
        title: 'Lift the suspension on ' + name + '?',
        body: 'Members get back in and everything is as it was.',
        confirmLabel: 'Lift suspension',
        done: 'The suspension is lifted',
        reason: 'The suspension is no longer needed.',
      }),
    });
  }
  if (state === 'removed') {
    items.push({
      label: 'Restore the community', icon: 'check', checked: true,
      onSelect: () => enforceCommunity(server, refresh, {
        kind: 'restore',
        title: 'Restore ' + name + '?',
        body: 'Everything comes back — members, channels, the lot.',
        confirmLabel: 'Restore',
        done: 'The community is restored',
        reason: 'Restored by an administrator',
      }),
    });
  }
  return items;
}

// The community's own record: the facts, the enforcement standing against it,
// the actions written down about it, and the decisions. The record is read
// from the community's own endpoint, so a decision made a moment ago is the
// state this panel shows next.
export function adminCommunities() {
  const list = el('div', { class: 'rowlist' });
  const search = el('input', {
    class: 'input', type: 'search', placeholder: 'Search a community',
    'aria-label': 'Search communities by name',
    autocomplete: 'off', spellcheck: 'false',
  });
  const chips = el('div', { class: 'filterchips', role: 'group', 'aria-label': 'Filter communities by state' });
  const FILTERS = [['', 'All'], ['ENFORCED', 'Enforced']];
  let state = '';
  let selected = null;

  const refresh = () => {
    // The rows and the open record both live off the server's answer, and an
    // action from either side has to leave both honest.
    paintRows(search.value.trim());
    if (selected) setInspector(COMMUNITY_SPEC);
  };

  const paintChips = () => {
    chips.replaceChildren(...FILTERS.map(([value, label]) => el('button', {
      class: 'chip' + (state === value ? ' chip--on' : ''), type: 'button',
      'aria-pressed': String(state === value),
      onClick: () => { state = value; paintChips(); paintRows(search.value.trim()); },
    }, label)));
  };
  paintChips();

  const paintRows = async (searchQ) => {
    const query = Object.assign({ limit: '50' }, state ? { state } : {}, searchQ ? { q: searchQ } : {});
    list.replaceChildren(hold('Reading the communities'));
    try {
      const rows = await Api.adminServers(query);
      const items = Array.isArray(rows) ? rows : (rows && rows.items) || [];
      list.replaceChildren(...(items.length ? items.map((s) => {
        const enforced = communityState(s);
        return row({
          lead: el('span', { class: 'role-dot' },
            icon(enforced ? 'shield-off' : 'users', { size: 15 })),
          title: s.name || 'A community',
          sub: [s.ownerName && 'owner @' + s.ownerName,
            (s.memberCount || 0) + ' members',
            (s.openReportCount || 0) > 0 && (s.openReportCount === 1 ? '1 open report' : s.openReportCount + ' open reports'),
          ].filter(Boolean).join(' · ') || '—',
          side: el('span', { class: 'actionline' },
            enforced ? el('span', { class: 'chip chip--quiet' }, enforced) : null,
            el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              'aria-label': 'Actions for the community ' + (s.name || ''),
              onClick: (event) => openMenu({
                anchor: event.currentTarget,
                items: communityActionItems(s, refresh),
              }),
            }, icon('more', { size: 15 }))),
          onClick: () => {
            selected = s;
            setInspector(COMMUNITY_SPEC);
          },
          // The same actions, raised by a right-click on the row itself.
          menu: () => communityActionItems(s, refresh),
        });
      }) : [blank({
        glyph: 'users',
        title: searchQ ? 'No community by that name' : (state ? 'Nothing in this state' : 'No communities yet'),
        text: searchQ
          ? 'The search reads names; try fewer letters.'
          : state
            ? 'No community is under enforcement. The other filter has the rest.'
            : 'Communities appear here once someone creates one.',
      })]));
    } catch (e) {
      list.replaceChildren(fold([fault(e, () => paintRows(search.value.trim()))]));
    }
  };

  let timer = null;
  search.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; paintRows(search.value.trim()); }, 240);
  });

  const COMMUNITY_SPEC = {
    kind: 'admin-communities',
    tabs: [{ id: 'case', label: 'Record', icon: 'users', render: () => communityPanel() }],
  };

  // The record panel. The community is re-read from its own endpoint every
  // time, so the decisions shown are the ones the server would accept now.
  const communityPanel = () => {
    const body = el('div', { class: 'fold fold--tight' });

    const paintCommunity = async () => {
      if (!selected) {
        body.replaceChildren(blank({
          glyph: 'users',
          title: 'Pick a community',
          text: 'The record opens here when you choose one from the list.',
        }));
        return;
      }
      body.replaceChildren(hold('Opening the record'));
      try {
        const detail = await Api.adminServer(selected.id);
        const s = detail.server || selected;
        const enforcement = detail.enforcement || null;
        const state = enforcement
          ? communityState({ enforcementState: enforcement.state, deletedAt: enforcement.deletedAt })
          : '';
        const actions = Array.isArray(detail.actions) ? detail.actions : [];
        const name = s.name || 'A community';

        // One decision at a time, matched to the state: an active community
        // offers suspend and remove, a suspended one lift, a removed one
        // restore. The row menu keeps the one-day variant for whoever wants
        // it; the record keeps the buttons few.
        const decisions = el('div', { class: 'actionline' });
        if (state === 'suspended') {
          decisions.appendChild(el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            onClick: () => enforceCommunity(s, refresh, {
              kind: 'lift',
              title: 'Lift the suspension on ' + name + '?',
              body: 'Members get back in and everything is as it was.',
              confirmLabel: 'Lift suspension',
              done: 'The suspension is lifted',
              reason: 'The suspension is no longer needed.',
            }),
          }, 'Lift suspension'));
        }
        if (state === 'removed') {
          decisions.appendChild(el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            onClick: () => enforceCommunity(s, refresh, {
              kind: 'restore',
              title: 'Restore ' + name + '?',
              body: 'Everything comes back — members, channels, the lot.',
              confirmLabel: 'Restore',
              done: 'The community is restored',
              reason: 'Restored by an administrator',
            }),
          }, 'Restore'));
        }
        if (state !== 'removed') {
          decisions.appendChild(el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: () => enforceCommunity(s, refresh, {
              kind: 'suspend',
              title: 'Suspend ' + name + '?',
              body: 'Members lose access until someone lifts the suspension. The owner gets an email with your reason.',
              confirmLabel: 'Suspend',
              reason: 'Suspended by an administrator',
            }),
          }, 'Suspend'));
          decisions.appendChild(el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button', danger: true,
            onClick: () => enforceCommunity(s, refresh, {
              kind: 'remove',
              title: 'Remove ' + name + '?',
              body: 'The community goes offline for everyone and only comes back if an admin restores it. The owner gets an email with your reason.',
              confirmLabel: 'Remove',
              reason: 'Removed by an administrator',
            }),
          }, 'Remove'));
        }

        body.replaceChildren(
          facts([
            { value: state === 'suspended' ? 'Suspended' : state === 'removed' ? 'Removed' : 'Active', label: 'Status' },
            { value: String(s.memberCount || 0), label: 'Members' },
            { value: String(s.channelCount || 0), label: 'Channels' },
            { value: s.ownerDisplay || s.ownerName ? '@' + (s.ownerDisplay || s.ownerName) : '—', label: 'Owner' },
          ]),
          card({
            label: 'The record', glyph: 'users',
            body: el('p', { class: 'lede' },
              s.description
                ? String(s.description).slice(0, 300)
                : 'The community has no description recorded.'),
          }),
          enforcement ? card({
            label: 'The enforcement', glyph: 'shield',
            body: el('div', { class: 'fold fold--tight' },
              el('p', { class: 'lede' }, [
                enforcement.reason || 'No reason was recorded.',
                enforcement.expiresAt
                  ? ' The suspension ends on its own ' + String(enforcement.expiresAt).slice(0, 10) + '.'
                  : '',
              ].join(''))),
          }) : null,
          card({
            label: 'Actions on this community', glyph: 'clock',
            body: actions.length
              ? el('div', { class: 'rowlist' }, actions.map((a) => row({
                title: String(a.action_type || 'An action').replace(/_/g, ' '),
                sub: [a.actor_name && 'by ' + a.actor_name,
                  a.reason,
                  a.expires_at && 'expires ' + String(a.expires_at).slice(0, 10),
                ].filter(Boolean).join(' · ') || '—',
                meta: a.created_at || '',
              })))
              : blank({
                glyph: 'clock',
                title: 'No actions recorded',
                text: 'Actions taken on this community show up here.',
              }),
          }),
          card({
            label: 'The decisions', glyph: 'shield',
            body: decisions,
          }),
        );
      } catch (e) {
        body.replaceChildren(fold([fault(e, paintCommunity)]));
      }
    };

    paintCommunity();
    return body;
  };

  return {
    node: fold([
      head({
        kicker: 'Moderation',
        title: 'Communities',
        lede: 'Find a community and take action.',
      }),
      card({
        label: 'Communities', glyph: 'users',
        body: fold([search, chips, list]), flush: true,
      }),
    ]),
    onMount: () => { setInspector(COMMUNITY_SPEC); paintRows(''); },
    cleanup() { setInspector(null); },
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
  INVESTIGATING: 'Investigate',
  RESOLVED: 'Resolve',
  DISMISSED: 'Dismiss',
};

// The frozen evidence, read back in the words of the thing that was
// reported. A report is a claim about something that may be edited or
// deleted after the fact; the snapshot is what the reporter actually saw,
// and the case is decided against the snapshot, not against the live row.
function snapshotView(targetType, snapshot) {
  if (!snapshot) return null;
  const when = snapshot.createdAt || snapshot.created_at || null;
  if (targetType === 'message' || targetType === 'dm') {
    return {
      title: targetType === 'dm' ? 'The direct message, as it stood' : 'The message, as it stood',
      lines: [
        snapshot.authorName || snapshot.author_name
          ? 'Written by ' + (snapshot.authorDisplay || snapshot.authorName || snapshot.author_name) : null,
        snapshot.channelName ? 'In #' + snapshot.channelName : null,
        when ? 'At ' + String(when).slice(0, 16).replace('T', ' ') : null,
        snapshot.attachments && snapshot.attachments.length
          ? snapshot.attachments.length + (snapshot.attachments.length === 1 ? ' attachment' : ' attachments') : null,
      ].filter(Boolean).join(' · '),
      text: String(snapshot.content || '').slice(0, 2000) || null,
    };
  }
  if (targetType === 'user') {
    return {
      title: 'The account, as it stood',
      lines: [
        snapshot.username ? '@' + snapshot.username : null,
        snapshot.displayName || snapshot.display_name || null,
        snapshot.created_at || snapshot.createdAt ? 'Created ' + String(snapshot.created_at || snapshot.createdAt).slice(0, 10) : null,
        snapshot.enforcement_state ? 'Enforcement: ' + snapshot.enforcement_state : null,
      ].filter(Boolean).join(' · '),
      text: snapshot.bio ? String(snapshot.bio).slice(0, 800) : null,
    };
  }
  if (targetType === 'channel') {
    return {
      title: 'The channel, as it stood',
      lines: [
        snapshot.name ? '#' + snapshot.name : null,
        snapshot.server_name || snapshot.serverName || null,
      ].filter(Boolean).join(' · '),
      text: snapshot.topic ? String(snapshot.topic).slice(0, 800) : null,
    };
  }
  if (targetType === 'server') {
    return {
      title: 'The community, as it stood',
      lines: [
        snapshot.owner_name || snapshot.ownerName ? 'Owned by @' + (snapshot.owner_name || snapshot.ownerName) : null,
        when ? 'Created ' + String(when).slice(0, 10) : null,
      ].filter(Boolean).join(' · '),
      text: snapshot.description ? String(snapshot.description).slice(0, 800) : null,
    };
  }
  if (targetType === 'attachment') {
    return {
      title: 'The attachment, as it stood',
      lines: [
        snapshot.filename || null,
        snapshot.mime || null,
        snapshot.size ? Math.round(Number(snapshot.size) / 1024) + ' KB' : null,
      ].filter(Boolean).join(' · '),
      text: null,
    };
  }
  return { title: 'What was reported', lines: '', text: null };
}

// One statement the record carries: a note, a piece of evidence. The same
// shape every queue and record reads, so a note looks like a note wherever
// it stands.
function recordRow(entry, glyph) {
  return row({
    lead: el('span', { class: 'role-dot' }, icon(glyph || 'pencil', { size: 15 })),
    title: entry.authorName || entry.creatorName || entry.author_name || entry.creator_name || 'The record',
    sub: String(entry.body || entry.content || '').slice(0, 200) || '—',
    meta: entry.createdAt || entry.created_at || '',
  });
}

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
        const snapshot = snapshotView(report.target_type, report.targetSnapshot || null);
        const record = report.case || null;
        const notes = record && Array.isArray(record.notes) ? record.notes : [];
        const evidence = record && Array.isArray(record.evidence) ? record.evidence : [];
        const caseActions = record && Array.isArray(record.actions) ? record.actions : [];

        const addNote = async () => {
          const answer = await askCommunityEnforcement({
            title: 'Add a note to the case',
            body: 'Notes are for staff only. Say what the next person looking at this case should know.',
            confirmLabel: 'Add the note',
            fieldLabel: 'The note',
            placeholder: 'What a reviewer of this case should know',
          });
          if (!answer || !answer.reason) return;
          try {
            await Api.adminAddReportNote(report.id, answer.reason);
            toast('Note added');
            await paintCase();
          } catch (e) { errorToast(e); }
        };

        const addEvidence = async () => {
          const answer = await askCommunityEnforcement({
            title: 'Add evidence to the case',
            body: 'Evidence is copied into the case as it looks right now, so it stays even if the original is edited or deleted.',
            confirmLabel: 'Add the evidence',
            fieldLabel: 'The evidence',
            placeholder: 'What you saw, in your own words',
          });
          if (!answer || !answer.reason) return;
          try {
            await Api.adminAddReportEvidence(report.id, { kind: 'NOTE', content: answer.reason });
            toast('Evidence added');
            await paintCase();
          } catch (e) { errorToast(e); }
        };

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
                  body: 'This notes the decision in the audit log.',
                  confirmLabel: REPORT_MOVES[value],
                  danger: value === 'DISMISSED',
                });
                if (!yes) return;
              }
              try {
                await Api.adminUpdateReport(report.id, { status: value });
                toast(REPORT_MOVES[value] + ' — noted in the audit log.');
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
          (report.category || report.severity || report.priority) ? facts([
            { value: report.category ? String(report.category).replace(/_/g, ' ') : '—', label: 'Category' },
            { value: report.severity ? String(report.severity).replace(/_/g, ' ') : '—', label: 'Severity' },
            { value: report.priority ? String(report.priority) : '—', label: 'Priority' },
          ]) : null,
          card({
            label: 'What was reported', glyph: 'flag',
            body: el('div', { class: 'fold fold--tight' },
              el('p', { class: 'lede' }, report.reason || 'No reason was given.'),
              report.description ? el('p', { class: 'lede' }, String(report.description).slice(0, 2000)) : null),
          }),
          snapshot ? card({
            label: snapshot.title, glyph: 'file',
            body: el('div', { class: 'fold fold--tight' },
              snapshot.lines ? el('p', { class: 'lede' }, snapshot.lines) : null,
              snapshot.text ? el('p', { class: 'lede' }, snapshot.text) : null,
              !snapshot.lines && !snapshot.text
                ? el('p', { class: 'lede' }, 'The snapshot the reporter saw is kept, but reads as empty here.')
                : null),
          }) : null,
          target ? card({
            label: 'The reported account', glyph: 'user',
            body: el('p', { class: 'lede' },
              (target.display_name || target.username || 'An account')
              + (target.username ? ' @' + target.username : '')
              + (target.enforcement_state ? ' — enforcement: ' + target.enforcement_state : '')),
          }) : null,
          card({
            label: 'The evidence (' + evidence.length + ')', glyph: 'paperclip',
            body: el('div', { class: 'fold fold--tight' },
              evidence.length
                ? el('div', { class: 'rowlist' }, evidence.map((e) => row({
                  lead: el('span', { class: 'role-dot' }, icon('paperclip', { size: 15 })),
                  title: String(e.kind || 'Evidence').replace(/_/g, ' '),
                  sub: String(e.content || e.metadata || '').slice(0, 200) || '—',
                  meta: [e.creator_name && 'by ' + e.creator_name, e.created_at].filter(Boolean).join(' · '),
                })))
                : blank({
                  glyph: 'paperclip',
                  title: 'No evidence yet',
                  text: 'A snapshot of what was reported is kept with the case, so a later edit cannot change it.',
                }),
              el('div', { class: 'actionline' },
                el('button', {
                  class: 'btn btn--ghost btn--sm', type: 'button',
                  onClick: addEvidence,
                }, 'Add evidence'))),
          }),
          card({
            label: 'The notes (' + notes.length + ')', glyph: 'pencil',
            body: el('div', { class: 'fold fold--tight' },
              notes.length
                ? el('div', { class: 'rowlist' }, notes.map((n) => recordRow(n, 'pencil')))
                : blank({
                  glyph: 'pencil',
                  title: 'No notes yet',
                  text: 'Leave one for the next person who picks up this case.',
                }),
              el('div', { class: 'actionline' },
                el('button', {
                  class: 'btn btn--ghost btn--sm', type: 'button',
                  onClick: addNote,
                }, 'Add a note'))),
          }),
          (record && caseActions.length) ? card({
            label: 'Actions in the case', glyph: 'shield',
            body: el('div', { class: 'rowlist' }, caseActions.map((a) => row({
              title: String(a.action_type || 'An action').replace(/_/g, ' '),
              sub: [a.actor_name && 'by ' + a.actor_name, a.reason].filter(Boolean).join(' · ') || '—',
              meta: a.created_at || '',
            }))),
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
        const caseNotes = appeal.case && Array.isArray(appeal.case.notes) ? appeal.case.notes : [];

        const addNote = async () => {
          const answer = await askCommunityEnforcement({
            title: 'Add a note to the review',
            body: 'Notes are for staff only. Say what the next person looking at this appeal should know.',
            confirmLabel: 'Add the note',
            fieldLabel: 'The note',
            placeholder: 'What the record should carry about this review',
          });
          if (!answer || !answer.reason) return;
          try {
            await Api.adminAddAppealNote(appeal.id, answer.reason);
            toast('Note added');
            await paintCase();
          } catch (e) { errorToast(e); }
        };

        // Every decision carries words now: the person whose appeal is denied
        // is owed a reason, and an approval is recorded with the words the
        // reviewer stood on. The words arrive pre-filled - a reviewer can
        // keep or replace them - so the dialog is one decision, not a form.
        const decide = async (decision) => {
          const approving = decision === 'APPROVED';
          const answer = await askCommunityEnforcement({
            title: approving ? 'Approve the appeal?' : 'Deny the appeal?',
            body: approving
              ? 'The original enforcement is lifted on the server\'s side, and the decision is recorded with your name.'
              : 'The enforcement stands, and the decision is recorded with your name and the reason you give.',
            confirmLabel: approving ? 'Approve and lift' : 'Deny the appeal',
            danger: !approving,
            reason: approving
              ? 'The record supports the person; the enforcement is lifted.'
              : 'The record supports the enforcement.',
            fieldLabel: 'The note the decision carries',
            placeholder: 'The words the person will read with the decision',
          });
          if (!answer || !answer.reason) return;
          try {
            await Api.adminDecideAppeal(appeal.id, decision, answer.reason);
            toast(approving ? 'The appeal is approved and the enforcement lifted.' : 'The appeal is denied.');
            await paintCase();
            await paint();
          } catch (e) { errorToast(e); }
        };

        body.replaceChildren(
          facts([
            { value: statusWord(appeal.status), label: 'Status' },
            { value: appeal.decision ? statusWord(appeal.decision) : '—', label: 'Decision' },
            { value: (appeal.reviewerName || appeal.reviewer_name) ? '@' + (appeal.reviewerName || appeal.reviewer_name) : '—', label: 'Reviewer' },
          ]),
          card({
            label: 'What the person wrote', glyph: 'mail',
            body: el('p', { class: 'lede' }, appeal.reason || 'No statement was given.'),
          }),
          card({
            label: 'The enforcement being appealed', glyph: 'shield',
            body: el('p', { class: 'lede' },
              String(appeal.actionType || selected.action_type || 'An enforcement').replace(/_/g, ' ')
              + (appeal.actionReason || selected.action_reason
                ? ' — ' + (appeal.actionReason || selected.action_reason)
                : ' — no reason was recorded with it')),
          }),
          appeal.decisionNote ? card({
            label: 'The decision note', glyph: 'pencil',
            body: el('p', { class: 'lede' }, appeal.decisionNote),
          }) : null,
          card({
            label: 'The notes (' + caseNotes.length + ')', glyph: 'pencil',
            body: el('div', { class: 'fold fold--tight' },
              caseNotes.length
                ? el('div', { class: 'rowlist' }, caseNotes.map((n) => recordRow(n, 'pencil')))
                : blank({
                  glyph: 'pencil',
                  title: 'No notes yet',
                  text: 'Leave one for the next person who picks up this review.',
                }),
              el('div', { class: 'actionline' },
                el('button', {
                  class: 'btn btn--ghost btn--sm', type: 'button',
                  onClick: addNote,
                }, 'Add a note'))),
          }),
          decided ? card({
            label: 'The decision', glyph: 'check',
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

// One audit entry in a reader's words: who acted, on what, and when. The
// search narrows what has already been read - the endpoint answers with the
// latest entries, and a filter over them is never claimed to be the whole
// log.
export function adminAudit() {
  const list = el('div', { class: 'rowlist' });
  const search = el('input', {
    class: 'input', type: 'search', placeholder: 'Search the log',
    'aria-label': 'Search audit entries',
    autocomplete: 'off', spellcheck: 'false',
  });
  let rows = [];

  const matches = (entry, needle) => {
    const hay = [
      entry.action, entry.actor_name, entry.target_name,
      entry.target_type, entry.reason,
    ].map((v) => String(v || '').toLowerCase()).join(' ');
    return hay.indexOf(needle) !== -1;
  };

  const paint = () => {
    const needle = search.value.trim().toLowerCase();
    const visible = needle ? rows.filter((entry) => matches(entry, needle)) : rows;
    list.replaceChildren(...(visible.length ? visible.map((a) => row({
      lead: el('span', { class: 'role-dot' }, icon('book', { size: 15 })),
      title: a.action || 'An action',
      sub: (a.actor_name ? 'by ' + a.actor_name : 'an account')
        + (a.target_type
          ? ' on ' + String(a.target_type).replace(/_/g, ' ')
            + (a.target_name || a.target_id ? ' ' + (a.target_name || a.target_id) : '')
          : ''),
      meta: a.created_at || a.createdAt || '',
      // An entry that belongs to a case carries the way back to it: the
      // button opens the case's own record, so the log is a door and not
      // only a list.
      side: (a.caseId || a.case_id) ? el('button', {
        class: 'chip chip--quiet', type: 'button',
        'aria-label': 'Open the case this entry belongs to',
        onClick: (event) => {
          event.stopPropagation();
          openCase(a.caseId || a.case_id);
        },
      }, 'Case') : null,
    })) : [blank({
      glyph: 'book', title: needle ? 'Nothing in the log matches' : 'Nothing logged yet',
      text: needle
        ? 'The search reads actions, actors, targets and reasons over the newest entries.'
        : 'Administrative actions appear here as they happen.',
    })]));
  };

  // The chain's own verdict, asked for on purpose. A valid chain is said out
  // loud with the count that was checked; a break is named by entry and
  // reason, because a verdict without its evidence is not actionable.
  const verifyLine = el('p', { class: 'lede', role: 'status' });
  const verifyChain = async () => {
    verifyLine.replaceChildren('Reading the chain…');
    try {
      const verdict = await Api.adminVerifyAudit();
      if (verdict && verdict.valid) {
        verifyLine.replaceChildren('The chain verifies: '
          + (verdict.checked || 0) + ' hashed entries'
          + (verdict.legacy ? ' and ' + verdict.legacy + ' older unhashed entries' : '')
          + ' checked, no break found.');
        toast('The audit chain verifies');
      } else {
        verifyLine.replaceChildren('The chain is broken at entry '
          + (verdict && (verdict.brokenAt || '')) + ': '
          + ((verdict && verdict.reason) || 'the hashes do not agree.') + ' '
          + (verdict && verdict.checked ? verdict.checked + ' entries before the break checked.' : ''));
        errorToast({ message: 'The audit chain is broken — the log names the entry.' });
      }
    } catch (e) {
      verifyLine.replaceChildren('');
      errorToast(e);
    }
  };

  // The case behind an entry: read here, in a dialog, so following a lead
  // never throws away the log.
  const openCase = async (caseId) => {
    let dialog = null;
    const body = el('div', { class: 'fold fold--tight' }, hold('Opening the case'));
    try {
      const record = await Api.adminCase(caseId);
      const caseActions = Array.isArray(record.actions) ? record.actions : [];
      const caseNotes = Array.isArray(record.notes) ? record.notes : [];
      body.replaceChildren(
        facts([
          { value: record.status ? String(record.status).replace(/_/g, ' ') : '—', label: 'Status' },
          { value: record.scope ? String(record.scope) : '—', label: 'Scope' },
          { value: String(record.created_at || record.createdAt || '').slice(0, 10) || '—', label: 'Opened' },
        ]),
        card({
          label: 'Actions in the case (' + caseActions.length + ')', glyph: 'shield',
          body: caseActions.length
            ? el('div', { class: 'rowlist' }, caseActions.map((a) => row({
              title: String(a.action_type || 'An action').replace(/_/g, ' '),
              sub: [a.actor_name && 'by ' + a.actor_name, a.reason].filter(Boolean).join(' · ') || '—',
              meta: a.created_at || '',
            })))
            : blank({ glyph: 'shield', title: 'No actions in the case', text: 'The case stands without an enforcement of its own.' }),
        }),
        card({
          label: 'Notes (' + caseNotes.length + ')', glyph: 'pencil',
          body: caseNotes.length
            ? el('div', { class: 'rowlist' }, caseNotes.map((n) => recordRow(n, 'pencil')))
            : blank({ glyph: 'pencil', title: 'No notes', text: 'The case carries no notes yet.' }),
        }),
      );
    } catch (e) {
      body.replaceChildren(fold([fault(e, () => openCase(caseId))]));
    }
    dialog = openDialog({
      title: 'The case ' + String(caseId || '').slice(0, 12),
      sub: 'The record the audit entry points at.',
      body,
      foot: [el('button', {
        class: 'btn btn--ghost', type: 'button',
        onClick: () => dialog.close(),
      }, 'Close')],
    });
  };

  const load = async () => {
    list.replaceChildren(hold('Reading the log'));
    try {
      const fetched = await Api.adminAudit({ limit: '200' });
      rows = Array.isArray(fetched) ? fetched : (fetched && fetched.items) || [];
      paint();
    } catch (e) {
      list.replaceChildren(fold([fault(e, load)]));
    }
  };

  let timer = null;
  search.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; paint(); }, 200);
  });

  return {
    node: fold([
      head({
        kicker: 'Moderation',
        title: 'Audit log',
        lede: 'Administrative actions, most recent first.',
      }),
      card({
        label: 'The chain', glyph: 'shield',
        body: el('div', { class: 'fold fold--tight' },
          verifyLine,
          el('div', { class: 'actionline' },
            el('button', {
              class: 'btn btn--default btn--sm', type: 'button',
              onClick: verifyChain,
            }, 'Verify the chain'))),
      }),
      card({ label: 'Actions', glyph: 'book', body: fold([search, list]), flush: true }),
    ]),
    onMount: load,
    cleanup() { if (timer) clearTimeout(timer); },
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

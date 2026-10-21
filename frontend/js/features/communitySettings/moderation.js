// The moderation of a community.
//
// Three things, and each of them says what it is going to do before it does
// it: the bans, the timeouts, and removing somebody.
//
// Every action here is one the server enforces, and every answer it gives is
// reported. A moderation action that failed quietly is the worst kind: the
// operator believes a person was removed and they are still there.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import { head, card, row, blank, fault, fold, hold } from '../../ui/page.js';
import { confirmDialog, openDialog } from '../../ui/overlays.js';
import { can, isOwner } from '../../../packages/store.js';
import { communityApi } from '../../../packages/communitySettings.js';
import { reporter } from './parts.js';

// How long a timeout may last, and what each one is called.
const TIMEOUTS = [
  { minutes: 10, label: '10 minutes' },
  { minutes: 60, label: 'an hour' },
  { minutes: 60 * 24, label: 'a day' },
  { minutes: 60 * 24 * 7, label: 'a week' },
];

// The name of a member, however the server spells it.
function memberName(member) {
  return member.nickname || member.display_name || member.displayName || member.username || 'Someone';
}

// When a timeout lapses, in words.
function untilText(value) {
  if (!value) return '';
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(1, Math.round((at - Date.now()) / 60000));
  if (minutes < 60) return 'for ' + minutes + ' more minute' + (minutes === 1 ? '' : 's');
  const hours = Math.round(minutes / 60);
  if (hours < 48) return 'for ' + hours + ' more hour' + (hours === 1 ? '' : 's');
  const days = Math.round(hours / 24);
  return 'for ' + days + ' more day' + (days === 1 ? '' : 's');
}

export function moderationSection(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'fold' });

  // The three lists, and the roster they are drawn from.
  let bans = [];
  let members = [];

  // The notes the community's moderators keep about the people in it.
  let notes = [];

  // The selection for the bulk actions.
  //
  // Several members at once is a real job - a raid, a wave of spam, a room
  // that needs clearing - and doing it one person at a time is slow enough
  // that people give up half way. The selection is a plain set of ids, and it
  // is only ever shown to somebody who may act on the members in it.
  let selecting = false;
  const selected = new Set();

  const report = reporter();

  const load = async () => {
    host.replaceChildren(hold('Reading the moderation lists'));
    const canBan = canModerate();
    const canKick = canRemove();
    try {
      const [banRows, page, noteRows] = await Promise.all([
        canBan ? Api.bans(serverId) : Promise.resolve([]),
        Api.serverMembers(serverId, { limit: 200 }),
        mayWriteNotes() ? Api.memberNotes(serverId) : Promise.resolve([]),
      ]);
      bans = Array.isArray(banRows) ? banRows : (banRows && banRows.items) || [];
      members = (page && page.items) || [];
      notes = (noteRows && noteRows.notes) || [];
      paint();
    } catch (error) {
      host.replaceChildren(fold([fault(error, load)]));
    }
  };

  // The permissions the server enforces. The controls are not offered to
  // somebody who cannot use them: an action that is always refused is worse
  // than no action.
  function canModerate() {
    return can(serverId, 'BAN_MEMBERS') || isOwner(serverId);
  }
  function canRemove() {
    return can(serverId, 'KICK_MEMBERS') || isOwner(serverId);
  }
  // The notes are the moderation family's own: somebody who may remove a
  // member or run the community may keep notes about the people in it.
  function mayWriteNotes() {
    return can(serverId, 'BAN_MEMBERS') || can(serverId, 'KICK_MEMBERS')
      || can(serverId, 'MANAGE_SERVER') || isOwner(serverId);
  }

  // The note about a member, if there is one.
  const noteFor = (memberId) => notes.find((note) => String(note.userId) === String(memberId)) || null;

  const paint = () => {
    const banBody = el('div', { class: 'rowlist' });
    const timeoutBody = el('div', { class: 'rowlist' });
    const removalBody = el('div', { class: 'rowlist' });

    // -- the bans ------------------------------------------------------------
    if (!canModerate()) {
      banBody.replaceChildren(blank({
        glyph: 'ban',
        title: 'You cannot lift bans here',
        text: 'Lifting a ban takes a permission this account does not hold.',
      }));
    } else if (!bans.length) {
      banBody.replaceChildren(blank({
        glyph: 'ban',
        title: 'Nobody is banned',
        text: 'Lifting starts at banning; nobody to lift yet.',
      }));
    } else {
      banBody.replaceChildren(...bans.map((ban) => row({
        lead: el('span', { class: 'role-dot' }, icon('ban', { size: 15 })),
        title: ban.displayName || ban.username || 'Someone',
        sub: (ban.reason || 'No reason given')
          + (ban.expiresAt ? ' · until ' + ban.expiresAt : ' · for good')
          + (ban.actorName ? ' · by ' + ban.actorName : ''),
        side: el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'Lift the ban on ' + (ban.displayName || ban.username || 'this person'),
          onClick: async () => {
            const yes = await confirmDialog({
              title: 'Lift the ban?',
              body: (ban.displayName || ban.username || 'This person')
                + ' can come back to the community. The record of the ban stays.',
              confirmLabel: 'Lift the ban',
            });
            if (!yes) return;
            try {
              await Api.unbanMember(serverId, ban.userId || ban.user_id || ban.id);
              report.answered('The server answered: the ban was lifted.');
              await load();
            } catch (error) {
              report.fail(error);
            }
          },
        }, 'Lift'),
      })));
    }

    // -- the timeouts --------------------------------------------------------
    const timedOut = members.filter((member) => member.timeout_expires_at
      && Date.parse(member.timeout_expires_at) > Date.now());
    if (!timedOut.length) {
      timeoutBody.replaceChildren(blank({
        glyph: 'clock',
        title: 'Nobody is timed out',
        text: 'A member who is timed out stays in the community and cannot post until it lapses.',
      }));
    } else {
      timeoutBody.replaceChildren(...timedOut.map((member) => row({
        lead: el('span', { class: 'role-dot' }, icon('clock', { size: 15 })),
        title: memberName(member),
        sub: 'Cannot post ' + untilText(member.timeout_expires_at),
        side: el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'Lift the timeout on ' + memberName(member),
          onClick: async () => {
            const yes = await confirmDialog({
              title: 'Lift the timeout?',
              body: memberName(member) + ' can post again straight away.',
              confirmLabel: 'Lift the timeout',
            });
            if (!yes) return;
            try {
              await Api.timeoutMember(serverId, member.id, 0);
              report.answered('The server answered: the timeout was lifted.');
              await load();
            } catch (error) {
              report.fail(error);
            }
          },
        }, 'Lift'),
      })));
    }

    // -- the removal ---------------------------------------------------------
    if (!canRemove()) {
      removalBody.replaceChildren(blank({
        glyph: 'logout',
        title: 'You cannot remove members here',
        text: 'Removing somebody from the community takes a permission this account does not hold.',
      }));
    } else {
      removalBody.replaceChildren(...members.map((member) => {
        // A member with a note says so, so a moderator knows there is
        // something to read before they act.
        const note = noteFor(member.id);
        const about = member.is_owner || member.isOwner
          ? 'Community owner'
          : '@' + (member.username || '');
        return row({
        lead: el('span', { class: 'role-dot' }, icon('user', { size: 15 })),
        title: memberName(member),
        sub: note ? about + ' · has a note' : about,
        side: el('span', { class: 'rowtools' },
          selecting ? el('input', {
            type: 'checkbox',
            'aria-label': 'Select ' + memberName(member),
            checked: selected.has(String(member.id)) ? 'checked' : null,
            onChange: (event) => {
              const on = event.target.checked;
              if (on) selected.add(String(member.id));
              else selected.delete(String(member.id));
              paint();
            },
          }) : null,
          mayWriteNotes() ? el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            'aria-label': (note ? 'Read the note about ' : 'Write a note about ') + memberName(member),
            onClick: () => editNote(member, note),
          }, icon('edit', { size: 14 })) : null,
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            'aria-label': 'Rename ' + memberName(member) + ' in this community',
            onClick: () => renameMember(member),
          }, icon('edit', { size: 14 })),
          el('button', {
            class: 'btn btn--danger btn--sm', type: 'button',
            'aria-label': 'Remove ' + memberName(member) + ' from the community',
            onClick: async () => {
              const yes = await confirmDialog({
                title: 'Remove ' + memberName(member) + '?',
                body: 'They leave the community. They can come back if there is a place for them.',
                confirmLabel: 'Remove',
                danger: true,
              });
              if (!yes) return;
              try {
                await Api.kickMember(serverId, member.id);
                report.answered('The server answered: ' + memberName(member) + ' was removed.');
                await load();
              } catch (error) {
                report.fail(error);
              }
            },
          }, 'Remove')),
        });
      }));
    }

    // -- several at a time ----------------------------------------------------
    //
    // The bar that appears when members are picked. It says how many are
    // picked, and it does the thing to all of them at once - and it says what
    // happened, including the ones it could not do.
    const selectionBar = () => {
      if (!selecting || !selected.size) return null;
      const names = members
        .filter((member) => selected.has(String(member.id)))
        .map((member) => memberName(member));
      const count = names.length;
      return el('div', { class: 'fold fold--tight' },
        el('p', { class: 'form-note' },
          count + (count === 1 ? ' member is picked' : ' members are picked')
          + ': ' + names.join(', ') + '.'),
        el('div', { class: 'rowtools' },
          canModerate() ? el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            onClick: () => bulkTimeout(names),
          }, icon('clock', { size: 14 }), 'Time them out') : null,
          el('button', {
            class: 'btn btn--danger btn--sm', type: 'button',
            onClick: () => bulkRemove(names),
          }, 'Remove them'),
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: () => { selected.clear(); paint(); },
          }, 'Pick none')));
    };

    host.replaceChildren(fold([
      report.node,
      card({ label: 'Bans', glyph: 'ban', body: banBody, flush: true }),
      card({
        label: 'Timeouts', glyph: 'clock',
        body: fold([
          timeoutBody,
          canModerate() ? timeoutForm() : null,
        ]),
      }),
      card({
        label: 'Removal', glyph: 'logout',
        actions: canRemove() ? el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-pressed': selecting ? 'true' : 'false',
          onClick: () => {
            selecting = !selecting;
            if (!selecting) selected.clear();
            paint();
          },
        }, selecting ? 'Done' : 'Pick several') : null,
        body: fold([removalBody, selectionBar()]),
        flush: true,
      }),
    ]));
  };

  // Several members at a time.
  //
  // The server is asked once per member, because the server is the only
  // thing that knows whether it will. So the answer is counted and reported
  // honestly: if four of five could not be timed out, the report says so
  // rather than claiming that five were.
  const bulk = async (names, act, described) => {
    const done = [];
    const refused = [];
    for (const name of names) {
      const member = members.find((m) => memberName(m) === name);
      if (!member) { refused.push(name + ' (no longer here)'); continue; }
      try {
        await act(member);
        done.push(name);
      } catch (error) {
        refused.push(name + ' (' + ((error && error.message) || 'refused') + ')');
      }
    }
    selected.clear();
    selecting = false;
    if (refused.length) {
      report.fail({
        message: described + ': ' + done.length + ' of ' + names.length
          + ' went through. Not: ' + refused.join(', ') + '.',
      });
    } else {
      report.answered('The server answered: ' + described + ' for '
        + done.length + (done.length === 1 ? ' member.' : ' members.'));
    }
    await load();
  };

  const bulkTimeout = (names) => bulk(names, (member) => Api.timeoutMember(serverId, member.id, 60),
    'They are timed out for an hour');

  const bulkRemove = async (names) => {
    const yes = await confirmDialog({
      title: names.length === 1 ? 'Remove ' + names[0] + '?' : 'Remove ' + names.length + ' members?',
      body: names.join(', ') + ' leave the community. They can come back if there is a place for them.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!yes) return;
    await bulk(names, (member) => Api.kickMember(serverId, member.id), 'They were removed');
  };

  // The form that times somebody out.
  const timeoutForm = () => {
    const who = el('select', { class: 'input', 'aria-label': 'Who to time out' },
      el('option', { value: '' }, 'Choose a member'));
    for (const member of members) {
      if (member.is_owner || member.isOwner) continue;
      who.appendChild(el('option', { value: member.id }, memberName(member)));
    }
    const how = el('select', { class: 'input', 'aria-label': 'How long the timeout lasts' },
      ...TIMEOUTS.map((span) => el('option', { value: String(span.minutes) }, span.label)));
    const run = el('button', { class: 'btn btn--default btn--sm', type: 'button' }, 'Time out');
    run.addEventListener('click', async () => {
      if (!who.value) { who.focus(); return; }
      const minutes = Number(how.value);
      const member = members.find((m) => String(m.id) === String(who.value));
      const yes = await confirmDialog({
        title: 'Time ' + memberName(member || {}) + ' out?',
        body: 'They stay in the community and cannot post for ' + (TIMEOUTS.find((t) => t.minutes === minutes) || { label: minutes + ' minutes' }).label
          + '. The server refuses their messages until it lapses.',
        confirmLabel: 'Time out',
        danger: true,
      });
      if (!yes) return;
      try {
        await Api.timeoutMember(serverId, who.value, minutes);
        report.answered('The server answered: the timeout was set.');
        await load();
      } catch (error) {
        report.fail(error);
      }
    });
    return el('div', { class: 'fold fold--tight' },
      who,
      how,
      el('div', { class: 'rowtools' }, run));
  };

  // The note about a member.
  //
  // A note is a moderator's private record of what they think of somebody:
  // what was said, what was tried, what to watch for. So it is written here
  // and nowhere else, and the member it is about never sees it - the server
  // refuses to hand it to anybody who cannot moderate here.
  const editNote = async (member, note) => {
    const body = el('textarea', {
      class: 'textarea',
      'aria-label': 'The note about ' + memberName(member),
      placeholder: 'What should the next moderator know?',
      maxlength: '2000',
    });
    body.value = note ? note.body : '';

    const dialog = openDialog({
      title: 'A note about ' + memberName(member),
      body: el('form', {
        class: 'fold',
        onSubmit: async (event) => {
          event.preventDefault();
          try {
            await Api.setMemberNote(serverId, member.id, body.value.trim());
            report.answered('The server answered: the note about ' + memberName(member) + ' was saved.');
            dialog.close();
            await load();
          } catch (error) {
            report.fail(error);
          }
        },
      },
        el('p', { class: 'form-note' },
          'Only the moderators of this community can read this. '
          + 'The member it is about never sees it.'),
        body,
        el('div', { class: 'rowtools' },
          note ? el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            'aria-label': 'Take the note about ' + memberName(member) + ' away',
            onClick: async () => {
              try {
                await Api.deleteMemberNote(serverId, member.id);
                report.answered('The server answered: the note about ' + memberName(member) + ' was taken away.');
                dialog.close();
                await load();
              } catch (error) {
                report.fail(error);
              }
            },
          }, 'Take it away') : null,
          el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Save the note'))),
    });
    body.focus();
  };

  // A member's name in this community.
  const renameMember = async (member) => {
    const name = el('input', {
      class: 'input', type: 'text', value: member.nickname || '',
      'aria-label': 'The name ' + memberName(member) + ' goes by in this community',
      placeholder: 'The name they go by here',
    });
    const dialog = openDialog({
      title: 'Rename ' + memberName(member),
      body: el('form', {
        class: 'fold',
        onSubmit: async (event) => {
          event.preventDefault();
          try {
            await communityApi.setNickname(serverId, member.id, name.value.trim());
            report.answered('The server answered: the name was changed.');
            dialog.close();
            await load();
          } catch (error) {
            report.fail(error);
          }
        },
      },
      name,
      el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Save name')),
    });
    name.focus();
  };

  return {
    node: fold([
      head({
        kicker: 'Community',
        title: 'Moderation',
        lede: 'Who is kept out, and for how long.',
        actions: null,
      }),
      host,
    ]),
    onMount: load,
  };
}

export default { moderationSection };

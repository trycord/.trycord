// The reader's cross-instance reports, and the owner's side of the same data.
//
// A report about something on another instance carries a reference and a
// reason, and nothing else. What crosses and what does not is written down by
// the server, and this screen shows that text rather than a paraphrase of it.
//
// Four lists, all of them about the same thing - what travels between
// instances:
//
//   - the reports this account has filed;
//   - the communities on other instances this account follows, and what was
//     relayed into them;
//   - what this account wrote in those communities, and what their owners
//     decided about it;
//   - and, for the owner of a community of this instance, what its members
//     wrote on other instances, with the four decisions the owner has.
//
// The moderation surface belongs to the owner of a community of this
// instance. It is offered only where the server says this account may
// moderate, so a reader who may moderate nothing is offered nothing - and
// the server refuses the action anyway, because the screen's gate is the
// server's answer rather than the client's own rule.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { head, card, row, blank, fault, fold, hold, memo } from '../ui/page.js';
import { openDialog, toast } from '../ui/overlays.js';
import { relativeTime } from '../../packages/format.js';
import { disclosurePanel, reportDialog } from '../ui/federation.js';

// ---- the Continuum calls this surface makes ---------------------------------
//
// They are the shared client's methods, so the authorisation, the error shape
// and the failover rules are the ones every other screen obeys. The names
// here are the short ones this surface reads best with.

export const continuum = {
  outgoing: () => Api.continuumOutgoing(),
  editOutgoing: (id, content) => Api.continuumEditOutgoing(id, content),
  deleteOutgoing: (id) => Api.continuumDeleteOutgoing(id),
  moderationMessages: (communityId) => Api.continuumModerationMessages(communityId),
  removeModerationMessage: (instanceId, messageId, reason) =>
    Api.continuumRemoveModerationMessage(instanceId, messageId, reason),
  moderationMembers: (communityId) => Api.continuumModerationMembers(communityId),
  restrictMember: (instanceId, userId, body) =>
    Api.continuumRestrictMember(instanceId, userId, body),
};

// ---- shared vocabulary -------------------------------------------------------

// What a member of one of this instance's communities stands in, as the relay
// store keeps it.
const MEMBER_STATE = {
  joined: { label: 'a member', tone: '' },
  muted: { label: 'muted', tone: ' badge--warning' },
  removed: { label: 'removed', tone: ' badge--danger' },
};

// The three decisions the owner has about a member who lives elsewhere.
const MEMBER_ACTIONS = [
  {
    action: 'mute',
    label: 'Mute',
    done: 'Muted',
    what: 'They cannot write in this community from here on. Their instance is told, '
      + 'so they find out before their next message rather than one message at a time.',
    state: 'is muted here',
  },
  {
    action: 'remove',
    label: 'Remove',
    done: 'Removed',
    what: 'They are removed from this community, here and on their own instance.',
    state: 'is removed here',
  },
  {
    action: 'restore',
    label: 'Restore',
    done: 'Restored',
    what: 'They are put back into this community and may write in it again.',
    state: 'is back in the community',
  },
];

// The owner's decision about a message this account wrote elsewhere. The
// writer is never left wondering where a message went: every state says what
// the owner decided, and a refusal carries the reason the owner gave.
function decisionOf(message) {
  const state = String((message && message.state) || 'pending');
  if (state === 'accepted') {
    return { label: 'accepted', tone: ' badge--success', sub: 'The owner of that community accepted it.' };
  }
  if (state === 'refused') {
    const reason = message.reason ? ' ' + message.reason : '';
    return { label: 'refused', tone: ' badge--danger', sub: 'The owner of that community refused it:' + reason };
  }
  if (state === 'deleted') {
    return { label: 'taken back', tone: '', sub: 'The owner of that community took it back.' };
  }
  return { label: 'waiting', tone: '', sub: 'The owner of that community has not answered yet.' };
}

function authorName(message) {
  return (message && (message.author_display_name || message.author_username)) || 'Someone';
}

// Federation switched off is not a failure: the instance says so, and the
// screen says it back rather than showing a broken page.
function federationOff(error) {
  return !!(error && error.status === 404);
}

// ---- the dialog every action shares ------------------------------------------
//
// A destructive action says what it will do before it does it, takes the
// reason that goes into the audit trail, and reports what the server
// answered - including the answer that the other instance was not told.

function askAction(options) {
  const opts = options || {};
  const reason = el('input', {
    class: 'input', type: 'text',
    'aria-label': 'Why (it goes into the audit trail)',
  });
  const note = el('p', { class: 'form-error', role: 'alert' });
  const submit = el('button', {
    class: 'btn ' + (opts.danger ? 'btn--danger' : 'btn--primary') + ' btn--sm',
    type: 'submit',
  }, opts.confirmLabel || 'Do it');

  const dialog = openDialog({
    title: opts.title,
    sub: opts.what,
    body: el('form', {
      class: 'form-stack',
      onSubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        try {
          const answer = await opts.onConfirm(reason.value.trim());
          dialog.close();
          if (opts.onAnswer) opts.onAnswer(answer);
        } catch (error) {
          note.textContent = (error && error.message) || 'The server refused that.';
          submit.disabled = false;
        }
      },
    },
      el('label', { class: 'field' },
        el('span', { class: 'field-label' }, 'Why (it goes into the audit trail)'),
        reason),
      note,
      submit),
  });
  reason.focus();
  return dialog;
}

// ---- the owner's moderation surface ------------------------------------------
//
// Shared with the admin console's federation section, which is the same
// surface for the person who runs the instance: what the members of this
// instance's communities wrote on other instances, and the four decisions
// about it.

export function moderationSurface(options) {
  const opts = options || {};
  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  const members = Array.isArray(opts.members) ? opts.members : [];
  const names = opts.names && typeof opts.names === 'object' ? opts.names : {};
  const refresh = typeof opts.refresh === 'function' ? opts.refresh : async () => {};
  const say = typeof opts.say === 'function' ? opts.say : () => {};

  function takeBack(message) {
    askAction({
      title: 'Take this message back?',
      what: 'The message leaves this community, and ' + message.origin_instance_id
        + ' is told, so the copy over there goes too.',
      confirmLabel: 'Take it back',
      danger: true,
      onConfirm: (reason) => continuum.removeModerationMessage(
        message.origin_instance_id, message.origin_message_id, reason),
      onAnswer: (result) => {
        if (result && result.relayed) {
          say('Taken back', 'The message is gone from here, and ' + message.origin_instance_id
            + ' was told, so the copy there goes too.', 'success');
        } else {
          say('Taken back here', 'The message is gone from here, but ' + message.origin_instance_id
            + ' was not told' + ((result && result.reason) ? ': ' + result.reason : '.'), 'warning');
        }
        refresh();
      },
    });
  }

  function decide(member, action) {
    askAction({
      title: action.label + ' ' + (member.display_name || member.username || 'this member') + '?',
      what: action.what,
      confirmLabel: action.label,
      danger: action.action === 'remove',
      onConfirm: (reason) => continuum.restrictMember(
        member.origin_instance_id,
        member.origin_user_id,
        {
          community_id: member.origin_community_id,
          action: action.action,
          reason: reason || undefined,
        }),
      onAnswer: (result) => {
        const name = member.display_name || member.username || 'This member';
        if (result && result.relayed) {
          say(action.done, name + ' ' + action.state
            + ', and ' + member.origin_instance_id + ' was told.', 'success');
        } else {
          say(action.done, name + ' ' + action.state
            + ', but ' + member.origin_instance_id + ' was not told'
            + ((result && result.reason) ? ': ' + result.reason : '.'), 'warning');
        }
        refresh();
      },
    });
  }

  function messageRow(message) {
    const community = names[message.origin_community_id];
    return row({
      class: 'federation-row',
      lead: el('span', { class: 'federation-glyph' }, icon('message', { size: 15 })),
      title: String(message.content || '').replace(/\s+/g, ' ').trim()
        || '(a message that was taken back)',
      sub: authorName(message) + ' · written on ' + message.origin_instance_id
        + (community ? ' · in ' + community : ''),
      meta: message.created_at ? relativeTime(message.created_at) : '',
      side: message.deleted
        ? el('span', { class: 'badge' }, 'taken back')
        : el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          'aria-label': 'Take back the message ' + authorName(message) + ' wrote on '
            + message.origin_instance_id,
          onClick: () => takeBack(message),
        }, 'Take back'),
    });
  }

  function memberRow(member) {
    const community = names[member.origin_community_id];
    const state = MEMBER_STATE[String(member.state || 'joined')] || MEMBER_STATE.joined;
    const name = member.display_name || member.username || 'Someone';
    return row({
      class: 'federation-row',
      lead: el('span', { class: 'federation-glyph' }, icon('user', { size: 15 })),
      title: name,
      sub: 'lives on ' + member.origin_instance_id
        + (community ? ' · in ' + community : ''),
      meta: member.updated_at ? relativeTime(member.updated_at) : '',
      side: [
        el('span', { class: 'badge' + state.tone }, state.label),
        ...MEMBER_ACTIONS.map((action) => el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          'aria-label': action.label + ' ' + name + ', who lives on ' + member.origin_instance_id,
          onClick: () => decide(member, action),
        }, action.label)),
      ],
    });
  }

  const messageList = el('div', { class: 'rowlist' },
    ...(messages.length ? messages.map(messageRow) : [blank({
      glyph: 'message',
      title: 'Nothing has been written elsewhere',
      text: 'When a member of one of your communities writes on another instance, it is listed here.',
    })]));

  const memberList = el('div', { class: 'rowlist' },
    ...(members.length ? members.map(memberRow) : [blank({
      glyph: 'users',
      title: 'No members live on another instance',
      text: 'When a member of one of your communities lives on another instance, they are listed here.',
    })]));

  return el('div', { class: 'fold' },
    card({
      label: 'What members wrote elsewhere', glyph: 'message',
      note: 'the copy over there goes too when you take it back',
      flush: true, body: messageList,
    }),
    card({
      label: 'Members who live on another instance', glyph: 'users',
      flush: true, body: memberList,
    }),
  );
}

// ---- the page ----------------------------------------------------------------

export function renderFederation(ctx) {
  const filed = el('div', { class: 'rowlist' });
  const followed = el('div', { class: 'rowlist' });
  const disclosure = el('div', { class: 'disclosure-holder' });
  const outgoing = el('div', { class: 'rowlist' });
  const moderation = el('div', { class: 'fold' });
  // What the server answered the last time. It lives here rather than in the
  // surface, so that re-reading the surface after an action does not take the
  // answer with it.
  const answer = el('div', { class: 'memo-list' });

  function say(title, text, tone) {
    answer.replaceChildren(memo({ tone: tone || 'info', role: 'status', title, text }));
  }

  // The disclosure the server told us about, kept so the next report can show
  // it before it is sent rather than only after.
  let known = null;

  // The remote communities this account follows, by the ids they have on the
  // instance they live on. The writer's view names the community a message
  // was written in.
  const remoteNames = new Map();

  function showDisclosure(report) {
    const found = report && report.disclosure;
    if (!found) return;
    known = found;
    disclosure.replaceChildren(disclosurePanel(found));
  }

  async function paintFiled() {
    try {
      const rows = await Api.myFederationReports();
      const reports = Array.isArray(rows) ? rows : [];
      if (reports.length) showDisclosure(reports[0]);
      filed.replaceChildren(...(reports.length ? reports.map((entry) => row({
        class: 'federation-row',
        lead: el('span', { class: 'federation-glyph' }, icon('flag', { size: 15 })),
        title: entry.reason,
        sub: 'about a ' + (entry.contentType || 'message') + ' in a community on another instance',
        meta: entry.createdAt ? relativeTime(entry.createdAt) : '',
        side: el('span', { class: 'badge' }, entry.status || 'FILED'),
      })) : [blank({
        glyph: 'flag',
        title: 'No reports filed',
        text: 'A report asks another instance to look at something. What it carries is a reference, never a copy.',
      })]));
    } catch (error) {
      filed.replaceChildren(fault(error, paintFiled));
    }
  }

  async function paintFollowed() {
    try {
      const rows = await Api.continuumMemberships();
      const memberships = Array.isArray(rows) ? rows : [];
      remoteNames.clear();
      for (const entry of memberships) {
        const name = entry.community && entry.community.name;
        if (!name) continue;
        remoteNames.set(entry.origin_instance_id + '|' + entry.origin_community_id, name);
      }
      if (!memberships.length) {
        followed.replaceChildren(blank({
          glyph: 'share',
          title: 'No communities on other instances',
          text: 'When you follow a community that lives on another instance, it is listed here.',
        }));
        return;
      }
      followed.replaceChildren(...memberships.map((entry) => row({
        class: 'federation-row',
        lead: el('span', { class: 'federation-glyph' }, icon('globe', { size: 15 })),
        title: (entry.community && entry.community.name) || 'A community on another instance',
        sub: 'on another instance',
        onClick: () => openRelayed(entry),
      })));
    } catch (error) {
      // Federation switched off is not a failure: the instance says so.
      const message = error && error.status === 404
        ? 'Federation is not enabled on this instance.'
        : (error && error.message) || 'The communities could not be read.';
      followed.replaceChildren(blank({
        glyph: 'share',
        title: 'Nothing to show',
        text: message,
      }));
    }
  }

  // The relayed messages of one community on another instance. Each one can be
  // reported to the instance that wrote it.
  function openRelayed(entry) {
    const list = el('div', { class: 'rowlist' });
    const dialog = openDialog({
      title: (entry.community && entry.community.name) || 'Relayed messages',
      body: el('div', { class: 'fold' }, list),
    });

    Api.continuumRelayedMessages(entry.origin_instance_id, entry.origin_community_id)
      .then((rows) => {
        const messages = Array.isArray(rows) ? rows : [];
        list.replaceChildren(...(messages.length ? messages.map((message) => row({
          class: 'federation-row',
          lead: el('span', { class: 'federation-glyph' }, icon('message', { size: 15 })),
          title: String(message.content || '').replace(/\s+/g, ' ').trim() || '(a message that was removed)',
          sub: (message.author_display_name || message.author_username || 'Someone')
            + ' · written on another instance',
          side: el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            'aria-label': 'Report this message to the instance that wrote it',
            onClick: () => reportDialog({
              targetInstanceId: message.origin_instance_id,
              communityId: message.origin_community_id,
              channelId: message.origin_channel_id,
              contentId: message.origin_message_id,
              contentType: 'message',
            }, {
              disclosure: known,
              onFiled: (filedReport) => {
                showDisclosure(filedReport);
                paintFiled();
              },
            }),
          }, 'Report'),
        })) : [blank({
          glyph: 'message',
          title: 'Nothing has been relayed here',
          text: 'When a message arrives from that instance, it is listed here.',
        })]));
      })
      .catch((error) => {
        list.replaceChildren(el('p', { class: 'form-error' },
          (error && error.message) || 'The relayed messages could not be read.'));
      });
  }

  // ---- the writer's view -----------------------------------------------------

  // What this account wrote into a community that lives on another instance,
  // and what the owner of that community decided about it.
  async function paintOutgoing() {
    try {
      const rows = await continuum.outgoing();
      const messages = Array.isArray(rows) ? rows : [];
      if (!messages.length) {
        outgoing.replaceChildren(blank({
          glyph: 'send',
          title: 'Nothing written elsewhere yet',
          text: 'When you write in a community that lives on another instance, it is listed here '
            + 'with the answer its owner gave.',
        }));
        return;
      }
      outgoing.replaceChildren(...messages.map((message) => outgoingRow(message)));
    } catch (error) {
      if (federationOff(error)) {
        outgoing.replaceChildren(blank({
          glyph: 'share',
          title: 'Nothing to show',
          text: 'Federation is not enabled on this instance.',
        }));
        return;
      }
      outgoing.replaceChildren(fault(error, paintOutgoing));
    }
  }

  function outgoingRow(message) {
    const decision = decisionOf(message);
    const community = remoteNames.get(message.origin_instance_id + '|' + message.origin_community_id);
    // A message that was taken back is gone: there is nothing left to edit and
    // nothing left to take back.
    const gone = !!(message.deleted || message.state === 'deleted');
    return row({
      class: 'federation-row',
      lead: el('span', { class: 'federation-glyph' }, icon('send', { size: 15 })),
      title: String(message.content || '').replace(/\s+/g, ' ').trim()
        || '(a message that was taken back)',
      sub: (community ? 'in ' + community + ' · ' : 'in a community on another instance · ')
        + decision.sub,
      meta: message.created_at ? relativeTime(message.created_at) : '',
      side: [
        el('span', { class: 'badge' + decision.tone }, decision.label),
        gone ? null : el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'Edit the message you wrote in this community',
          onClick: () => editOutgoing(message),
        }, 'Edit'),
        gone ? null : el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'Take back the message you wrote in this community',
          onClick: () => takeBackOutgoing(message),
        }, 'Take back'),
      ],
    });
  }

  function editOutgoing(message) {
    const content = el('textarea', {
      class: 'textarea', rows: '4', 'aria-label': 'The message you wrote',
    }, message.content || '');
    const note = el('p', { class: 'form-error', role: 'alert' });
    const submit = el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Save the change');

    const dialog = openDialog({
      title: 'Edit your message',
      sub: 'The change is published to the instance that owns the community.',
      body: el('form', {
        class: 'form-stack',
        onSubmit: async (event) => {
          event.preventDefault();
          const text = content.value.trim();
          if (!text) {
            note.textContent = 'A message cannot be empty.';
            return;
          }
          submit.disabled = true;
          try {
            await continuum.editOutgoing(message.id, text);
            dialog.close();
            toast('The change was sent to the instance that owns the community.');
            paintOutgoing();
          } catch (error) {
            note.textContent = (error && error.message) || 'The change was not accepted.';
            submit.disabled = false;
          }
        },
      },
        el('label', { class: 'field' },
          el('span', { class: 'field-label' }, 'Message'),
          content),
        note,
        submit),
    });
    content.focus();
    return dialog;
  }

  function takeBackOutgoing(message) {
    askAction({
      title: 'Take this message back?',
      what: 'The message is deleted here, and the instance that owns the community is told, '
        + 'so the copy over there goes too.',
      confirmLabel: 'Take it back',
      danger: true,
      onConfirm: () => continuum.deleteOutgoing(message.id),
      onAnswer: () => {
        toast('The message was taken back here. The owner of that community is told, '
          + 'so the copy over there goes too.');
        paintOutgoing();
      },
    });
  }

  // ---- the owner's surface ---------------------------------------------------

  // May this account moderate in this community? The server said so: the
  // community list it hands out carries the caller's own permissions.
  function mayModerate(server) {
    if (!server) return false;
    if (server.is_owner) return true;
    const permissions = Array.isArray(server.permissions) ? server.permissions : [];
    return permissions.indexOf('*') !== -1 || permissions.indexOf('MANAGE_MESSAGES') !== -1;
  }

  async function paintModeration() {
    moderation.replaceChildren(hold('Reading what your communities wrote elsewhere'));
    try {
      const mine = await Api.servers();
      const communities = (Array.isArray(mine) ? mine : []).filter(mayModerate);
      // A reader who may moderate nothing is offered nothing: no list, no
      // controls, no trace that the surface exists.
      if (!communities.length) {
        moderation.replaceChildren();
        return;
      }
      const names = {};
      for (const community of communities) names[community.id] = community.name;

      // One community at a time would be one round trip after another; the
      // communities are read together, and a community the server refuses is
      // reported rather than hidden.
      const read = await Promise.all(communities.map(async (community) => {
        try {
          const [rows, people] = await Promise.all([
            continuum.moderationMessages(community.id),
            continuum.moderationMembers(community.id),
          ]);
          return {
            messages: Array.isArray(rows) ? rows : [],
            members: Array.isArray(people) ? people : [],
            error: null,
          };
        } catch (error) {
          return { messages: [], members: [], error };
        }
      }));

      const messages = [];
      const members = [];
      const failures = [];
      for (const entry of read) {
        messages.push(...entry.messages);
        members.push(...entry.members);
        if (entry.error) failures.push(entry.error);
      }

      moderation.replaceChildren(answer, moderationSurface({
        messages, members, names, refresh: paintModeration, say,
      }));
      if (failures.length) {
        if (federationOff(failures[0])) {
          moderation.replaceChildren(blank({
            glyph: 'share',
            title: 'Nothing to show',
            text: 'Federation is not enabled on this instance.',
          }));
          return;
        }
        moderation.insertBefore(fault(failures[0], paintModeration), moderation.firstChild);
      }
    } catch (error) {
      moderation.replaceChildren(fault(error, paintModeration));
    }
  }

  const node = fold([
    head({
      kicker: 'Federation',
      title: 'Across instances',
      lede: 'What you have asked other instances to look at, what you have written in '
        + 'their communities, and what the members of your own communities wrote in theirs.',
    }),
    card({
      label: 'Reports you have filed', glyph: 'flag', flush: true, body: filed,
    }),
    card({
      label: 'What a report carries', glyph: 'info',
      note: 'the server says this, and the client repeats it',
      body: disclosure,
    }),
    card({
      label: 'Communities on other instances', glyph: 'share', flush: true, body: followed,
    }),
    card({
      label: 'What you wrote in communities on other instances', glyph: 'send',
      note: 'with the answer their owners gave',
      flush: true, body: outgoing,
    }),
    moderation,
  ]);

  return {
    node,
    onMount: async () => {
      await paintFiled();
      await paintFollowed();
      await paintOutgoing();
      await paintModeration();
    },
    cleanup() {},
  };
}

export default { renderFederation, moderationSurface, continuum };

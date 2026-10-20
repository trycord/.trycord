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
//
// A phone is a screen at a time: the lists are short, and everything that is
// acted on opens in a sheet.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import { relativeTime } from '../../../packages/format.js';
import { empty, loading, failure, iconButton } from '../components.js';
import { screen, section, actions, primaryButton, notice } from './util.js';
import { sheet, toast } from '../ui.js';

// What the server says crosses with a report, and what does not.
export function disclosurePanel(disclosure) {
  if (!disclosure) return null;
  const shared = Array.isArray(disclosure.shared) ? disclosure.shared : [];
  const notShared = Array.isArray(disclosure.notShared) ? disclosure.notShared : [];
  if (!shared.length && !notShared.length) return null;
  return el('div', { class: 'm-disclosure' },
    el('div', { class: 'm-disclosure__title' }, 'What crosses with a report'),
    el('ul', { class: 'm-disclosure__list' }, shared.map((line) => el('li', {}, line))),
    el('div', { class: 'm-disclosure__title' }, 'What does not cross'),
    el('ul', { class: 'm-disclosure__list' }, notShared.map((line) => el('li', {}, line))));
}

// The sheet that files one.
//
// The reason is required, because a report with no reason is a report nobody
// can act on. The disclosure is shown before the report is sent when the
// server has already told us what it says, and again from the answer.
export function reportSheet(target, options) {
  const opts = options || {};
  const reason = el('input', {
    class: 'm-input', type: 'text', 'aria-label': 'Why you are reporting this',
    placeholder: 'What is wrong with it',
  });
  const description = el('input', {
    class: 'm-input', type: 'text', 'aria-label': 'Anything else the other instance should know',
  });

  const layer = sheet({
    title: 'Report to the other instance',
    body: el('div', { class: 'm-stack' },
      el('label', { class: 'm-field' },
        el('span', { class: 'm-field__label' }, 'Reason'), reason),
      el('label', { class: 'm-field' },
        el('span', { class: 'm-field__label' }, 'Anything else'), description),
      disclosurePanel(opts.disclosure)),
    footer: actions([
      primaryButton('File the report', async () => {
        if (!reason.value.trim()) {
          toast('Say why, so the other instance can act on it.', { type: 'error' });
          return;
        }
        try {
          const filed = await Api.fileFederationReport({
            targetInstanceId: target.targetInstanceId,
            communityId: target.communityId,
            channelId: target.channelId,
            contentId: target.contentId,
            contentType: target.contentType || 'message',
            reason: reason.value.trim(),
            description: description.value.trim() || undefined,
          });
          layer.close();
          toast('The report has been filed.', { type: 'success' });
          if (opts.onFiled) opts.onFiled(filed);
        } catch (error) { toast(error.message, { type: 'error' }); }
      }, { block: true }),
    ]),
  });
  return layer;
}

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
  joined: 'a member',
  muted: 'muted',
  removed: 'removed',
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
    return { label: 'accepted', text: 'The owner of that community accepted it.', tone: 'success' };
  }
  if (state === 'refused') {
    return {
      label: 'refused',
      text: 'The owner of that community refused it' + (message.reason ? ': ' + message.reason : '.'),
      tone: 'danger',
    };
  }
  if (state === 'deleted') {
    return { label: 'taken back', text: 'The owner of that community took it back.', tone: 'warning' };
  }
  return { label: 'waiting', text: 'The owner of that community has not answered yet.', tone: 'info' };
}

function authorName(message) {
  return (message && (message.author_display_name || message.author_username)) || 'Someone';
}

// Federation switched off is not a failure: the instance says so, and the
// screen says it back rather than showing a broken page.
function federationOff(error) {
  return !!(error && error.status === 404);
}

// ---- the sheet every action shares ------------------------------------------
//
// A destructive action says what it will do before it does it, takes the
// reason that goes into the audit trail, and reports what the server
// answered - including the answer that the other instance was not told.
function actionSheet(options) {
  const opts = options || {};
  const reason = el('input', {
    class: 'm-input', type: 'text',
    'aria-label': 'Why (it goes into the audit trail)',
    placeholder: 'Why',
  });
  const note = el('p', { class: 'm-form-error', role: 'alert' });
  const confirm = el('button', {
    class: 'm-btn m-btn--block' + (opts.danger ? ' m-btn--danger' : ' m-btn--primary'),
    type: 'button',
    onClick: async () => {
      confirm.disabled = true;
      try {
        const answer = await opts.onConfirm(reason.value.trim());
        layer.close();
        if (opts.onAnswer) opts.onAnswer(answer);
      } catch (error) {
        note.textContent = (error && error.message) || 'The server refused that.';
        confirm.disabled = false;
      }
    },
  }, opts.confirmLabel || 'Do it');

  const layer = sheet({
    title: opts.title,
    body: el('div', { class: 'm-stack' },
      el('p', { class: 'm-lede' }, opts.what),
      el('label', { class: 'm-field' },
        el('span', { class: 'm-field__label' }, 'Why (it goes into the audit trail)'),
        reason),
      note),
    footer: confirm,
  });
  return layer;
}

export function renderFederation(ctx) {
  const filed = el('div', { class: 'm-list' });
  const followed = el('div', { class: 'm-list' });
  const disclosure = el('div', { class: 'm-stack' });
  const outgoing = el('div', { class: 'm-list' });
  const moderation = el('div', { class: 'm-stack' });
  // What the server answered the last time. It lives here rather than in the
  // surface, so that re-reading the surface after an action does not take the
  // answer with it.
  const answer = el('div', { class: 'm-stack' });

  function say(title, text, tone) {
    answer.replaceChildren(notice({ tone: tone || 'info', role: 'status', title, text }));
  }
  const host = el('div', { class: 'm-stack' });
  const node = screen(
    el('div', { class: 'm-hero m-hero--quiet' },
      el('h1', { class: 'm-hero__title' }, 'Across instances'),
      el('div', { class: 'm-hero__sub' }, 'What you have asked other instances to look at, '
        + 'what you have written in their communities, and what the members of your own '
        + 'communities wrote in theirs.')),
    host);

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
    clear(disclosure);
    disclosure.appendChild(disclosurePanel(found));
  }

  async function paintFiled() {
    try {
      const rows = await Api.myFederationReports();
      const reports = Array.isArray(rows) ? rows : [];
      if (reports.length) showDisclosure(reports[0]);
      clear(filed);
      if (!reports.length) {
        filed.appendChild(empty({
          icon: 'flag',
          title: 'No reports filed',
          text: 'A report asks another instance to look at something.',
        }));
        return;
      }
      for (const entry of reports) {
        filed.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__lead' }, icon('flag', { size: 17 })),
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title truncate' }, entry.reason),
            el('span', { class: 'm-row__sub truncate' },
              'about a ' + (entry.contentType || 'message') + ' on another instance')),
          el('span', { class: 'm-row__actions' },
            el('span', { class: 'm-chip' }, entry.status || 'FILED'))));
      }
    } catch (error) {
      clear(filed);
      filed.appendChild(failure(error, paintFiled));
    }
  }

  async function paintFollowed() {
    clear(followed);
    followed.appendChild(loading('Reading the communities you follow'));
    try {
      const rows = await Api.continuumMemberships();
      const memberships = Array.isArray(rows) ? rows : [];
      remoteNames.clear();
      for (const entry of memberships) {
        const name = entry.community && entry.community.name;
        if (!name) continue;
        remoteNames.set(entry.origin_instance_id + '|' + entry.origin_community_id, name);
      }
      clear(followed);
      if (!memberships.length) {
        followed.appendChild(empty({
          icon: 'share',
          title: 'No communities on other instances',
          text: 'When you follow a community that lives on another instance, it is listed here.',
        }));
        return;
      }
      for (const entry of memberships) {
        followed.appendChild(el('button', {
          class: 'm-row', type: 'button',
          onClick: () => openRelayed(entry),
        },
        el('span', { class: 'm-row__lead' }, icon('globe', { size: 17 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title truncate' },
            (entry.community && entry.community.name) || 'A community on another instance'),
          el('span', { class: 'm-row__sub' }, 'written on another instance')),
        el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 }))));
      }
    } catch (error) {
      clear(followed);
      followed.appendChild(empty({
        icon: 'share',
        title: 'Nothing to show',
        text: error && error.status === 404
          ? 'Federation is not enabled on this instance.'
          : (error && error.message) || 'The communities could not be read.',
      }));
    }
  }

  // The relayed messages of one community on another instance. Each one can be
  // reported to the instance that wrote it.
  function openRelayed(entry) {
    const body = el('div', { class: 'm-stack' });
    const layer = sheet({
      title: (entry.community && entry.community.name) || 'Relayed messages',
      body,
    });

    Api.continuumRelayedMessages(entry.origin_instance_id, entry.origin_community_id)
      .then((rows) => {
        const messages = Array.isArray(rows) ? rows : [];
        clear(body);
        if (!messages.length) {
          body.appendChild(empty({
            icon: 'message',
            title: 'Nothing has been relayed here',
            text: 'When a message arrives from that instance, it is listed here.',
          }));
          return;
        }
        const list = el('div', { class: 'm-list' });
        for (const message of messages) {
          list.appendChild(el('div', { class: 'm-row' },
            el('span', { class: 'm-row__lead' }, icon('message', { size: 17 })),
            el('span', { class: 'm-row__body' },
              el('span', { class: 'm-row__title truncate' },
                String(message.content || '').replace(/\s+/g, ' ').trim() || '(a message that was removed)'),
              el('span', { class: 'm-row__sub truncate' },
                (message.author_display_name || message.author_username || 'Someone'))),
            el('span', { class: 'm-row__actions' },
              iconButton('flag', 'Report this message to the instance that wrote it', () => {
                reportSheet({
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
                });
              }))));
        }
        body.appendChild(list);
      })
      .catch((error) => {
        clear(body);
        body.appendChild(failure(error, () => openRelayed(entry)));
      });
  }

  // ---- the writer's view -----------------------------------------------------

  // What this account wrote into a community that lives on another instance,
  // and what the owner of that community decided about it.
  async function paintOutgoing() {
    try {
      const rows = await continuum.outgoing();
      const messages = Array.isArray(rows) ? rows : [];
      clear(outgoing);
      if (!messages.length) {
        outgoing.appendChild(empty({
          icon: 'send',
          title: 'Nothing written elsewhere yet',
          text: 'When you write in a community that lives on another instance, it is listed '
            + 'here with the answer its owner gave.',
        }));
        return;
      }
      for (const message of messages) outgoing.appendChild(outgoingRow(message));
    } catch (error) {
      clear(outgoing);
      if (federationOff(error)) {
        outgoing.appendChild(empty({
          icon: 'share',
          title: 'Nothing to show',
          text: 'Federation is not enabled on this instance.',
        }));
        return;
      }
      outgoing.appendChild(failure(error, paintOutgoing));
    }
  }

  function outgoingRow(message) {
    const decision = decisionOf(message);
    const community = remoteNames.get(message.origin_instance_id + '|' + message.origin_community_id);
    return el('button', {
      class: 'm-row', type: 'button',
      onClick: () => openOutgoing(message, community),
    },
    el('span', { class: 'm-row__lead' }, icon('send', { size: 17 })),
    el('span', { class: 'm-row__body' },
      el('span', { class: 'm-row__title truncate' },
        String(message.content || '').replace(/\s+/g, ' ').trim() || '(a message that was taken back)'),
      el('span', { class: 'm-row__sub truncate' },
        (community ? community + ' · ' : '') + decision.label)),
    el('span', { class: 'm-row__actions' }, el('span', { class: 'm-chip' }, decision.label)),
    el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 })));
  }

  // The sheet that shows one message of this account, what the owner decided
  // about it, and what can still be done to it.
  function openOutgoing(message, community) {
    const decision = decisionOf(message);
    // A message that was taken back is gone: there is nothing left to edit and
    // nothing left to take back.
    const gone = !!(message.deleted || message.state === 'deleted');
    const body = el('div', { class: 'm-stack' },
      el('p', { class: 'm-lede' }, String(message.content || '').trim()
        || 'This message was taken back.'),
      notice({
        tone: decision.tone,
        title: decision.label,
        text: decision.text,
        meta: message.created_at ? relativeTime(message.created_at) : null,
      }));

    const layer = sheet({
      title: community || 'A community on another instance',
      body,
      footer: gone ? null : actions([
        el('button', {
          class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
          onClick: () => { layer.close(); editOutgoing(message); },
        }, 'Edit'),
        el('button', {
          class: 'm-btn m-btn--sm m-btn--danger', type: 'button',
          onClick: () => { layer.close(); takeBackOutgoing(message); },
        }, 'Take back'),
      ]),
    });
    return layer;
  }

  function editOutgoing(message) {
    const content = el('textarea', {
      class: 'm-input', rows: '4', 'aria-label': 'The message you wrote',
    }, message.content || '');
    const note = el('p', { class: 'm-form-error', role: 'alert' });
    const save = el('button', {
      class: 'm-btn m-btn--block m-btn--primary', type: 'button',
      onClick: async () => {
        const text = content.value.trim();
        if (!text) {
          note.textContent = 'A message cannot be empty.';
          return;
        }
        save.disabled = true;
        try {
          await continuum.editOutgoing(message.id, text);
          layer.close();
          toast('The change was sent to the instance that owns the community.', { type: 'success' });
          paintOutgoing();
        } catch (error) {
          note.textContent = (error && error.message) || 'The change was not accepted.';
          save.disabled = false;
        }
      },
    }, 'Save the change');

    const layer = sheet({
      title: 'Edit your message',
      body: el('div', { class: 'm-stack' },
        el('p', { class: 'm-lede' }, 'The change is published to the instance that owns the community.'),
        el('label', { class: 'm-field' },
          el('span', { class: 'm-field__label' }, 'Message'), content),
        note),
      footer: save,
    });
    return layer;
  }

  function takeBackOutgoing(message) {
    actionSheet({
      title: 'Take this message back?',
      what: 'The message is deleted here, and the instance that owns the community is told, '
        + 'so the copy over there goes too.',
      confirmLabel: 'Take it back',
      danger: true,
      onConfirm: () => continuum.deleteOutgoing(message.id),
      onAnswer: () => {
        toast('The message was taken back here. The owner of that community is told, '
          + 'so the copy over there goes too.', { type: 'success' });
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
    try {
      const mine = await Api.servers();
      const communities = (Array.isArray(mine) ? mine : []).filter(mayModerate);
      // A reader who may moderate nothing is offered nothing: no list, no
      // controls, no trace that the surface exists.
      if (!communities.length) {
        clear(moderation);
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

      if (failures.length && federationOff(failures[0])) {
        clear(moderation);
        moderation.appendChild(empty({
          icon: 'share',
          title: 'Nothing to show',
          text: 'Federation is not enabled on this instance.',
        }));
        return;
      }

      clear(moderation);
      moderation.appendChild(moderationSurface({
        messages, members, names, refresh: paintModeration, answer, say,
      }));
      if (failures.length) moderation.appendChild(failure(failures[0], paintModeration));
    } catch (error) {
      clear(moderation);
      moderation.appendChild(failure(error, paintModeration));
    }
  }

  host.append(
    section('Reports you have filed', filed),
    section('What a report carries', disclosure),
    section('Communities on other instances', followed),
    section('What you wrote in communities on other instances', outgoing),
    moderation);

  return {
    node,
    head: { title: 'Federation' },
    onMount: async () => {
      await paintFiled();
      await paintFollowed();
      await paintOutgoing();
      await paintModeration();
    },
  };
}

// ---- the owner's moderation surface ------------------------------------------
//
// Shared with the admin console's federation section, which is the same
// surface for the person who runs the instance: what the members of this
// instance's communities wrote on other instances, and the decisions about it.

export function moderationSurface(options) {
  const opts = options || {};
  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  const members = Array.isArray(opts.members) ? opts.members : [];
  const names = opts.names && typeof opts.names === 'object' ? opts.names : {};
  const refresh = typeof opts.refresh === 'function' ? opts.refresh : async () => {};
  const say = typeof opts.say === 'function' ? opts.say : () => {};

  // The sheet for one message a member wrote elsewhere: what it says, where it
  // was written, and the one decision the owner has about it.
  function openMessage(message, community) {
    const body = el('div', { class: 'm-stack' },
      el('p', { class: 'm-lede' }, String(message.content || '').replace(/\s+/g, ' ').trim()
        || 'This message has been taken back.'),
      el('p', { class: 'm-row__sub' }, authorName(message) + ' · written on '
        + message.origin_instance_id + (community ? ' · in ' + community : '')));

    const layer = sheet({
      title: 'A message written elsewhere',
      body,
      footer: message.deleted ? null : el('button', {
        class: 'm-btn m-btn--block m-btn--danger', type: 'button',
        onClick: () => { layer.close(); takeBack(message); },
      }, 'Take back'),
    });
    return layer;
  }

  function takeBack(message) {
    actionSheet({
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

  // The sheet for one member of one of this instance's communities who lives
  // on another instance, with the three decisions the owner has about them.
  function openMember(member, community) {
    const state = MEMBER_STATE[String(member.state || 'joined')] || MEMBER_STATE.joined;
    const name = member.display_name || member.username || 'Someone';
    const body = el('div', { class: 'm-stack' },
      notice({
        tone: 'info',
        title: state,
        text: 'They live on ' + member.origin_instance_id
          + (community ? ' and are a member of ' + community + '.' : '.'),
      }));

    const layer = sheet({
      title: name,
      body,
      footer: el('div', { class: 'm-actions' }, MEMBER_ACTIONS.map((action) => el('button', {
        class: 'm-btn m-btn--sm' + (action.action === 'remove' ? ' m-btn--danger' : ' m-btn--ghost'),
        type: 'button',
        onClick: () => { layer.close(); decide(member, action); },
      }, action.label))),
    });
    return layer;
  }

  function decide(member, action) {
    actionSheet({
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
          say(action.done, name + ' ' + action.state + ', and '
            + member.origin_instance_id + ' was told.', 'success');
        } else {
          say(action.done, name + ' ' + action.state + ', but '
            + member.origin_instance_id + ' was not told'
            + ((result && result.reason) ? ': ' + result.reason : '.'), 'warning');
        }
        refresh();
      },
    });
  }

  function messageList() {
    const list = el('div', { class: 'm-list' });
    if (!messages.length) {
      list.appendChild(empty({
        icon: 'message',
        title: 'Nothing has been written elsewhere',
        text: 'When a member of one of your communities writes on another instance, it is listed here.',
      }));
      return list;
    }
    for (const message of messages) {
      const community = names[message.origin_community_id];
      list.appendChild(el('button', {
        class: 'm-row', type: 'button',
        onClick: () => openMessage(message, community),
      },
      el('span', { class: 'm-row__lead' }, icon('message', { size: 17 })),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title truncate' },
          String(message.content || '').replace(/\s+/g, ' ').trim() || '(a message that was taken back)'),
        el('span', { class: 'm-row__sub truncate' },
          authorName(message) + ' · on ' + message.origin_instance_id
          + (community ? ' · ' + community : ''))),
      el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 }))));
    }
    return list;
  }

  function memberList() {
    const list = el('div', { class: 'm-list' });
    if (!members.length) {
      list.appendChild(empty({
        icon: 'users',
        title: 'No members live on another instance',
        text: 'When a member of one of your communities lives on another instance, they are listed here.',
      }));
      return list;
    }
    for (const member of members) {
      const community = names[member.origin_community_id];
      const state = MEMBER_STATE[String(member.state || 'joined')] || MEMBER_STATE.joined;
      const name = member.display_name || member.username || 'Someone';
      list.appendChild(el('button', {
        class: 'm-row', type: 'button',
        onClick: () => openMember(member, community),
      },
      el('span', { class: 'm-row__lead' }, icon('user', { size: 17 })),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title truncate' }, name),
        el('span', { class: 'm-row__sub truncate' },
          'on ' + member.origin_instance_id + (community ? ' · ' + community : ''))),
      el('span', { class: 'm-row__actions' }, el('span', { class: 'm-chip' }, state)),
      el('span', { class: 'm-row__chevron' }, icon('chevron-right', { size: 18 }))));
    }
    return list;
  }

  return el('div', { class: 'm-stack' },
    opts.answer || null,
    section('Messages members wrote elsewhere', messageList()),
    section('Members who live on another instance', memberList()));
}

export default { renderFederation, moderationSurface, continuum };

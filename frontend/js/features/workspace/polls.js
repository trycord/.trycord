// The polls, on a desk.
//
// A poll is a question put to the community. It has options, a window, a way
// of scoring the answers and - sometimes - a quorum.
//
// Voting is idempotent: a member has one ballot per poll, and casting a ballot
// replaces the previous one. The desk therefore keeps no tally of its own: it
// sends the whole ballot and shows what the server counted.
//
// A poll that has not closed shows its results only to those the server allows
// - the person who set it up and the people who manage the community's
// content. Everybody else sees the question and the ballot, and the server's
// refusal is shown as what it is rather than as a fault.
//
// A ranked poll is scored by position: the first choice of a ballot is worth
// the number of options, the second one fewer, and the last one a point. The
// desk shows the score the server worked out and what a position is worth.
//
// An anonymous poll never names its voters, before the close or after it, and
// the desk does not name them either.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { card, row, blank, fault, fold, hold, memo, facts } from '../../ui/page.js';
import { iconButton } from '../../ui/primitives.js';
import { openDialog, confirmDialog, toast, errorToast } from '../../ui/overlays.js';
import { relativeTime } from '../../../packages/format.js';
import { path } from '../../../packages/nav.js';
import { State } from '../../../packages/store.js';
import {
  Workspace, POLL_SCORINGS, POLL_SCORING_LABELS, POLL_ELIGIBILITY_LABELS,
  mayPost, mayActOn, paramId,
  pollRoute, bordaPoints,
} from '../../../packages/workspace.js';

// -- the list ------------------------------------------------------------------

export function pollsList(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'rowlist' });
  const canPost = mayPost(serverId);

  const node = card({
    label: 'Polls',
    glyph: 'chart',
    note: 'a question, and the answer it recorded',
    actions: canPost
      ? el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        onClick: () => openPollEditor(serverId, load),
      }, icon('plus', { size: 14 }), 'New poll')
      : null,
    body: host,
    flush: true,
  });

  const load = async () => {
    host.replaceChildren(hold('Reading the polls'));
    try {
      const polls = await Workspace.polls(serverId);
      host.replaceChildren(...(polls.length
        ? polls.map((poll) => row({
          lead: el('span', { class: 'role-dot' }, icon('chart', { size: 15 })),
          title: poll.question,
          sub: (POLL_SCORING_LABELS[poll.scoring] || poll.scoring)
            + (poll.isAnonymous ? ' · anonymous' : '')
            + (poll.allowsMultiple ? ' · several answers' : ''),
          meta: el('span', { class: 'chip chip--' + (poll.status === 'closed' ? 'quiet' : 'on') },
            poll.status === 'closed' ? 'closed' : 'open'),
          href: path(pollRoute(serverId, poll.id)),
          link: true,
        }))
        : [blank({
          glyph: 'chart',
          title: 'No polls yet',
          text: 'A poll is a question the community answers.',
        })]));
    } catch (error) {
      host.replaceChildren(fold([fault(error, load)]));
    }
  };

  return { node, onMount: load, cleanup() {} };
}

// -- one poll --------------------------------------------------------------------

export function pollsDetail(ctx) {
  const serverId = ctx.serverId;
  const pollId = paramId(ctx.params, 'poll');

  if (!pollId) {
    return {
      node: blank({
        glyph: 'chart',
        title: 'No poll open',
        text: 'Choose a poll on the left to see it.',
      }),
      onMount: async () => {},
      cleanup() {},
    };
  }

  const canPost = mayPost(serverId);
  const me = State.user && State.user.id;

  let poll = null;
  let results = null;
  let resultsError = null;
  let ballot = [];          // the options chosen, in the order they were chosen

  const head = el('div', { class: 'fold fold--tight' });
  const choices = el('div', { class: 'rowlist' });
  const outcome = el('div', { class: 'fold fold--tight' });
  const voters = el('div', { class: 'rowlist' });
  const actions = el('span', { class: 'rowtools' });

  const node = fold([
    card({
      label: 'The poll',
      glyph: 'chart',
      actions,
      body: fold([head, choices], { tight: true }),
    }),
    card({ label: 'The result', glyph: 'activity', body: outcome, flush: true }),
    card({ label: 'Who voted', glyph: 'users', body: voters, flush: true }),
  ]);

  // The actions the reader may use on this poll. The server refuses a poll
  // that is not open, so a closed poll is not offered a close.
  const paintActions = () => {
    const tools = [];
    if (canPost) {
      tools.push(el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        onClick: () => openPollEditor(serverId, load),
      }, icon('plus', { size: 14 }), 'New poll'));
    }
    if (poll && poll.status !== 'closed' && mayActOn(serverId, poll.createdBy, me)) {
      // The server refuses to edit a poll that has answers, so the action is
      // offered only while the poll is one somebody could still change. The
      // server's answer is the rule; this only avoids offering what it will
      // refuse.
      if (!poll.hasAnswers) {
        tools.push(el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onClick: () => openPollEditor(serverId, load, poll),
        }, icon('edit', { size: 14 }), 'Edit it'));
      }
      tools.push(el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        onClick: () => close(),
      }, 'Close it'));
    }
    actions.replaceChildren(...tools);
  };

  // Closing a poll records the result it had and stops the votes. Only the
  // person who set the poll up and the people who manage this community may
  // close it, and the client asks the same question the server does.
  const close = async () => {
    if (!poll || poll.status === 'closed') return;
    const yes = await confirmDialog({
      title: 'Close the poll?',
      body: 'The result is recorded and the poll stops taking votes.',
      confirmLabel: 'Close',
    });
    if (!yes) return;
    try {
      await Workspace.closePoll(serverId, pollId);
      toast('The poll is closed');
      await load();
    } catch (error) {
      errorToast(error);
    }
  };

  const paintHead = () => {
    head.replaceChildren(
      el('h2', { class: 'pagehead-title' }, poll.question),
      el('p', { class: 'form-note' },
        (POLL_SCORING_LABELS[poll.scoring] || poll.scoring)
        + ' · ' + (poll.isAnonymous ? 'nobody is named' : 'the voters are named')
        + ' · ' + (POLL_ELIGIBILITY_LABELS[poll.eligibility] || poll.eligibility)
        + ' · ' + (poll.status === 'closed' ? 'closed' : 'open')),
      poll.closesAt ? el('p', { class: 'form-note' }, 'Closes ' + relativeTime(poll.closesAt)) : null,
    );
  };

  // The ballot. A single-choice poll offers radio buttons, a poll that takes
  // several answers offers checkboxes, and a ranked poll offers the options in
  // an order the reader sets.
  const paintChoices = () => {
    const options = poll.options || [];
    if (!canPost || poll.status === 'closed') {
      choices.replaceChildren(el('p', { class: 'form-note' },
        poll.status === 'closed'
          ? 'This poll is closed. The result it recorded is below.'
          : 'Voting needs the permission to post in this community.'));
      return;
    }
    if (poll.scoring === 'ranked') {
      const list = el('div', { class: 'rowlist' });
      const order = ballot.length ? ballot : options.map((option) => option.id);
      options.forEach((option) => {
        const position = order.indexOf(option.id);
        list.appendChild(row({
          title: option.label,
          sub: position === -1
            ? 'Not ranked'
            : 'Ranked ' + (position + 1) + ' · worth ' + bordaPoints(position + 1, options.length) + ' points',
          side: el('span', { class: 'rowtools' },
            iconButton('chevron-up', {
              label: 'Rank ' + option.label + ' higher', class: 'icon-btn--sm',
              onClick: () => moveInOrder(order, option.id, -1),
            }),
            iconButton('chevron-down', {
              label: 'Rank ' + option.label + ' lower', class: 'icon-btn--sm',
              onClick: () => moveInOrder(order, option.id, 1),
            })),
        }));
      });
      choices.replaceChildren(list, el('div', { class: 'actionline' },
        el('button', {
          class: 'btn btn--primary btn--sm', type: 'button',
          onClick: () => vote(order),
        }, 'Vote')));
      return;
    }

    const multiple = poll.allowsMultiple;
    const inputs = new Map();
    const list = el('div', { class: 'rowlist' });
    for (const option of options) {
      const input = el('input', {
        type: multiple ? 'checkbox' : 'radio',
        name: 'poll-option',
        value: option.id,
        'aria-label': option.label,
        checked: ballot.indexOf(option.id) !== -1,
      });
      input.addEventListener('change', () => {
        if (multiple) {
          const chosen = new Set(ballot);
          if (input.checked) chosen.add(option.id);
          else chosen.delete(option.id);
          ballot = options.filter((entry) => chosen.has(entry.id)).map((entry) => entry.id);
          return;
        }
        ballot = [option.id];
      });
      inputs.set(option.id, input);
      list.appendChild(row({
        lead: input,
        title: option.label,
      }));
    }
    choices.replaceChildren(list, el('div', { class: 'actionline' },
      el('button', {
        class: 'btn btn--primary btn--sm', type: 'button',
        onClick: () => vote(ballot),
      }, 'Vote')));
  };

  // Move an option one place up or down the ranking.
  const moveInOrder = (order, id, delta) => {
    const to = order.indexOf(id) + delta;
    if (to < 0 || to >= order.length) return;
    const next = order.slice();
    const [moved] = next.splice(order.indexOf(id), 1);
    next.splice(to, 0, moved);
    ballot = next;
    paintChoices();
  };

  // A vote replaces the previous one: the whole ballot goes to the server and
  // the count the desk shows is the count the server worked out.
  const vote = async (choices_) => {
    if (!choices_ || !choices_.length) {
      toast('Choose an option first', { type: 'error' });
      return;
    }
    try {
      await Workspace.votePoll(serverId, pollId, choices_);
      ballot = choices_;
      toast('Your vote is counted');
      await loadResults();
    } catch (error) {
      errorToast(error);
    }
  };

  const paintResults = () => {
    if (resultsError) {
      outcome.replaceChildren(memo({
        tone: 'info',
        title: 'The results are not visible yet',
        text: resultsError,
      }));
      return;
    }
    if (!results || !results.results) {
      outcome.replaceChildren(el('p', { class: 'form-note' }, 'No result has been recorded.'));
      return;
    }
    const tally = results.results;
    const options = tally.options || [];
    const ballots = Number(tally.ballots || 0);
    const leader = options[0] || null;

    const cells = [
      { value: String(ballots), label: 'ballot' + (ballots === 1 ? '' : 's') },
      { value: poll.scoring === 'ranked' ? String(leader ? leader.score : 0) : String(leader ? leader.votes : 0), label: poll.scoring === 'ranked' ? 'points at the top' : 'votes at the top' },
    ];
    if (tally.quorum && tally.quorum.required !== null) {
      cells.push({ value: tally.quorum.met ? 'met' : 'not met', label: 'quorum' });
    }

    outcome.replaceChildren(fold([
      facts(cells),
      el('p', { class: 'form-note' },
        poll.scoring === 'ranked'
          ? 'A ranked poll scores a ballot by position: the first choice is worth '
            + bordaPoints(1, options.length) + ' points and the last one '
            + bordaPoints(options.length || 1, options.length || 1) + '.'
          : 'Each ballot counts once for the option it chose.'),
      ...options.map((option) => row({
        title: option.label,
        sub: poll.scoring === 'ranked'
          ? option.score + ' points · ' + option.votes + ' votes'
          : option.votes + ' vote' + (option.votes === 1 ? '' : 's'),
        meta: 'position ' + option.rank,
      })),
      tally.tied && tally.tied.length > 1
        ? memo({
          tone: 'warning',
          title: 'A tie',
          text: 'Two options have the same number of votes. There is no honest way to '
            + 'pick one of them, so neither is named as the winner.',
        })
        : null,
      tally.winner
        ? el('p', { class: 'form-note' }, 'The winner is ' + labelOf(tally, tally.winner) + '.')
        : null,
    ], { tight: true }));
  };

  const labelOf = (tally, id) => {
    const found = (tally.options || []).find((option) => String(option.id) === String(id));
    return found ? found.label : 'an option';
  };

  const paintVoters = () => {
    // An anonymous poll names nobody, before the close and after it.
    if (poll.isAnonymous) {
      voters.replaceChildren(el('p', { class: 'form-note' },
        'This poll is anonymous. It names nobody, before it closes or after.'));
      return;
    }
    const rows = results && results.results ? (results.results.voters || []) : [];
    if (!rows.length) {
      voters.replaceChildren(el('p', { class: 'form-note' },
        resultsError
          ? 'The voters are not visible until the poll closes.'
          : 'Nobody has voted yet.'));
      return;
    }
    voters.replaceChildren(...rows.map((entry) => row({
      lead: el('span', { class: 'role-dot' }, icon('user', { size: 15 })),
      title: entry.displayName || entry.username || 'A member',
      sub: (entry.choices || [])
        .map((choice) => labelOf(results.results, choice))
        .join(' · '),
    })));
  };

  const loadResults = async () => {
    outcome.replaceChildren(hold('Reading the result'));
    try {
      results = await Workspace.pollResults(serverId, pollId);
      resultsError = null;
    } catch (error) {
      results = null;
      // The server refuses the results of a poll that has not closed to a
      // reader who may not see them. That is an answer, not a fault.
      resultsError = error && error.code === 'PERMISSION_DENIED'
        ? 'The results of a poll are visible to the people who set it up and to those '
          + 'who manage this community until the poll closes. Everybody sees them '
          + 'after it does.'
        : ((error && error.message) || 'The result could not be read.');
    }
    paintResults();
    paintVoters();
  };

  const load = async () => {
    head.replaceChildren(hold('Opening the poll'));
    try {
      poll = await Workspace.poll(serverId, pollId);
      ballot = [];
      paintActions();
      paintHead();
      paintChoices();
      await loadResults();
    } catch (error) {
      head.replaceChildren(fold([fault(error, load)]));
    }
  };

  return {
    node,
    onMount: load,
    cleanup() {},
  };
}

// -- the editors ---------------------------------------------------------------------

// A poll, made.
//
// The options are the question's answers; a poll needs at least two of them,
// and the server refuses anything it does not recognise.
function openPollEditor(serverId, onDone, poll) {
  // The poll being edited, or nothing for a new one.
  //
  // The editor used to name a poll that was not in scope - the title said
  // "Edit the poll" against a variable that did not exist - and every click
  // on "New poll" threw a ReferenceError before the dialog was ever shown.
  const editing = poll || null;
  const question = el('input', {
    class: 'input', type: 'text', maxlength: '500', 'aria-label': 'The question',
  });
  const options = el('div', { class: 'fold fold--tight' });
  const scoring = el('select', { class: 'select', 'aria-label': 'How the answers are counted' },
    ...POLL_SCORINGS.map((value) => el('option', {
      value, selected: value === (editing ? editing.scoring : 'plurality'),
    }, POLL_SCORING_LABELS[value])));
  const multiple = el('input', {
    type: 'checkbox', 'aria-label': 'More than one answer may be chosen',
  });
  const anonymous = el('input', {
    type: 'checkbox', 'aria-label': 'The poll names nobody',
  });
  const error = el('p', { class: 'form-error', hidden: true });

  // The poll as it stands, when a poll is being edited.
  const answers = (editing && Array.isArray(editing.options) ? editing.options : [])
    .map((option) => ({ value: option.label || '' }));
  if (editing) {
    question.value = editing.question || '';
    multiple.checked = !!editing.allowsMultiple;
    anonymous.checked = !!editing.isAnonymous;
  }
  const paintAnswers = () => {
    options.replaceChildren(...answers.map((answer, index) => {
      const field = el('input', {
        class: 'input', type: 'text', maxlength: '255', 'aria-label': 'Option ' + (index + 1),
      });
      field.value = answer.value;
      field.addEventListener('input', () => { answer.value = field.value; });
      return el('div', { class: 'pageblock-row' }, field,
        iconButton('x', {
          label: 'Remove option ' + (index + 1), class: 'icon-btn--sm',
          onClick: () => { answers.splice(index, 1); paintAnswers(); },
        }));
    }),
    el('button', {
      class: 'btn btn--ghost btn--sm', type: 'button',
      onClick: () => { answers.push({ value: '' }); paintAnswers(); },
    }, icon('plus', { size: 14 }), 'Add an option'));
  };
  if (!answers.length) answers.push({ value: '' }, { value: '' });
  paintAnswers();

  const dialog = openDialog({
    title: editing ? 'Edit the poll' : 'New poll',
    wide: true,
    body: el('form', {
      class: 'fold',
      onSubmit: async (submit) => {
        submit.preventDefault();
        error.hidden = true;
        if (!question.value.trim()) { error.hidden = false; error.textContent = 'Ask a question.'; return; }
        const labels = answers.map((answer) => answer.value.trim()).filter(Boolean);
        if (labels.length < 2) {
          error.hidden = false;
          error.textContent = 'A poll needs at least two options.';
          return;
        }
        try {
          const body = {
            question: question.value.trim(),
            options: labels,
            scoring: scoring.value,
            allowsMultiple: multiple.checked,
            isAnonymous: anonymous.checked,
          };
          if (editing) {
            await Workspace.updatePoll(serverId, editing.id, body);
            toast('The poll is saved');
          } else {
            await Workspace.createPoll(serverId, body);
            toast('The poll is made');
          }
          dialog.close();
          if (onDone) await onDone();
        } catch (err) {
          error.hidden = false;
          error.textContent = (err && err.message)
            || (editing ? 'The poll could not be saved.' : 'The poll could not be made.');
        }
      },
    },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Question'), question),
    options,
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Scoring'), scoring),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Several answers'), multiple),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Anonymous'), anonymous),
    error,
    el('button', { class: 'btn btn--primary btn--sm', type: 'submit' },
      editing ? 'Save' : 'Create')),
  });
  question.focus();
}

export default { pollsList, pollsDetail };

// The onboarding a member is shown.
//
// A community that greets nobody is a community that loses people. This is
// what a member sees when they arrive: the welcome, the rules, and the
// questions - with what answering a question actually does said in words,
// because the member is choosing.
//
// The rules the screen keeps:
//
//   - the member is told which roles an answer gives and which channels it
//     reveals, before they answer, not after;
//   - a required question is asked plainly and may not be left;
//   - the member may come back and change their mind, and their own answers
//     are the only ones they may change.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { request } from '../../packages/api.js';
import { head, card, blank, fault, fold, hold, memo } from '../ui/page.js';
import { errorToast, toast, confirmDialog } from '../ui/overlays.js';

const readPreview = (serverId) => request('GET', '/api/servers/' + serverId + '/onboarding/preview');
const readMine = (serverId) => request('GET', '/api/servers/' + serverId + '/onboarding/me');
const sendAnswers = (serverId, body) => request('POST', '/api/servers/' + serverId + '/onboarding/answers', { body });

// One question, with its options.
function questionBlock(question, choices, onChange) {
  const box = el('div', { class: 'settings-item' });
  const controls = [];

  for (const option of question.options) {
    const input = el('input', {
      type: question.kind === 'multiple' ? 'checkbox' : 'radio',
      name: 'onboarding-' + question.id,
      value: option.id,
      'aria-label': option.label,
    });
    input.checked = !!choices[option.id];
    input.addEventListener('change', () => onChange(question, option, input.checked));
    controls.push({ option, input });
    box.appendChild(el('label', { class: 'checkbox' },
      input,
      el('span', {},
        el('span', { class: 'settings-item-label' }, option.label),
        option.grantsRoles
          ? el('p', { class: 'form-note' },
            'Answering this gives you ' + option.grantsRoles
            + (option.grantsRoles === 1 ? ' role.' : ' roles.'))
          : null,
        option.revealsChannels
          ? el('p', { class: 'form-note' },
            'Answering this shows you ' + option.revealsChannels
            + (option.revealsChannels === 1 ? ' channel.' : ' channels.'))
          : null)));
  }

  return {
    node: card({
      label: question.text,
      glyph: 'help',
      note: question.required ? 'You have to answer this one' : 'You may skip this one',
      body: el('div', { class: 'fold' },
        question.answered
          ? el('p', { class: 'form-note' }, 'You have answered this one.')
          : null,
        box),
    }),
    controls,
  };
}

export function onboardingView(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'fold' });

  let preview = null;
  let mine = null;
  const choices = {};

  const load = async () => {
    host.replaceChildren(hold('Reading the welcome'));
    try {
      const [answer, own] = await Promise.all([
        readPreview(serverId),
        readMine(serverId).catch(() => null),
      ]);
      preview = (answer && answer.onboarding) || {};
      mine = own || null;
      // The member's own answers are the starting point, so a member who
      // comes back sees what they chose.
      for (const entry of (mine && mine.answers) || []) {
        for (const optionId of entry.optionIds || []) choices[entry.questionId + ':' + optionId] = true;
      }
      paint();
    } catch (error) {
      host.replaceChildren(fold([fault(error, load)]));
    }
  };

  const paint = () => {
    if (!preview) return;

    if (!preview.enabled) {
      host.replaceChildren(card({
        label: 'There is no welcome here',
        glyph: 'home',
        body: el('p', { class: 'lede' },
          'This community has not set one up, so there is nothing to see. '
          + 'Carry on as you are.'),
      }));
      return;
    }

    const answered = new Set((preview.questions || [])
      .filter((question) => question.answered)
      .map((question) => question.id));

    const blocks = (preview.questions || []).map((question) => {
      const picked = {};
      for (const option of question.options) {
        if (choices[question.id + ':' + option.id]) picked[option.id] = true;
      }
      return questionBlock(question, picked, (theQuestion, option, on) => {
        if (theQuestion.kind === 'multiple') {
          choices[theQuestion.id + ':' + option.id] = on;
        } else {
          // One answer: the others go.
          for (const key of Object.keys(choices)) {
            if (key.indexOf(theQuestion.id + ':') === 0) delete choices[key];
          }
          if (on) choices[theQuestion.id + ':' + option.id] = true;
        }
        paint();
      });
    });

    const outstanding = (preview.questions || [])
      .filter((question) => question.required && !answered.has(question.id));

    const send = el('button', {
      class: 'btn btn--primary btn--sm', type: 'button',
      onClick: async () => {
        send.disabled = true;
        try {
          const answers = (preview.questions || []).map((question) => ({
            questionId: question.id,
            optionIds: Object.keys(choices)
              .filter((key) => key.indexOf(question.id + ':') === 0)
              .map((key) => key.slice(question.id.length + 1)),
          })).filter((entry) => entry.optionIds.length);
          const out = await sendAnswers(serverId, { answers });
          const given = (out && out.rolesGranted) || [];
          toast(given.length
            ? 'Thank you. ' + (given.length === 1 ? 'A role has been' : 'Roles have been') + ' given to you.'
            : 'Thank you.');
          await load();
        } catch (error) {
          errorToast(error);
        } finally {
          send.disabled = false;
        }
      },
    }, 'Save my answers');

    host.replaceChildren(el('div', { class: 'fold' },
      preview.welcomeTitle || preview.welcomeBody
        ? card({
          label: preview.welcomeTitle || 'Welcome',
          glyph: 'home',
          body: el('p', { class: 'lede' }, preview.welcomeBody || ''),
        })
        : null,
      (preview.rules || []).length
        ? card({
          label: 'The rules of this community',
          glyph: 'book',
          body: el('ul', { class: 'rowlist' },
            ...preview.rules.map((rule) => el('li', { class: 'settings-item' },
              el('span', { class: 'settings-item-main' },
                el('p', { class: 'settings-item-label' }, rule.text))))),
        })
        : null,
      ...blocks.map((block) => block.node),
      outstanding.length
        ? memo({
          tone: 'warning',
          title: 'There is still something to answer',
          text: outstanding.length + (outstanding.length === 1
            ? ' question has to be answered before you carry on.'
            : ' questions have to be answered before you carry on.'),
        })
        : null,
      el('div', { class: 'actionline' }, send)));
  };

  load();

  return {
    node: fold([
      head({
        kicker: 'Welcome',
        title: 'This community',
        lede: 'A few things about it, and a question or two.',
      }),
      host,
    ]),
    onMount: load,
  };
}

export default { onboardingView };

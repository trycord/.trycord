// The onboarding a member is shown, on the phone.
//
// The same thing the desk shows: the welcome, the rules, and the questions -
// with what answering a question does said in words, because the member is
// choosing.
//
// A member may come back and change their mind, and their own answers are
// the only ones they may change.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { request } from '../../../packages/api.js';
import { empty, loading, failure } from '../components.js';
import { screen, section, field, actions, primaryButton, notice } from './util.js';
import { toast } from '../ui.js';

const readPreview = (serverId) => request('GET', '/api/servers/' + serverId + '/onboarding/preview');
const readMine = (serverId) => request('GET', '/api/servers/' + serverId + '/onboarding/me');
const sendAnswers = (serverId, body) => request('POST', '/api/servers/' + serverId + '/onboarding/answers', { body });

export function onboardingScreen(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'm-stack' });

  let preview = null;
  const choices = {};

  async function load() {
    host.replaceChildren(loading('Reading the welcome'));
    try {
      const [answer, own] = await Promise.all([
        readPreview(serverId),
        readMine(serverId).catch(() => null),
      ]);
      preview = (answer && answer.onboarding) || {};
      for (const entry of (own && own.answers) || []) {
        for (const optionId of entry.optionIds || []) {
          choices[entry.questionId + ':' + optionId] = true;
        }
      }
      paint();
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }

  function paint() {
    clear(host);
    if (!preview) return;

    if (!preview.enabled) {
      host.appendChild(empty({
        icon: 'home',
        title: 'There is no welcome here',
        text: 'This community has not set one up, so there is nothing to see. Carry on as you are.',
      }));
      return;
    }

    if (preview.welcomeTitle || preview.welcomeBody) {
      host.appendChild(section('Welcome', el('div', { class: 'm-stack' },
        preview.welcomeTitle
          ? el('p', { class: 'm-lede' }, preview.welcomeTitle)
          : null,
        preview.welcomeBody
          ? el('p', { class: 'm-lede' }, preview.welcomeBody)
          : null)));
    }

    if ((preview.rules || []).length) {
      host.appendChild(section('The rules of this community', el('div', { class: 'm-list' },
        ...preview.rules.map((rule) => el('div', { class: 'm-row' },
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, rule.text)))))));
    }

    for (const question of preview.questions || []) {
      const rows = el('div', { class: 'm-list' });
      for (const option of question.options) {
        const input = el('input', {
          type: question.kind === 'multiple' ? 'checkbox' : 'radio',
          class: 'm-check',
          name: 'onboarding-' + question.id,
          value: option.id,
          'aria-label': option.label,
        });
        input.checked = !!choices[question.id + ':' + option.id];
        input.addEventListener('change', () => {
          if (question.kind === 'multiple') {
            choices[question.id + ':' + option.id] = input.checked;
          } else {
            for (const key of Object.keys(choices)) {
              if (key.indexOf(question.id + ':') === 0) delete choices[key];
            }
            if (input.checked) choices[question.id + ':' + option.id] = true;
          }
          paint();
        });
        rows.appendChild(el('label', { class: 'm-check-row' },
          input,
          el('span', {},
            el('span', { class: 'm-row__title' }, option.label),
            option.grantsRoles
              ? el('span', { class: 'm-row__sub' },
                'Gives you ' + option.grantsRoles
                + (option.grantsRoles === 1 ? ' role.' : ' roles.'))
              : null,
            option.revealsChannels
              ? el('span', { class: 'm-row__sub' },
                'Shows you ' + option.revealsChannels
                + (option.revealsChannels === 1 ? ' channel.' : ' channels.'))
              : null)));
      }
      host.appendChild(section(question.text, el('div', { class: 'm-stack' },
        question.answered
          ? notice({ tone: 'info', title: 'You have answered this one.' })
          : null,
        question.required
          ? el('p', { class: 'm-lede' }, 'You have to answer this one.')
          : el('p', { class: 'm-lede' }, 'You may skip this one.'),
        rows)));
    }

    const outstanding = (preview.questions || []).filter(
      (question) => question.required && !question.answered,
    );
    if (outstanding.length) {
      host.appendChild(notice({
        tone: 'warning',
        title: 'There is still something to answer',
        text: outstanding.length + (outstanding.length === 1
          ? ' question has to be answered before you carry on.'
          : ' questions have to be answered before you carry on.'),
      }));
    }

    const save = primaryButton('Save my answers', async () => {
      save.disabled = true;
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
        toast((error && error.message) || 'The answers could not be saved');
      } finally {
        save.disabled = false;
      }
    }, { block: true });
    host.appendChild(actions(save));
  }

  load();
  return screen(host);
}

export default { onboardingScreen };

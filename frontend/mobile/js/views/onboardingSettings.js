// Community onboarding, on the phone.
//
// The administrator's side: the welcome, the rules, the channels a new member
// is pointed at, and the questions.
//
// The picker offers only the roles an answer may actually give, so an option
// that would be refused is never offered - and the screen says what
// answering a question does, because the person writing the question is the
// one who should know.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { request } from '../../../packages/api.js';
import { empty, loading, failure } from '../components.js';
import { screen, section, field, actions, primaryButton, ghostButton, notice } from './util.js';
import { toast } from '../ui.js';

const readOnboarding = (serverId) => request('GET', '/api/servers/' + serverId + '/onboarding');
const writeOnboarding = (serverId, body) => request('PUT', '/api/servers/' + serverId + '/onboarding', { body });

function textInput(options) {
  const opts = options || {};
  return el('input', {
    class: 'm-input', type: opts.type || 'text',
    value: opts.value === undefined || opts.value === null ? '' : String(opts.value),
    placeholder: opts.placeholder || null,
    maxlength: opts.maxlength || 500,
    'aria-label': opts.label || null,
  });
}

function textArea(options) {
  const opts = options || {};
  return el('textarea', {
    class: 'm-input', rows: opts.rows || 3,
    value: opts.value === undefined || opts.value === null ? '' : String(opts.value),
    placeholder: opts.placeholder || null,
    maxlength: opts.maxlength || 2000,
    'aria-label': opts.label || null,
  });
}

function checkbox(label, checked) {
  const box = el('input', { type: 'checkbox', class: 'm-check', 'aria-label': label });
  box.checked = !!checked;
  return box;
}

export function onboardingSection(serverId) {
  const host = el('div', { class: 'm-stack' });

  let config = null;
  let eligible = [];

  async function load() {
    host.replaceChildren(loading('Reading the onboarding'));
    try {
      const answer = await readOnboarding(serverId);
      config = (answer && answer.onboarding) || {};
      eligible = (answer && answer.eligibleRoles) || [];
      paint();
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }

  function paint() {
    clear(host);
    if (!config) return;

    const welcomeTitle = textInput({
      value: config.welcomeTitle || '', label: 'The welcome title', maxlength: 200,
    });
    const welcomeBody = textArea({
      value: config.welcomeBody || '', label: 'The welcome', rows: 4, maxlength: 4000,
    });
    const enabled = checkbox('Show the onboarding to new members', config.enabled);
    const required = checkbox('The required questions must be answered', config.required);
    const rules = textArea({
      value: (config.rules || []).map((rule) => rule.text).join('\n'),
      label: 'The rules, one per line',
      rows: Math.max(3, (config.rules || []).length + 1),
      maxlength: 8000,
    });

    const questionList = el('div', { class: 'm-list' });
    for (const [index, question] of (config.questions || []).entries()) {
      const options = el('div', { class: 'm-list' });
      for (const option of question.options || []) {
        const roleNames = (option.roleIds || []).map((id) => {
          const role = eligible.find((entry) => entry.id === id);
          return role ? role.name : id;
        });
        options.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, option.label),
            roleNames.length
              ? el('span', { class: 'm-row__sub' }, 'Gives: ' + roleNames.join(', '))
              : null)));
      }
      questionList.appendChild(el('div', { class: 'm-row' },
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, (index + 1) + '. ' + question.text),
          el('span', { class: 'm-row__sub' },
            (question.required ? 'They have to answer it.' : 'They may skip it.')
            + ' · ' + (question.options || []).length + ' option'
            + ((question.options || []).length === 1 ? '' : 's'))),
        options));
    }
    if (!(config.questions || []).length) {
      questionList.appendChild(el('p', { class: 'm-lede' },
        'No questions yet. A question may give a role and may reveal a channel, '
        + 'and only the roles that may be given are offered.'));
    }

    const save = primaryButton('Save the onboarding', async () => {
      save.disabled = true;
      try {
        await writeOnboarding(serverId, {
          enabled: enabled.checked,
          required: required.checked,
          welcomeTitle: welcomeTitle.value.trim(),
          welcomeBody: welcomeBody.value,
          rules: rules.value.split('\n').map((line) => line.trim()).filter(Boolean)
            .map((text) => ({ text })),
          defaultChannels: config.defaultChannels || [],
          questions: (config.questions || []).map((question) => ({
            id: question.id,
            text: question.text,
            kind: question.kind,
            required: question.required,
            options: question.options || [],
          })),
        });
        toast('The onboarding is saved');
        await load();
      } catch (error) {
        toast((error && error.message) || 'The onboarding could not be saved');
      } finally {
        save.disabled = false;
      }
    }, { block: true });

    host.appendChild(section('The welcome', el('div', { class: 'm-stack' },
      field({ label: 'Show it to new members', control: enabled }),
      field({ label: 'The title', control: welcomeTitle }),
      field({ label: 'What it says', control: welcomeBody }),
      field({ label: 'The rules, one per line', control: rules }))));
    host.appendChild(section('The questions', el('div', { class: 'm-stack' },
      questionList,
      eligible.length
        ? el('p', { class: 'm-lede' },
          'These are the roles an answer may give: '
          + eligible.map((role) => role.name).join(', ') + '.')
        : el('p', { class: 'm-lede' },
          'This community has no role an answer may give. A question may still reveal a channel.'))));
    host.appendChild(actions(save));
  }

  load();
  return { node: host, load };
}

export default { onboardingSection };

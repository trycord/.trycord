// Community onboarding, on the desk.
//
// The administrator's side: the welcome, the rules, the channels a new member
// is pointed at, and the questions.
//
// The two rules the screen keeps:
//
//   - the picker offers only the roles an answer may actually give, so an
//     option that would be refused is never offered;
//   - the questions carry what an answer does, and the screen says so in
//     words - the reader of the screen is the one who writes the question, and
//     they should know what answering it will do.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { request } from '../../../packages/api.js';
import { head, card, row, blank, fault, fold, hold, memo } from '../../ui/page.js';
import { errorToast, toast, confirmDialog } from '../../ui/overlays.js';

const ONBOARDING = '/api/servers/';

const readOnboarding = (serverId) => request('GET', ONBOARDING + serverId + '/onboarding');
const writeOnboarding = (serverId, body) => request('PUT', ONBOARDING + serverId + '/onboarding', { body });

function field(label, control, note) {
  return el('label', { class: 'field' },
    el('span', { class: 'field-label' }, label),
    control,
    note ? el('p', { class: 'form-note' }, note) : null);
}

function textInput(options) {
  const opts = options || {};
  return el('input', {
    class: 'input', type: opts.type || 'text',
    value: opts.value === undefined || opts.value === null ? '' : String(opts.value),
    placeholder: opts.placeholder || null,
    maxlength: opts.maxlength || 500,
    'aria-label': opts.label || null,
  });
}

function textArea(options) {
  const opts = options || {};
  return el('textarea', {
    class: 'input', rows: opts.rows || 3,
    value: opts.value === undefined || opts.value === null ? '' : String(opts.value),
    placeholder: opts.placeholder || null,
    maxlength: opts.maxlength || 2000,
    'aria-label': opts.label || null,
  });
}

function checkbox(label, checked) {
  const box = el('input', { type: 'checkbox', 'aria-label': label });
  box.checked = !!checked;
  return box;
}

// The section.
export function onboardingSection(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'fold' });

  // What the administrator has written, and the roles an answer may give.
  let config = null;
  let eligible = [];

  const load = async () => {
    host.replaceChildren(hold('Reading the onboarding'));
    try {
      const answer = await readOnboarding(serverId);
      config = (answer && answer.onboarding) || {};
      eligible = (answer && answer.eligibleRoles) || [];
      paint();
    } catch (error) {
      host.replaceChildren(fold([fault(error, load)]));
    }
  };

  const paint = () => {
    if (!config) return;
    const welcomeTitle = textInput({
      value: config.welcomeTitle || '', label: 'The welcome title', maxlength: 200,
    });
    const welcomeBody = textArea({
      value: config.welcomeBody || '', label: 'The welcome', rows: 4, maxlength: 4000,
    });
    const enabled = checkbox('Show the onboarding to new members', config.enabled);
    const required = checkbox('The required questions must be answered', config.required);

    // The rules, one line each.
    const ruleLines = (config.rules || []).map((rule) => rule.text);
    const rules = textArea({
      value: ruleLines.join('\n'),
      label: 'The rules, one per line',
      rows: Math.max(3, ruleLines.length + 1),
      maxlength: 8000,
    });

    const questionBody = el('div', { class: 'fold fold--tight' });

    const paintQuestions = () => {
      const rows = (config.questions || []).map((question, index) => {
        const options = (question.options || []).map((option) => {
          const roles = (option.roleIds || []).map((id) => {
            const role = eligible.find((entry) => entry.id === id);
            return role ? role.name : id;
          });
          return el('div', { class: 'settings-item' },
            el('div', { class: 'settings-item-main' },
              el('p', { class: 'settings-item-label' }, option.label),
              roles.length
                ? el('p', { class: 'settings-note' }, 'Gives: ' + roles.join(', '))
                : null,
              (option.channelIds || []).length
                ? el('p', { class: 'settings-note' },
                  'Reveals ' + option.channelIds.length + ' channel'
                  + (option.channelIds.length === 1 ? '' : 's'))
                : null),
            el('div', { class: 'settings-item-control' },
              el('span', { class: 'chip chip--quiet' },
                question.kind === 'multiple' ? 'several answers' : 'one answer')));
        });
        return el('div', { class: 'settings-item' },
          el('div', { class: 'settings-item-main' },
            el('p', { class: 'settings-item-label' },
              (index + 1) + '. ' + question.text),
            el('p', { class: 'settings-note' },
              question.required ? 'They have to answer it.' : 'They may skip it.'),
            el('div', { class: 'settings-item-control' },
              el('span', { class: 'chip chip--quiet' },
                (question.options || []).length + ' option'
                + ((question.options || []).length === 1 ? '' : 's')))),
          el('div', { class: 'fold fold--tight' }, options));
      });
      questionBody.replaceChildren(...(rows.length
        ? rows
        : [el('p', { class: 'form-note' },
          'No questions yet. A question may give a role and may reveal a '
          + 'channel, and only the roles that may be given are offered.')]));
    };
    paintQuestions();

    const save = el('button', {
      class: 'btn btn--primary btn--sm', type: 'button',
      onClick: async () => {
        save.disabled = true;
        try {
          const next = {
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
          };
          await writeOnboarding(serverId, next);
          toast('The onboarding is saved');
          await load();
        } catch (error) {
          errorToast(error);
        } finally {
          save.disabled = false;
        }
      },
    }, 'Save the onboarding');

    host.replaceChildren(el('div', { class: 'fold' },
      card({
        label: 'The welcome',
        glyph: 'home',
        body: el('div', { class: 'fold' },
          field('Show it to new members', enabled),
          field('The title', welcomeTitle),
          field('What it says', welcomeBody,
            'A sentence or two about what this community is for.'),
          field('The rules, one per line', rules,
            'The member is shown these and asked to accept them.'),
          field('The required questions must be answered', required,
            'With it on, a member who has not answered may not carry on.')),
      }),
      card({
        label: 'The questions',
        glyph: 'help',
        body: el('div', { class: 'fold' },
          questionBody,
          eligible.length
            ? el('p', { class: 'form-note' },
              'These are the roles an answer may give: ' + eligible.map((role) => role.name).join(', ')
              + '. A role that administers the community is not among them.')
            : el('p', { class: 'form-note' },
              'This community has no role an answer may give. A question may still reveal a channel.')),
      }),
      el('div', { class: 'actionline' }, save)));
  };

  load();

  return {
    node: fold([
      head({
        kicker: 'Community',
        title: 'Onboarding',
        lede: 'What a member is shown when they arrive, and what answering your questions does.',
      }),
      host,
    ]),
    onMount: load,
  };
}

export default { onboardingSection };

// The rules of a community, on a phone.
//
// The same two rules the desktop console offers: slow mode on a channel, and
// the words that may not be used. Both are refused by the server rather than
// by this page, so this page reports what the server is enforcing and says
// what a refusal will look like before anybody is refused.

import { el, replaceChildren } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import { empty, loading, failure } from '../components.js';
import { toast } from '../ui.js';
import { can, isOwner } from '../../../packages/store.js';

// The gaps a community actually uses.
//
// None, a short breath, a minute, five minutes, fifteen, and half an hour.
// Past half an hour it is not a slow mode any more, it is a channel nobody
// can talk in.
const SLOW_MODES = [
  { seconds: 0, label: 'Off' },
  { seconds: 5, label: '5 seconds' },
  { seconds: 10, label: '10 seconds' },
  { seconds: 30, label: '30 seconds' },
  { seconds: 60, label: '1 minute' },
  { seconds: 300, label: '5 minutes' },
  { seconds: 900, label: '15 minutes' },
  { seconds: 1800, label: '30 minutes' },
];

// A line that says what happened.
function reporter() {
  const node = el('div', { class: 'm-notice m-notice--info', role: 'status' },
    el('span', { class: 'm-notice__icon' }, icon('info', { size: 18 })),
    el('div', { class: 'm-notice__main' },
      el('div', { class: 'm-notice__text' }, '')));
  const say = (text) => {
    node.querySelector('.m-notice__text').textContent = text;
    return node;
  };
  const fail = (error) => {
    node.querySelector('.m-notice__text').textContent =
      (error && error.message) ? error.message : 'The server did not answer.';
    node.classList.remove('m-notice--info');
    node.classList.add('m-notice--warn');
    return node;
  };
  return { node, say, fail };
}

// The rules of a community.
export function rulesSection(serverId) {
  const host = el('div', { class: 'm-stack' });
  const status = reporter();

  const maySetSlow = () => can(serverId, 'MANAGE_CHANNELS') || isOwner(serverId);
  const maySetWords = () => can(serverId, 'MANAGE_SERVER') || isOwner(serverId);

  const load = async () => {
    replaceChildren(host, loading('Reading the rules of this community'));
    let channels = [];
    let terms = [];
    try {
      const [channelPage, termPage] = await Promise.all([
        Api.channels(serverId),
        Api.blockedTerms(serverId),
      ]);
      channels = (channelPage && channelPage.channels) || [];
      terms = (termPage && termPage.terms) || [];
    } catch (error) {
      replaceChildren(host, failure(error, load));
      return;
    }

    // -- slow mode ------------------------------------------------------------
    const slowRows = el('div', { class: 'm-list' });
    if (!channels.length) {
      slowRows.appendChild(empty({
        icon: 'hash', title: 'No channels yet',
        text: 'Slow mode is set on a channel. Make one first.',
      }));
    }
    for (const channel of channels) {
      const seconds = Number(channel.slow_mode) || 0;
      const row = el('div', { class: 'm-row' },
        el('span', { class: 'm-row__lead' }, icon('hash', { size: 17 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title truncate' }, channel.name),
          el('span', { class: 'm-row__sub' },
            seconds ? 'One message every ' + seconds + ' seconds' : 'No slow mode')));
      if (maySetSlow()) {
        const picker = el('select', {
          class: 'm-input m-input--compact m-input--select',
          'aria-label': 'How slow ' + channel.name + ' is',
        }, ...SLOW_MODES.map((option) => el('option', {
          value: String(option.seconds),
          selected: option.seconds === seconds ? 'selected' : null,
        }, option.label)));
        picker.addEventListener('change', async () => {
          const next = Number(picker.value);
          try {
            await Api.updateChannel(serverId, channel.id, { slowMode: next });
            status.say(next
              ? 'The server answered: ' + channel.name + ' now asks for a gap of ' + next + ' seconds.'
              : 'The server answered: ' + channel.name + ' has no slow mode any more.');
            await load();
          } catch (error) {
            status.fail(error);
            await load();
          }
        });
        row.appendChild(el('span', { class: 'm-row__actions' }, picker));
      }
      slowRows.appendChild(row);
    }

    // -- the words ------------------------------------------------------------
    const wordRows = el('div', { class: 'm-list' });
    if (!maySetWords()) {
      wordRows.appendChild(empty({
        icon: 'shield', title: 'You cannot change the list of words',
        text: 'Deciding what may be said here takes a permission this account does not hold.',
      }));
    } else if (!terms.length) {
      wordRows.appendChild(empty({
        icon: 'shield', title: 'No words are refused',
        text: 'A word added here is refused by the server, and only in this community.',
      }));
    }
    for (const term of terms) {
      wordRows.appendChild(el('div', { class: 'm-row' },
        el('span', { class: 'm-row__lead' }, icon('shield', { size: 17 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title truncate' }, term),
          el('span', { class: 'm-row__sub' }, 'Refused in this community, and nowhere else')),
        el('span', { class: 'm-row__actions' },
          el('button', {
            class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
            'aria-label': 'Allow the word ' + term + ' again',
            onClick: async () => {
              try {
                await Api.removeBlockedTerm(serverId, term);
                status.say('The server answered: ' + term + ' may be used again.');
                await load();
              } catch (error) { status.fail(error); }
            },
          }, 'Allow'))));
    }

    // The form that adds a word.
    const form = el('div', { class: 'm-stack' });
    if (maySetWords()) {
      const input = el('input', {
        class: 'm-input', type: 'text', maxlength: '128',
        'aria-label': 'The word to refuse',
        placeholder: 'A word to refuse',
      });
      const add = el('button', { class: 'm-btn m-btn--primary', type: 'button' }, 'Refuse it');
      const run = async () => {
        const word = input.value.trim();
        if (!word) { input.focus(); return; }
        try {
          await Api.addBlockedTerm(serverId, word);
          input.value = '';
          status.say('The server answered: ' + word.toLowerCase() + ' is refused in this community.');
          await load();
        } catch (error) {
          status.fail(error);
          toast((error && error.message) || 'The server did not answer.');
        }
      };
      add.addEventListener('click', run);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); run(); }
      });
      form.appendChild(el('div', { class: 'm-field' },
        el('span', { class: 'm-field__label' }, 'A word to refuse'), input));
      form.appendChild(add);
    }

    replaceChildren(host,
      status.node,
      el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' },
          el('div', { class: 'm-section__title' }, 'Slow mode')),
        el('p', { class: 'm-lede' },
          'The server refuses the message that comes too soon and says how long to wait. '
          + 'People who can manage messages here are not held by it.'),
        slowRows),
      el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' },
          el('div', { class: 'm-section__title' }, 'The words that may not be used')),
        el('p', { class: 'm-lede' },
          'A word is refused as a whole word, and the refusal names the word.'),
        wordRows,
        form),
    );
  };

  return { node: host, load };
}

export default { rulesSection };

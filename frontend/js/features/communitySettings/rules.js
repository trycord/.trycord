// The rules of a community.
//
// Two of them, and both are the community's own:
//
//   - slow mode, which is set on a channel and asks people to take their
//     time;
//   - the words that may not be used.
//
// Both are refused by the server rather than by this page, because a rule
// the client applies is a rule a reader can turn off. So this page does not
// make the rules - it reports the ones the server is enforcing, and it says
// what a refusal will look like before anybody is refused.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import { head, card, row, blank, fault, fold, hold } from '../../ui/page.js';
import { can, isOwner } from '../../../packages/store.js';
import { reporter } from './parts.js';

// How long a channel may be slowed for.
//
// The gaps are the ones a community actually uses: none, a short breath, a
// minute, five minutes, fifteen, and half an hour. Past half an hour it is
// not a slow mode any more, it is a channel nobody can talk in.
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

// The slowest a channel may be, in seconds.
const SLOWEST = 3600;

export function rulesSection(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'fold' });

  // The channels and the words, as the server has them.
  let channels = [];
  let terms = [];

  const report = reporter();

  const load = async () => {
    host.replaceChildren(hold('Reading the rules of this community'));
    try {
      const [channelPage, termPage] = await Promise.all([
        Api.channels(serverId),
        Api.blockedTerms(serverId),
      ]);
      channels = (channelPage && channelPage.channels) || [];
      terms = (termPage && termPage.terms) || [];
      paint();
    } catch (error) {
      host.replaceChildren(fold([fault(error, load)]));
    }
  };

  // The permissions the server enforces. The controls are not offered to
  // somebody who cannot use them: an action that is always refused is worse
  // than no action.
  const maySetSlow = () => can(serverId, 'MANAGE_CHANNELS') || isOwner(serverId);
  const maySetWords = () => can(serverId, 'MANAGE_SERVER') || isOwner(serverId);

  const paint = () => {
    const slowBody = el('div', { class: 'rowlist' });
    const wordBody = el('div', { class: 'rowlist' });

    // -- slow mode ------------------------------------------------------------
    if (!channels.length) {
      slowBody.replaceChildren(blank({
        glyph: 'hash',
        title: 'No channels yet',
        text: 'Slow mode is set on a channel. Make one first.',
      }));
    } else {
      slowBody.replaceChildren(...channels.map((channel) => slowRow(channel)));
    }

    // -- the words ------------------------------------------------------------
    if (!maySetWords()) {
      wordBody.replaceChildren(blank({
        glyph: 'shield',
        title: 'You cannot change the list of words',
        text: 'Deciding what may be said here takes a permission this account does not hold.',
      }));
    } else if (!terms.length) {
      wordBody.replaceChildren(blank({
        glyph: 'shield',
        title: 'No words are refused',
        text: 'A word added here is refused by the server, and only in this community.',
      }));
    } else {
      wordBody.replaceChildren(...terms.map((term) => wordRow(term)));
    }

    host.replaceChildren(fold([
      report.node,
      card({
        label: 'Slow mode', glyph: 'clock',
        body: fold([
          el('p', { class: 'lede' },
            'Slow mode asks people to leave a gap between their messages. '
            + 'The server refuses the message that comes too soon and says how long to wait. '
            + 'People who can manage messages here are not held by it.'),
          slowBody,
        ]),
      }),
      card({
        label: 'The words that may not be used', glyph: 'shield',
        body: fold([
          el('p', { class: 'lede' },
            'A word is refused as a whole word: a community that refuses a word '
            + 'does not refuse every word that happens to contain it. '
            + 'The refusal names the word, so the person who said it knows what to change.'),
          wordBody,
          maySetWords() ? wordForm() : null,
        ]),
      }),
    ]));
  };

  // A channel and how slow it is.
  const slowRow = (channel) => {
    const seconds = Number(channel.slow_mode) || 0;
    const control = el('select', {
      class: 'input input--sm',
      'aria-label': 'How slow ' + channel.name + ' is',
    }, ...SLOW_MODES.map((option) => el('option', {
      value: String(option.seconds),
      selected: option.seconds === seconds ? 'selected' : null,
    }, option.label)));

    if (!maySetSlow()) {
      return row({
        lead: el('span', { class: 'role-dot' }, icon('hash', { size: 15 })),
        title: channel.name,
        sub: seconds ? 'One message every ' + seconds + ' seconds' : 'No slow mode',
      });
    }

    control.addEventListener('change', async () => {
      const next = Number(control.value);
      try {
        await Api.updateChannel(serverId, channel.id, { slowMode: next });
        report.answered(next
          ? 'The server answered: ' + channel.name + ' now asks for a gap of ' + next + ' seconds.'
          : 'The server answered: ' + channel.name + ' has no slow mode any more.');
        await load();
      } catch (error) {
        report.fail(error);
        await load();
      }
    });

    return row({
      lead: el('span', { class: 'role-dot' }, icon('hash', { size: 15 })),
      title: channel.name,
      sub: seconds ? 'One message every ' + seconds + ' seconds' : 'No slow mode',
      side: control,
    });
  };

  // A word that is refused, and the button that takes it off the list.
  const wordRow = (term) => row({
    lead: el('span', { class: 'role-dot' }, icon('shield', { size: 15 })),
    title: term,
    sub: 'Refused in this community, and nowhere else',
    side: el('button', {
      class: 'btn btn--ghost btn--sm', type: 'button',
      'aria-label': 'Allow the word ' + term + ' again',
      onClick: async () => {
        try {
          await Api.removeBlockedTerm(serverId, term);
          report.answered('The server answered: ' + term + ' may be used again.');
          await load();
        } catch (error) {
          report.fail(error);
        }
      },
    }, 'Allow'),
  });

  // The form that adds a word.
  const wordForm = () => {
    const input = el('input', {
      class: 'input', type: 'text',
      'aria-label': 'The word to refuse',
      placeholder: 'A word to refuse',
      maxlength: '128',
    });
    const add = el('button', { class: 'btn btn--default btn--sm', type: 'button' }, 'Refuse it');
    const run = async () => {
      const word = input.value.trim();
      if (!word) { input.focus(); return; }
      try {
        await Api.addBlockedTerm(serverId, word);
        report.answered('The server answered: ' + word.toLowerCase() + ' is refused in this community.');
        input.value = '';
        await load();
      } catch (error) {
        report.fail(error);
      }
    };
    add.addEventListener('click', run);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); run(); }
    });
    return el('div', { class: 'fold fold--tight' },
      input,
      el('div', { class: 'rowtools' }, add));
  };

  return {
    node: fold([
      head({
        kicker: 'Community',
        title: 'Rules',
        lede: 'What this community asks of the people in it.',
        actions: null,
      }),
      host,
    ]),
    onMount: load,
  };
}

export default { rulesSection, SLOW_MODES, SLOWEST };

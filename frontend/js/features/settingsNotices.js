// Settings: notifications.
// What reaches you, and when it stays quiet: do-not-disturb, the quiet hours,
// and the channels the reader has muted from their column.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { State, refreshMutes, serverById } from '../../packages/store.js';
import { switchControl, setSwitch, fieldRow } from '../ui/primitives.js';
import { head, card, row, blank, fault, fold } from '../ui/page.js';
import { errorToast } from '../ui/overlays.js';

function channelLabel(channelId) {
  for (const [serverId, tree] of State.serverTree) {
    const channel = (tree.channels || []).find((c) => c.id === channelId);
    if (channel) {
      const server = serverById(serverId);
      return (server ? server.name + ' · ' : '') + '#' + channel.name;
    }
  }
  return 'A channel';
}

export function notificationsView() {
  const status = el('p', { class: 'form-error', role: 'status' });
  const mutedList = el('div', { class: 'rowlist' });

  const startSelect = el('select', { class: 'input', 'aria-label': 'When quiet hours begin' });
  const endSelect = el('select', { class: 'input', 'aria-label': 'When quiet hours end' });
  for (let h = 0; h < 24; h += 1) {
    const label = String(h).padStart(2, '0') + ':00';
    startSelect.appendChild(el('option', { value: String(h * 60) }, label));
    endSelect.appendChild(el('option', { value: String(h * 60) }, label));
  }

  const dndToggle = switchControl(false, async (on) => {
    try {
      await Api.setWellbeing({ dndEnabled: on });
      status.textContent = on ? 'Do not disturb is on.' : 'Do not disturb is off.';
    } catch (e) { errorToast(e); }
  }, 'Do not disturb');

  const paintMuted = () => {
    refreshMutes().then(() => {
      const muted = Array.from(State.mutedChannels || []);
      mutedList.replaceChildren(...(muted.length ? muted.map((channelId) => row({
        lead: el('span', { class: 'role-dot' }, icon('volume-off', { size: 15 })),
        title: channelLabel(channelId),
        side: el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'Unmute this channel',
          onClick: async () => {
            try {
              await Api.unmuteChannel(channelId);
              paintMuted();
            } catch (e) { errorToast(e); }
          },
        }, 'Unmute'),
      })) : [blank({
        glyph: 'volume-off', title: 'Nothing muted',
        text: 'Right-click a channel in the column to give it a rest.',
      })]));
    }).catch((e) => {
      mutedList.replaceChildren(fold([fault(e, null)]));
    });
  };

  return {
    node: fold([
      head({
        kicker: 'Safety',
        title: 'Notifications',
        lede: 'What reaches you, and when it stays quiet.',
      }),
      card({
        label: 'Peace', glyph: 'bell',
        rows: [
          fieldRow('Do not disturb', 'The badge goes dark; nothing arrives pinging.', dndToggle),
          fieldRow('Quiet hours begin', 'Notifications fall silent from this hour.', startSelect),
          fieldRow('Quiet hours end', '…until this hour.', endSelect),
          el('div', { class: 'cardfoot' },
            el('button', {
              class: 'btn btn--primary btn--sm', type: 'button',
              onClick: async () => {
                try {
                  await Api.setWellbeing({
                    quietHoursOn: true,
                    quietStart: Number(startSelect.value || 0),
                    quietEnd: Number(endSelect.value || 0),
                  });
                  status.textContent = 'The quiet hours are set.';
                } catch (e) { errorToast(e); }
              },
            }, 'Save quiet hours')),
        ],
        foot: status,
      }),
      card({ label: 'Muted channels', glyph: 'volume-off', body: mutedList, flush: true }),
    ]),
    onMount: async () => {
      try {
        const wellbeing = await Api.wellbeing();
        if (wellbeing) {
          setSwitch(dndToggle, !!wellbeing.dndEnabled);
          startSelect.value = String(Number(wellbeing.quietStart || 0));
          endSelect.value = String(Number(wellbeing.quietEnd || 0));
        }
      } catch (e) { errorToast(e); }
      paintMuted();
    },
    cleanup() {},
  };
}

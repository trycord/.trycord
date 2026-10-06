// notifications — part of the account settings tree.
//
// Split out of the single 1,288-line module that held all eight tabs. Each tab
// is its own page; keeping them in one file meant opening the whole settings
// surface to change the appearance picker.

import Api from '../api.js';
import State, { setMuted } from '../state.js';
import { el, clear, toast } from '../ui.js';
import { sectionCard, settingRow, setEmpty, setNote, dangerButton, setActionRow } from '../settings-ui.js';
import { navigate } from '../nav.js';

export function renderNotificationsSettings(body) {
  const ids = [...(State.mutedChannels || [])];
  const card = sectionCard();

  const alerts = dangerButton('Open alerts', () => { navigate('/notifications'); },
    { variant: 'ghost' });

  if (!ids.length) {
    // The list is empty either because nothing is muted or because the fetch that
    // would have said which failed. Only one of those is worth acting on.
    card.appendChild(setEmpty(State.mutesLoaded
      ? 'No muted channels. Mute one from its channel menu.'
      : 'Your muted channels could not be loaded.'));
    card.appendChild(setActionRow(alerts));
  } else {
    card.appendChild(settingRow({
      label: 'Muted channels',
      hint: ids.length + ' suppressed',
      control: el('span', { class: 'muted small' }, 'Mute more from a channel menu'),
    }));
    const list = sectionCard();
    list.appendChild(el('div', { class: 'set-card__label' }, 'Currently muted'));
    const servers = State.servers || [];
    for (const id of ids) {
      const server = servers.find((sv) => String(sv.id) === String(id));
      list.appendChild(settingRow({
        label: server ? (server.name || 'Community') : 'Channel ' + id,
        hint: server ? 'In ' + server.name : 'No longer in this community',
        control: dangerButton('Unmute', async () => {
          try {
            await Api.unmuteChannel(id);
            setMuted(id, false);
            toast('Channel unmuted.', 'ok');
            renderNotificationsSettings(clearAndRebuild(body));
          } catch (e) { toast(e.message || 'Could not unmute that channel.', 'error'); }
        }, { variant: 'ghost' }),
      }));
    }
    card.appendChild(list);
    card.appendChild(setActionRow(alerts));
  }
  body.appendChild(card);
  body.appendChild(setNote('Muting is per channel and syncs to every device you sign in on.'));
}

export function clearAndRebuild(body) {
  const scroll = body.scrollTop;
  clear(body);
  return Object.assign(body, { scrollTop: scroll });
}

export default { renderNotificationsSettings, clearAndRebuild };

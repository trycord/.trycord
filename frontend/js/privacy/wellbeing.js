import Api from '../api.js';
import { el, toast } from '../ui.js';
import { sectionCard, toggleRow, selectRow, setNote } from '../settings-ui.js';


const minutesToLabel = (mins) => {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const ampm = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')}${ampm}`;
};

const labelToMinutes = (label) => {
  const m = /^(\d{1,2}):(\d{2})(am|pm)$/i.exec(String(label || '').trim());
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + Number(m[2]);
};
export async function renderWellbeingSection() {
  let wellbeing;
  try {
    wellbeing = await Api.wellbeing();
  } catch (ex) {
    return setNote(ex.message || 'Could not load your wellbeing settings.');
  }

  const box = el('div');
  box.appendChild(el('div', { class: 'section-label' }, 'Do not disturb'));
  const card = sectionCard();

  const repaint = async () => {
    const next = await renderWellbeingSection();
    box.replaceWith(next);
  };

  card.appendChild(toggleRow({
    label: 'Do not disturb',
    hint: 'Nothing notifies you, anywhere. Messages are still there when you look.',
    checked: wellbeing.dndEnabled,
    onChange: async (next) => {
      try {
        applyWellbeingToDocument(await Api.setWellbeing({ dndEnabled: next }));
        toast(next ? 'Notifications are paused.' : 'Notifications will resume.', 'ok');
      } catch (ex) {
        toast(ex.message || 'Could not save that.', 'error');
        repaint();
      }
    },
  }));
  card.appendChild(toggleRow({
    label: 'Quiet hours',
    hint: 'A daily window during which nothing notifies you.',
    checked: wellbeing.quietHoursOn,
    onChange: async (next) => {
      try {
        applyWellbeingToDocument(await Api.setWellbeing({ quietHoursOn: next }));
        toast(next ? 'Quiet hours on.' : 'Quiet hours off.', 'ok');
        repaint();
      } catch (ex) {
        toast(ex.message || 'Could not save that.', 'error');
        repaint();
      }
    },
  }));

  // The two time rows only appear while quiet hours are on: a schedule that is
  // not in effect should not read as though it were.
  if (wellbeing.quietHoursOn) {
    const options = [];
    for (let mins = 0; mins < 24 * 60; mins += 30) options.push({ value: String(mins), label: minutesToLabel(mins) });
    const saveTime = (which) => async (value) => {
      try {
        applyWellbeingToDocument(await Api.setWellbeing({ [which]: Number(value) }));
        toast('Quiet hours updated.', 'ok');
      } catch (ex) {
        toast(ex.message || 'Could not save that.', 'error');
        repaint();
      }
    };
    card.appendChild(selectRow({
      label: 'From',
      hint: null,
      value: String(wellbeing.quietStart),
      options,
      onChange: saveTime('quietStart'),
    }));
    card.appendChild(selectRow({
      label: 'Until',
      hint: 'A window that ends earlier than it began wraps past midnight.',
      value: String(wellbeing.quietEnd),
      options,
      onChange: saveTime('quietEnd'),
    }));
  }
  box.appendChild(card);

  box.appendChild(el('div', { class: 'section-label' }, 'Motion'));
  const motionCard = sectionCard();
  motionCard.appendChild(toggleRow({
    label: 'Reduce motion',
    hint: 'Removes transitions and animated movement across the application.',
    checked: wellbeing.reducedMotion,
    onChange: async (next) => {
      try {
        applyWellbeingToDocument(await Api.setWellbeing({ reducedMotion: next }));
        toast(next ? 'Motion reduced.' : 'Motion restored.', 'ok');
      } catch (ex) {
        toast(ex.message || 'Could not save that.', 'error');
        repaint();
      }
    },
  }));
  box.appendChild(motionCard);
  return box;
}

export function applyWellbeingToDocument(wellbeing) {
  if (!wellbeing) return;
  document.documentElement.classList.toggle('reduce-motion', !!wellbeing.reducedMotion);
  document.documentElement.classList.toggle('is-dnd', !!wellbeing.dndEnabled);
}

export function loadWellbeing() {
  return Api.wellbeing()
    .then(applyWellbeingToDocument)
    .catch(() => { /* the OS preference still applies */ });
}

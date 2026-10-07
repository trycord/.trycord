import Api from '../api.js';
import { loadingState, errorState } from '../view-states.js';
import State from '../state.js';
import { el, clear, toast, btn } from '../ui.js';
import { sectionHead, sectionCard, settingRow, toggleRow, setNote } from '../settings-ui.js';
import { renderWellbeingSection } from './wellbeing.js';

// `preloaded` is the preferences the caller may already be holding, for the same reason
// as renderPrivacySection above.
export async function renderNotificationPrefsSection(body, preloaded) {
  body.appendChild(sectionHead('Notifications', 'What Trycord is allowed to interrupt you for.'));
  body.appendChild(loadingState('Loading your notification settings'));

  let prefs;
  let categories;
  try {
    const res = preloaded ? await preloaded : await Api.notificationPrefs();
    prefs = (res && res.global) || {};
    // A caller that already had a request can hand over a resolved null for it, so
    // this is not the "the request succeeded" case it looks like. Reading .categories
    // off it would turn a soft failure into a hard one.
    categories = (res && res.categories) || Object.keys(PREF_LABELS);
  } catch (ex) {
    clear(body);
    body.appendChild(sectionHead('Notifications', 'What you are notified about.'));
    body.appendChild(errorState(ex.message || 'Could not load your notification settings.', () => {
      renderNotificationPrefsSection(body);
    }));
    return;
  }
  clear(body);
  body.appendChild(sectionHead('Notifications', 'What Trycord is allowed to interrupt you for.'));

  const repaint = () => renderNotificationPrefsSection(body);
  const card = sectionCard();
  for (const key of categories) {
    const on = prefs[key] !== false;
    card.appendChild(toggleRow({
      label: PREF_LABELS[key] || key,
      hint: PREF_HINTS[key] || null,
      checked: on,
      onChange: async (next) => {
        try {
          await Api.setNotificationPrefs({ [key]: next });
          toast((PREF_LABELS[key] || key) + (next ? ' on' : ' off'), 'ok');
        } catch (ex) {
          toast(ex.message || 'Could not save that.', 'error');
          repaint();
        }
      },
    }));
  }
  body.appendChild(card);

  // ---- per-community overrides -----------------------------------------
  // A community row overrides the global one, and only for communities the
  // reader is actually in. The list is collapsed per community because a
  // twenty-row form is not what someone opening Notifications came for.
  const servers = State.servers || [];
  if (servers.length) {
    body.appendChild(el('div', { class: 'section-label' }, 'Per community'));
    body.appendChild(setNote('A community you set here overrides the categories above, for that community only.'));
    const per = sectionCard();
    for (const s of servers) {
      const name = s.name || 'Community';
      const open = el('button', { class: 'btn sm', type: 'button' }, 'Customise');
      const holder = el('div', { class: 'set-card__body' });
      const show = async () => {
        if (holder.childElementCount) {
          clear(holder);
          return;
        }
        open.disabled = true;
        try {
          const res = await Api.notificationPrefs(s.id);
          const scoped = res.server || {};
          for (const key of categories) {
            holder.appendChild(toggleRow({
              label: PREF_LABELS[key] || key,
              checked: scoped[key] !== false,
              onChange: async (next) => {
                try {
                  await Api.setNotificationPrefs({ [key]: next, serverId: s.id });
                } catch (ex) {
                  toast(ex.message || 'Could not save that.', 'error');
                }
              },
            }));
          }
        } catch (ex) {
          toast(ex.message || 'Could not load that community.', 'error');
        } finally {
          open.disabled = false;
        }
      };
      open.addEventListener('click', show);
      per.appendChild(settingRow({
        label: name,
        hint: 'Overriding the categories above',
        control: open,
      }));
      per.appendChild(holder);
    }
    body.appendChild(per);
  }

  // ---- wellbeing, which gates the delivery of all of it ----------------
  body.appendChild(await renderWellbeingSection());
}

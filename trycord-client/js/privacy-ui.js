// Privacy, blocking, notification preferences and wellbeing, as settings
// sections.
//
// These were one thing on the server and nothing on the client: the Privacy page
// showed who had asked and who was a friend, which is two lists rather than the
// settings that actually decide those outcomes. Each section here reads its
// state from the API rather than from local state, because a preference that is
// enforced server-side and displayed from a cached copy will disagree with
// reality exactly when it matters.
//
// The controls are settings-ui's toggleRow and selectRow, not hand-rolled inputs.
// A parallel switch implementation would be a second visual answer to the same
// question, and the stylesheet already has full switch CSS behind those two
// helpers.

import Api from './api.js';
import { loadingState, errorState } from './states.js';
import State from './state.js';
import { el, clear, toast, openModal } from './ui.js';
import {
  sectionHead, sectionCard, settingRow, toggleRow, selectRow,
  setEmpty, setNote, dangerButton, setActionRow,
} from './settings-ui.js';

// The server's vocabulary. Presence historically stored 'everyone' where the
// request gates stored 'anyone'; the server now accepts both and canonicalises
// to 'anyone' on read, so a stored value can still arrive as either and must
// render as the same sentence either way.
const SCOPE_HELP = {
  anyone: 'Anyone on this instance',
  everyone: 'Anyone on this instance',
  friends: 'People you have accepted',
  nobody: 'Nobody',
};

// An unrecognised value shows itself rather than rendering as nothing. A blank
// sentence reads as "nobody" and means the opposite.
const scopeText = (v) => SCOPE_HELP[v] || ('unrecognised value: ' + v);

const scopeOptions = ['anyone', 'friends', 'nobody'].map((v) => ({ value: v, label: SCOPE_HELP[v] }));

const PREF_LABELS = {
  dm: 'Direct messages',
  mention: 'Mentions',
  friend: 'Friend requests and activity',
  moderation: 'Moderation and enforcement',
  announcement: 'Instance announcements',
};

const PREF_HINTS = {
  dm: 'A new direct message.',
  mention: 'Someone mentions you in a channel.',
  friend: 'A friend request, or someone accepting one.',
  moderation: 'An enforcement action affecting your account.',
  announcement: 'An instance-wide announcement.',
};

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

/** A key/value line for the "effective now" summary. */
function fact(key, value) {
  const row = el('div', { class: 'kv-row' });
  row.appendChild(el('dt', { class: 'kv-key' }, key));
  row.appendChild(el('dd', { class: 'kv-val' }, value));
  return row;
}

/** A save that repaints the section from the server when it fails. */
function saveAndRefresh(save, repaint) {
  return async (value) => {
    try {
      await save(value);
    } catch (ex) {
      toast(ex.message || 'Could not save that.', 'error');
      repaint();
      return;
    }
    repaint();
  };
}

/**
 * The Privacy section.
 *
 * The three gates the server enforces, then the people already blocked. A reader
 * arriving here because someone asked them to should see the control that
 * decides whether that is allowed before the list of people who already have.
 */
export async function renderPrivacySection(body) {
  body.appendChild(sectionHead('Privacy', 'Who can reach you, and who you have stopped.'));
  body.appendChild(loadingState('Loading your privacy settings'));

  let settings;
  let blocks;
  try {
    [settings, blocks] = await Promise.all([Api.privacy(), Api.blocks()]);
  } catch (ex) {
    clear(body);
    body.appendChild(sectionHead('Privacy', 'Who can reach you.'));
    body.appendChild(errorState(ex.message || 'Could not load your privacy settings.', () => {
      renderPrivacySection(body);
    }));
    return;
  }
  clear(body);
  body.appendChild(sectionHead('Privacy', 'Who can reach you, and who you have stopped.'));

  // Repaint reads the server again rather than trusting the value we sent, so a
  // failure or a clamp shows the state that is actually stored.
  const repaint = () => renderPrivacySection(body);

  // ---- the three gates -------------------------------------------------
  const gates = sectionCard();
  gates.appendChild(selectRow({
    label: 'Friend requests',
    hint: 'Who is allowed to send you a friend request.',
    value: settings.friendRequests,
    options: scopeOptions,
    onChange: saveAndRefresh((v) => Api.setPrivacy({ friendRequests: v }), repaint),
  }));
  gates.appendChild(selectRow({
    label: 'Direct messages',
    hint: 'Who is allowed to open a conversation with you.',
    value: settings.dms,
    options: scopeOptions,
    onChange: saveAndRefresh((v) => Api.setPrivacy({ dms: v }), repaint),
  }));
  gates.appendChild(selectRow({
    label: 'Online status',
    hint: 'Who can see when you are online.',
    value: settings.presence,
    options: scopeOptions,
    onChange: saveAndRefresh((v) => Api.setPrivacy({ presence: v }), repaint),
  }));
  gates.appendChild(toggleRow({
    label: 'Profile discoverability',
    hint: 'Whether searching for your username finds you.',
    checked: settings.discoverable,
    onChange: saveAndRefresh((v) => Api.setPrivacy({ discoverable: v }), repaint),
  }));
  body.appendChild(gates);

  // ---- the summary a contextual column can also render -----------------
  // Real stored state, not a restatement of the controls above: this is what a
  // reader checks to answer "what is my exposure right now".
  const summary = sectionCard();
  summary.appendChild(el('div', { class: 'set-card__label' }, 'Effective now'));
  const list = el('dl', { class: 'kv-list' });
  list.appendChild(fact('Friend requests from', scopeText(settings.friendRequests)));
  list.appendChild(fact('Direct messages from', scopeText(settings.dms)));
  list.appendChild(fact('Online status visible to', scopeText(settings.presence)));
  list.appendChild(fact('Listed in search', settings.discoverable ? 'yes' : 'no'));
  list.appendChild(fact('People blocked', String(blocks.length)));
  summary.appendChild(list);
  body.appendChild(summary);

  // ---- the block list ---------------------------------------------------
  body.appendChild(el('div', { class: 'section-label' }, 'Blocked people'));
  if (!blocks.length) {
    body.appendChild(setEmpty('You have not blocked anyone.'));
    body.appendChild(setNote('Blocking someone stops them messaging you or sending a friend request, and ends any friendship you had.'));
  } else {
    const card = sectionCard();
    for (const b of blocks) {
      const who = b.displayName || b.username || 'Someone';
      const unblock = dangerButton('Unblock', async () => {
        unblock.disabled = true;
        try {
          await Api.unblockUser(b.id);
          toast(who + ' can reach you again.', 'ok');
        } catch (ex) {
          toast(ex.message || 'Could not unblock.', 'error');
        }
        repaint();
      }, { variant: 'ghost' });
      card.appendChild(settingRow({
        label: who,
        hint: b.username ? '@' + b.username : null,
        control: unblock,
      }));
    }
    body.appendChild(card);
  }
}

/** The block control used on a profile or a user row. */
export function blockButton(user, { onDone } = {}) {
  return dangerButton('Block', () => {
    confirmBlock(user, onDone);
  }, { variant: 'ghost' });
}

function confirmBlock(user, onDone) {
  const who = user.displayName || user.username || 'this person';
  const note = el('p', { class: 'set-note set-note--warn' },
    'They will not be able to message you or send you a friend request. Any friendship you have ends now, and they are not told why.');
  const reason = el('input', {
    class: 'input', type: 'text', maxlength: '500',
    placeholder: 'Reason (optional)', 'aria-label': 'Reason for blocking ' + who,
  });
  const cancel = el('button', { class: 'btn ghost sm', type: 'button' }, 'Cancel');
  const confirm = el('button', { class: 'btn danger sm', type: 'button' }, 'Block ' + who);
  const close = () => { if (closeModal) closeModal(); };
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    try {
      await Api.blockUser(user.id, reason.value.trim() || undefined);
      toast(who + ' can no longer reach you.', 'ok');
      close();
      if (onDone) onDone();
    } catch (ex) {
      toast(ex.message || 'Could not block.', 'error');
      confirm.disabled = false;
    }
  });
  cancel.addEventListener('click', close);

  let closeModal = null;
  const body = el('div', { class: 'stack' });
  body.appendChild(el('p', {}, 'Block ' + who + '?'));
  body.appendChild(note);
  body.appendChild(reason);
  body.appendChild(el('div', { class: 'row-line' }, confirm, cancel));
  closeModal = openModal({ title: 'Block ' + who, body });
}

/**
 * The Notifications section.
 *
 * Channel mutes already existed and keep their own list; this adds the
 * per-category preference, which decides whether a category is delivered at all
 * rather than whether one channel is quiet.
 */
export async function renderNotificationPrefsSection(body) {
  body.appendChild(sectionHead('Notifications', 'What Trycord is allowed to interrupt you for.'));
  body.appendChild(loadingState('Loading your notification settings'));

  let prefs;
  let categories;
  try {
    const res = await Api.notificationPrefs();
    prefs = res.global || {};
    categories = res.categories || Object.keys(PREF_LABELS);
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

/**
 * Wellbeing: DND, quiet hours and reduced motion.
 *
 * These gate delivery rather than describe it, so they belong next to the
 * notification preferences. Reduced motion is applied to <html> as a class the
 * stylesheet honours, which is what makes it a real setting rather than a
 * duplicate of the operating system's.
 */
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

/**
 * Apply a reader's motion preference to the document.
 *
 * A class rather than a stylesheet swap: the stylesheet already has a
 * prefers-reduced-motion block, and this adds the reader's own choice as an
 * equal signal, so someone who asks for less motion gets it whether or not their
 * operating system was configured that way.
 */
export function applyWellbeingToDocument(wellbeing) {
  if (!wellbeing) return;
  document.documentElement.classList.toggle('reduce-motion', !!wellbeing.reducedMotion);
  document.documentElement.classList.toggle('is-dnd', !!wellbeing.dndEnabled);
}

/** Load and apply the reader's motion/DND state at boot. Never blocks. */
export function loadWellbeing() {
  return Api.wellbeing()
    .then(applyWellbeingToDocument)
    .catch(() => { /* the OS preference still applies */ });
}

/**
 * Re-render a section when the server says its state changed elsewhere.
 *
 * The cache is not the same as the screen. An account-scoped websocket event
 * refreshes State so the next read is right, but a section already on screen was
 * painted from the value it fetched when it opened, and nothing repaints it - so
 * a reader who blocked someone on their phone kept seeing an empty list and a
 * "People blocked: 0" that was true when they loaded and false now.
 *
 * Only the section named by the event is repainted, and only while it is still
 * in the document. Anything else would throw away what the reader is looking at
 * in order to update something they are not.
 *
 * Returns its own teardown; the caller registers that with setCleanup so a
 * navigation does not leave a listener behind repainting a detached tree.
 */
export function watchForRemoteChanges(kind, host, repaint) {
  const onChange = (e) => {
    if (!e || e.detail !== kind) return;
    if (!host.isConnected) return;
    repaint();
  };
  document.addEventListener('trycord:state', onChange);
  return () => document.removeEventListener('trycord:state', onChange);
}

export default {
  renderPrivacySection,
  renderNotificationPrefsSection,
  renderWellbeingSection,
  applyWellbeingToDocument,
  loadWellbeing,
  blockButton,
};

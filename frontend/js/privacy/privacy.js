import Api from '../api.js';
import { loadingState, errorState } from '../view-states.js';
import { can } from '../state.js';
import { el, clear, toast, openModal, btn } from '../ui.js';
import { sectionHead, sectionCard, settingRow, toggleRow, selectRow, setEmpty, setNote, dangerButton } from '../settings-ui.js';


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

function fact(key, value) {
  const row = el('div', { class: 'kv-row' });
  row.appendChild(el('dt', { class: 'kv-key' }, key));
  row.appendChild(el('dd', { class: 'kv-val' }, value));
  return row;
}

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

// `preloaded` is the [settings, blocks] pair the caller may already be holding. The
// Privacy page shows this section and a sidebar built from the same two requests, so
// without this every visit asked twice for data that had not changed in between.
export async function renderPrivacySection(body, preloaded) {
  body.appendChild(sectionHead('Privacy', 'Who can reach you, and who you have stopped.'));
  body.appendChild(loadingState('Loading your privacy settings'));

  let settings;
  let blocks;
  try {
    [settings, blocks] = preloaded
      ? await preloaded
      : await Promise.all([Api.privacy(), Api.blocks()]);
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

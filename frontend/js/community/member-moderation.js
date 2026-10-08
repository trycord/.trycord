import Api from '../api.js';
import { enterServer } from '../state.js';
import { el, openModal, toast } from '../ui.js';

// Dialogs that act on one member: rename, ban, time out.
//
// Separate from members.js because they never needed the page. Each takes a community, a
// member and a repaint callback, and knows nothing about how members are listed - which
// is why the one place that reached back into the list was a callback already waiting for
// every other action on this page.

export function openNicknameModal(serverId, member, onDone) {
  const name = member.nickname || member.display_name || member.username;
  const input = el('input', { class: 'input', type: 'text', maxlength: 32, placeholder: 'Nickname (2-32 chars)', value: name });
  const err = el('div', { class: 'form-error', hidden: true });
  const save = el('button', { class: 'btn primary', type: 'button' }, 'Save');
  const clearBtn = el('button', { class: 'btn ghost', type: 'button' }, 'Clear');
  const modal = openModal({
    title: 'Nickname',
    body: el('div', {}, err,
      el('p', { class: 'muted small' }, 'Set how @' + (member.username || '') + ' appears in this community. Empty clears it.'),
      input),
    footer: [clearBtn, save],
  });
  const saveIt = async () => {
    err.hidden = true;
    try {
      const res = await Api.setNickname(serverId, member.user_id || member.id, input.value.trim());
      toast(res && res.nickname ? 'Nickname saved.' : 'Nickname cleared.', 'ok');
      modal.close();
      await enterServer(serverId).catch(() => {});
      if (onDone) onDone();
    } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Failed'; }
  };
  save.addEventListener('click', saveIt);
  clearBtn.addEventListener('click', async () => {
    err.hidden = true;
    try {
      await Api.setNickname(serverId, member.user_id || member.id, '');
      toast('Nickname cleared.', 'ok');
      modal.close();
      await enterServer(serverId).catch(() => {});
      if (onDone) onDone();
    } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Failed'; }
  });
}

export function openBanModal(serverId, m, onDone) {
  const id = m.user_id || m.id;
  const reason = el('input', { class: 'input', type: 'text', maxlength: 500, placeholder: 'Reason (optional)' });
  const dur = el('select', { class: 'input' });
  [['', 'Permanent'], ['60', '1 hour'], ['1440', '1 day'], ['10080', '7 days']].forEach(([v, label]) => {
    const o = el('option', { value: v }, label);
    dur.appendChild(o);
  });
  const err = el('div', { class: 'form-error', hidden: true });
  const cancel = el('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
  const go = el('button', { class: 'btn danger', type: 'button' }, 'Ban member');
  const modal = openModal({
    title: 'Ban @' + (m.username || ''),
    body: el('div', {}, err,
      el('div', { class: 'field' }, el('label', {}, 'Reason'), reason),
      el('div', { class: 'field' }, el('label', {}, 'Duration'), dur),
      el('p', { class: 'muted small' }, 'Banned users are removed immediately and cannot rejoin until unbanned or the ban expires.')),
    footer: [cancel, go],
  });
  cancel.addEventListener('click', () => modal.close());
  go.addEventListener('click', async () => {
    err.hidden = true;
    try {
      await Api.banMember(serverId, id, { reason: reason.value.trim() || undefined, minutes: dur.value ? Number(dur.value) : undefined });
      modal.close();
      toast('Member banned.', 'ok');
      await onDone();
    } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Could not ban member.'; }
  });
}

export function openTimeoutModal(serverId, m, onDone) {
  const id = m.user_id || m.id;
  const dur = el('select', { class: 'input' });
  [['10', '10 minutes'], ['60', '1 hour'], ['1440', '1 day'], ['10080', '7 days'], ['', 'Clear timeout']].forEach(([v, label]) => {
    dur.appendChild(el('option', { value: v }, label));
  });
  const err = el('div', { class: 'form-error', hidden: true });
  const cancel = el('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
  const go = el('button', { class: 'btn primary', type: 'button' }, 'Apply');
  const modal = openModal({
    title: 'Timeout @' + (m.username || ''),
    body: el('div', {}, err,
      el('div', { class: 'field' }, el('label', {}, 'Duration'), dur),
      el('p', { class: 'muted small' }, 'Timed-out members stay in the community but cannot post until it lapses.')),
    footer: [cancel, go],
  });
  cancel.addEventListener('click', () => modal.close());
  go.addEventListener('click', async () => {
    err.hidden = true;
    try {
      await Api.timeoutMember(serverId, id, dur.value === '' ? null : Number(dur.value));
      modal.close();
      toast(dur.value === '' ? 'Timeout cleared.' : 'Member timed out.', 'ok');
      await onDone();
    } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Could not set timeout.'; }
  });
}

// Support hub + user appeals. Backed by the real appeals backend:
// anonymous submission keyed on the moderation action id
// (POST /api/appeals) and a signed-in listing of your own appeals
// (GET /api/appeals/mine). No mock data.

import Api from './api.js';
import { esc, el, clear, toast } from './ui.js';
import { isAuthed } from './state.js';
import { renderContextHeader } from './shell.js';

function actionIdFromHash() {
  try {
    const q = (location.hash.split('?')[1] || '');
    const v = new URLSearchParams(q).get('action');
    return v ? String(v).trim() : '';
  } catch {
    return '';
  }
}

export function appealLink(actionId) {
  return '#/support/appeals/new' + (actionId ? '?action=' + encodeURIComponent(actionId) : '');
}

export async function renderSupport(container) {
  clear(container);
  renderContextHeader({ title: 'Support', sub: 'Help and moderation appeals' });
  const wrap = el('div', { class: 'page atrium' });
  wrap.appendChild(el('h2', {}, 'Support'));
  wrap.appendChild(el('p', { class: 'muted' },
    'Get help with your account, report problems, or appeal a moderation decision. Appeals go directly to the people who run this instance.'));

  let instanceName = '';
  try {
    const info = await Api.instance().catch(() => null);
    if (info && info.name) instanceName = info.name;
  } catch { /* offline: hub still renders */ }

  const grid = el('div', { class: 'theme-grid' });
  const card = (title, text, href, label) => {
    const box = el('div', { class: 'auth-box' });
    box.appendChild(el('h1', { style: { fontSize: '1.15rem' } }, title));
    box.appendChild(el('p', { class: 'auth-sub' }, text));
    box.appendChild(el('a', { class: 'btn primary', href }, label));
    grid.appendChild(box);
  };
  card('Appeal a decision',
    'If your account or community was moderated, you can appeal with the action ID you received. No sign-in needed to submit.',
    '#/support/appeals/new', 'Start an appeal');
  if (isAuthed()) {
    card('My appeals',
      'Track appeals you have submitted and see their decisions.',
      '#/support/appeals', 'View my appeals');
  } else {
    card('My appeals',
      'Sign in to see appeals linked to your account.',
      '#/login', 'Sign in');
  }
  card('Community rules',
    'Review the terms and privacy policy that apply on this instance.',
    '#/discover', 'Discover communities');
  wrap.appendChild(grid);

  if (instanceName) {
    wrap.appendChild(el('p', { class: 'muted small', style: { marginTop: 'var(--t-d-5)' } },
      'You are on ' + instanceName + '. Appeals are reviewed by this instance\u2019s team.'));
  }
  container.appendChild(wrap);
}

const APPEAL_STATUS_LABEL = { OPEN: 'Open', UNDER_REVIEW: 'Under review', APPROVED: 'Approved', DENIED: 'Denied' };

export async function renderMyAppeals(container) {
  clear(container);
  renderContextHeader({ title: 'My appeals', sub: 'Your moderation appeals' });
  const wrap = el('div', { class: 'page atrium community-manager' });
  wrap.appendChild(el('div', { class: 'community-manager__head' },
    el('div', {}, el('h1', {}, 'My appeals'), el('p', { class: 'muted' }, 'Decisions appear here once reviewed.')),
    el('a', { class: 'btn primary', href: '#/support/appeals/new' }, 'New appeal')));
  const list = el('div', { class: 'community-list' });
  wrap.appendChild(list);
  container.appendChild(wrap);
  let items = null;
  try {
    items = await Api.myAppeals();
  } catch (ex) {
    list.appendChild(el('div', { class: 'form-error' }, ex.message || 'Could not load your appeals.'));
    return;
  }
  if (!items || !items.length) {
    list.appendChild(el('div', { class: 'empty-state' }, 'No appeals yet. If you received a moderation action, appeal it from the button above.'));
    return;
  }
  for (const a of items) {
    const row = el('article', { class: 'community-member-card' });
    const info = el('div', { class: 'community-member-card__info' });
    info.appendChild(el('strong', {}, (a.action_type || 'Moderation action') + ' · ' + (APPEAL_STATUS_LABEL[a.status] || a.status || '')));
    info.appendChild(el('span', { class: 'muted small' },
      'Submitted ' + esc(a.created_at || '') + (a.updated_at && a.updated_at !== a.created_at ? ' · updated ' + esc(a.updated_at) : '')));
    if (a.decision) info.appendChild(el('span', { class: 'muted small' }, 'Decision: ' + esc(a.decision)));
    row.appendChild(info);
    list.appendChild(row);
  }
}

export function renderNewAppeal(container) {
  clear(container);
  renderContextHeader({ title: 'Appeal a decision', sub: 'Ask for a second look' });
  const wrap = el('div', { class: 'auth-wrap' });
  const card = el('div', { class: 'auth-box' });
  card.appendChild(el('h1', {}, 'Appeal a moderation decision'));
  card.appendChild(el('p', { class: 'auth-sub' },
    'Enter the action ID from your enforcement notice and explain why it should be reconsidered. You do not need to be signed in.'));

  const err = el('div', { class: 'form-error', hidden: true });
  const ok = el('div', { class: 'form-success', hidden: true });
  const actionInput = el('input', {
    class: 'input', type: 'text', placeholder: 'Action ID (from your notice)',
    value: actionIdFromHash(), autocomplete: 'off',
  });
  const reason = el('textarea', {
    class: 'input', rows: 5, maxlength: 4000,
    placeholder: 'What happened, in your own words? Be specific — this goes to a human reviewer.',
  });
  const submit = el('button', { class: 'btn primary block', type: 'submit' }, 'Submit appeal');
  const form = el('form', {}, err, ok,
    el('div', { class: 'field' }, el('label', {}, 'Action ID'), actionInput,
      el('span', { class: 'hint' }, 'Found in your enforcement notice, or pre-filled if you came from sign-in.')),
    el('div', { class: 'field' }, el('label', {}, 'Your appeal'), reason),
    submit);

  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    err.hidden = true;
    ok.hidden = true;
    const actionId = actionInput.value.trim();
    if (!actionId) { err.hidden = false; err.textContent = 'Enter the action ID from your enforcement notice.'; return; }
    if (!reason.value.trim()) { err.hidden = false; err.textContent = 'Tell the reviewer why this should be reconsidered.'; return; }
    busy = true;
    submit.setAttribute('aria-busy', 'true');
    submit.textContent = 'Submitting…';
    try {
      const res = await Api.submitAppeal({ actionId, reason: reason.value.trim() });
      ok.hidden = false;
      ok.textContent = 'Appeal received' + (res && res.id ? ' (reference ' + res.id.slice(0, 8) + ').' : '.') +
        ' A reviewer will look at it as soon as possible.';
      form.reset();
      if (isAuthed()) toast('Appeal submitted.', 'ok');
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message || 'Could not submit the appeal.';
    } finally {
      busy = false;
      submit.removeAttribute('aria-busy');
      submit.textContent = 'Submit appeal';
    }
  });

  card.appendChild(form);
  if (isAuthed()) {
    card.appendChild(el('p', { class: 'auth-alt' }, el('a', { href: '#/support/appeals' }, 'View my appeals')));
  } else {
    card.appendChild(el('p', { class: 'auth-alt' }, 'Signed in? ', el('a', { href: '#/support/appeals' }, 'Track your appeals')));
  }
  wrap.appendChild(card);
  container.appendChild(wrap);
  actionInput.focus();
}

export default { renderSupport, renderMyAppeals, renderNewAppeal, appealLink };

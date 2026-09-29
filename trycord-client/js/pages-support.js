
import Api from './api.js';
import { esc, el, clear, toast } from './ui.js';
import { isAuthed } from './state.js';

function actionIdFromHash() {
  try {
    const q = (location.hash.split('?')[1] || '');
    const v = new URLSearchParams(q).get('action');
    return v ? String(v).trim() : '';
  } catch {
    return '';
  }
}

export async function renderSupport(container) {
  clear(container);
  const wrap = el('div', { class: 'pub-page' });
  wrap.appendChild(el('h1', { class: 'pub-title' }, 'Support'));
  wrap.appendChild(el('p', { class: 'pub-lede' },
    'Get help with your account, report a problem, or appeal a moderation decision. Appeals go directly to the people who run this instance.'));

  let instanceName = '';
  try {
    const info = await Api.instance().catch(() => null);
    if (info && info.name) instanceName = info.name;
  } catch { /* offline: hub still renders */ }

  const section = (heading) => {
    const s = el('div', { class: 'pub-section' });
    s.appendChild(el('h2', { class: 'pub-section__title' }, heading));
    const links = el('div', { class: 'pub-links' });
    s.appendChild(links);
    wrap.appendChild(s);
    return links;
  };
  // description and the action can never disagree.
  const link = (parent, title, desc, href) => {
    const a = el('a', { class: 'pub-link', href });
    a.appendChild(el('div', { class: 'pub-link__title' }, title));
    a.appendChild(el('div', { class: 'pub-link__desc' }, desc));
    parent.appendChild(a);
  };

  const help = section('Get help');
  link(help, 'Appeal a decision',
    'If your account or community was moderated, appeal with the action ID you received. No sign-in needed to submit.',
    '#/support/appeals/new');
  if (isAuthed()) {
    link(help, 'My appeals', 'Track appeals you have submitted and see their decisions.', '#/support/appeals');
  } else {
    link(help, 'My appeals', 'Sign in to see appeals linked to your account.', '#/login');
  }

  // The real documents are server-served on this origin at /terms and
  const rules = section('Community rules');
  link(rules, 'Terms of Service', 'The terms that apply on this instance.', '/terms');
  link(rules, 'Privacy Policy', 'What this instance stores, and why.', '/privacy');

  if (instanceName) {
    wrap.appendChild(el('p', { class: 'muted small', style: { marginTop: 'var(--t-d-5)' } },
      'You are on ' + instanceName + '. Appeals are reviewed by this instance\u2019s team.'));
  }
  container.appendChild(wrap);
}

const APPEAL_STATUS_LABEL = { OPEN: 'Open', UNDER_REVIEW: 'Under review', APPROVED: 'Approved', DENIED: 'Denied' };

export async function renderMyAppeals(container) {
  clear(container);
  const wrap = el('div', { class: 'pub-page pub-page--narrow' });
  const head = el('div', { class: 'pub-section' });
  head.appendChild(el('h1', { class: 'pub-title' }, 'My appeals'));
  head.appendChild(el('p', { class: 'pub-lede' }, 'Decisions appear here once reviewed.'));
  head.appendChild(el('a', { class: 'btn primary', href: '#/support/appeals/new' }, 'New appeal'));
  wrap.appendChild(head);
  const list = el('div', { class: 'pub-links' });
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
    const row = el('article', { class: 'card card--list' });
    const info = el('div', { class: 'card--list__info' });
    info.appendChild(el('strong', {}, (a.action_type || 'Moderation action') + ' Â· ' + (APPEAL_STATUS_LABEL[a.status] || a.status || '')));
    info.appendChild(el('span', { class: 'muted small' },
      'Submitted ' + esc(a.created_at || '') + (a.updated_at && a.updated_at !== a.created_at ? ' Â· updated ' + esc(a.updated_at) : '')));
    if (a.decision) info.appendChild(el('span', { class: 'muted small' }, 'Decision: ' + esc(a.decision)));
    row.appendChild(info);
    list.appendChild(row);
  }
}

export function renderNewAppeal(container) {
  clear(container);
  const wrap = el('div', { class: 'pub-page pub-page--narrow' });
  wrap.appendChild(el('h1', { class: 'pub-title' }, 'Appeal a moderation decision'));
  wrap.appendChild(el('p', { class: 'pub-lede' },
    'Enter the action ID from your enforcement notice and explain why it should be reconsidered. You do not need to be signed in.'));

  const section = el('div', { class: 'pub-section' });
  const card = el('div', { class: 'card' });
  section.appendChild(card);
  wrap.appendChild(section);

  const err = el('div', { class: 'form-error', hidden: true });
  const ok = el('div', { class: 'form-success', hidden: true });
  const actionInput = el('input', {
    class: 'input', type: 'text', placeholder: 'Action ID (from your notice)',
    value: actionIdFromHash(), autocomplete: 'off',
  });
  const reason = el('textarea', {
    class: 'input', rows: 5, maxlength: 4000,
    placeholder: 'What happened, in your own words? Be specific â€” this goes to a human reviewer.',
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
    submit.textContent = 'Submittingâ€¦';
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
  section.appendChild(card);
  container.appendChild(wrap);
  actionInput.focus();
}

export default { renderSupport, renderMyAppeals, renderNewAppeal };

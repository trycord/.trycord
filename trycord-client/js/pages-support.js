
import Api from './api.js';
import { el, clear, icon, toast } from './ui.js';
import { isAuthed } from './state.js';
import { route } from './nav.js';
import { renderContextHeader } from './shell.js';

function actionIdFromQuery() {
  try {
    const q = (location.search || '').replace(/^\?/, '');
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
  //
  // Two kinds of destination, and they are not interchangeable. A route is
  // handed to route() so it lands inside the app's mount; a document is the
  // origin's own page and must be left exactly where it is, because on a
  // subpath deployment routing '/terms' would send the reader to the app's
  // /app/terms, which is not the document. So the caller says which it is and
  // this does not decide for them.
  const link = (parent, title, desc, href, kind) => {
    const a = el('a', kind === 'document'
      ? { class: 'pub-link', href, 'data-document': '' }
      : { class: 'pub-link', href });
    a.appendChild(el('div', { class: 'pub-link__title' }, title));
    a.appendChild(el('div', { class: 'pub-link__desc' }, desc));
    parent.appendChild(a);
  };

  const help = section('Get help');
  link(help, 'Appeal a decision',
    'If your account or community was moderated, appeal with the action ID you received. No sign-in needed to submit.',
    route('/support/appeals/new'));
  if (isAuthed()) {
    link(help, 'My appeals', 'Track appeals you have submitted and see their decisions.', route('/support/appeals'));
  } else {
    link(help, 'My appeals', 'Sign in to see appeals linked to your account.', route('/login'));
  }

  const rules = section('Community rules');
  link(rules, 'Terms of Service', 'The terms that apply on this instance.', '/terms', 'document');
  link(rules, 'Privacy Policy', 'What this instance stores, and why.', '/privacy', 'document');

  if (instanceName) {
    wrap.appendChild(el('p', { class: 'muted small', style: { marginTop: 'var(--t-d-5)' } },
      'You are on ' + instanceName + '. Appeals are reviewed by this instance\u2019s team.'));
  }
  container.appendChild(wrap);
}

// Appeals are read and written from inside the application, so they are dressed as
// places in it: the header carries the title and the single action, and the page
// below is a list of the appeals themselves.
//
// They used to borrow the public support document's page classes - the oversized
// title, the centred column, the web page's measure - which is what made a
// signed-in page look like somewhere the browser had been sent rather than a place
// the reader had chosen. The missing strip of chrome around it was not an accident
// either: a prefix selector was hiding the shell on anything beginning /support,
// and these two routes begin /support.

const APPEAL_STATUS_LABEL = { OPEN: 'Open', UNDER_REVIEW: 'Under review', APPROVED: 'Approved', DENIED: 'Denied' };

// Enforcement actions arrive as enum values. USER_TIMEOUT printed on a page is a
// stored value that escaped into the interface; the reader is owed a sentence.
const ACTION_WORDS = {
  user_timeout: 'Timed out',
  user_kick: 'Removed from the community',
  user_ban: 'Banned',
  channel_delete: 'Channel deleted',
  message_delete: 'Message deleted',
  server_kick: 'Removed from the community',
  warn: 'Warned',
  role_remove: 'Role removed',
};

function actionLabel(a) {
  const raw = String(a.action_type || '').toLowerCase();
  if (ACTION_WORDS[raw]) return ACTION_WORDS[raw];
  // Unknown to this build: readable rather than shouty, and no pretending to a
  // nicer name than we actually have.
  const words = raw.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Moderation action';
}

// The empty state has to earn its height. Someone reading "no appeals" either had
// an action taken and does not know they can appeal it, or had not, and wants to
// know what one is. So it says both, and offers the next step instead of a
// sentence telling them to use a button.
function appealState(glyph, title, body) {
  const box = el('div', { class: 'state-block' });
  box.appendChild(el('div', { class: 'es-icon' }, icon(glyph)));
  box.appendChild(el('div', { class: 'state-block__label' }, title));
  box.appendChild(el('div', { class: 'state-block__label' }, body));
  box.appendChild(el('div', { class: 'state-block__actions' },
    el('a', { class: 'btn primary', href: route('/support/appeals/new') }, 'Appeal a decision')));
  return box;
}

export async function renderMyAppeals(container) {
  renderContextHeader({
    title: 'My appeals',
    sub: 'Decisions on actions against your account',
    actions: el('a', { class: 'btn primary sm', href: route('/support/appeals/new') }, 'New appeal'),
  });
  clear(container);
  const page = el('div', { class: 'page' });
  const list = el('div', { class: 'stack' });
  page.appendChild(list);
  container.appendChild(page);

  let items = null;
  try {
    items = await Api.myAppeals();
  } catch (ex) {
    list.appendChild(el('div', { class: 'state-block state-block--error' },
      el('div', { class: 'state-block__label' }, ex.message || 'Could not load your appeals.')));
    return;
  }

  if (!items || !items.length) {
    list.appendChild(appealState('flag', 'Nothing to appeal',
      'If an action is taken against your account or a community it comes with an action ID, and you can appeal it from here. Nothing has been actioned against you.'));
    return;
  }

  for (const a of items) {
    const row = el('article', { class: 'card card--list' });
    const info = el('div', { class: 'card--list__info' });

    const head = el('div', { class: 'row-line' });
    head.appendChild(el('div', { class: 'row-title' }, actionLabel(a)));
    head.appendChild(el('span', { class: 'status-chip' },
      APPEAL_STATUS_LABEL[a.status] || a.status || 'Unknown'));
    info.appendChild(head);

    // The reference is what a reviewer quotes back, and it is the only handle a
    // reader has on a decision they did not make.
    const when = 'Submitted ' + String(a.created_at || '').replace('T', ' ').slice(0, 16);
    info.appendChild(el('div', { class: 'muted small' },
      when + (a.id ? ' · reference ' + String(a.id).slice(0, 8) : '')));

    if (a.decision) {
      info.appendChild(el('div', { class: 'small', style: { marginTop: 'var(--t-d-1)' } },
        String(a.decision)));
    }
    row.appendChild(info);
    list.appendChild(row);
  }
}

export function renderNewAppeal(container) {
  renderContextHeader({
    title: 'Appeal a decision',
    sub: 'Every appeal is read by a person on this instance',
  });
  clear(container);
  const page = el('div', { class: 'page' });
  const card = el('div', { class: 'card appeal-form' });
  page.appendChild(card);
  container.appendChild(page);

  const err = el('div', { class: 'form-error', hidden: true });
  const ok = el('div', { class: 'form-success', hidden: true });
  const actionInput = el('input', {
    class: 'input', type: 'text', placeholder: 'Action ID from your notice',
    value: actionIdFromQuery(), autocomplete: 'off',
  });
  const reason = el('textarea', {
    class: 'input', rows: 6, maxlength: 4000,
    placeholder: 'What happened, and why you think it should be reconsidered.',
  });
  const submit = el('button', { class: 'btn primary', type: 'submit' }, 'Submit appeal');

  const clearError = () => {
    if (!err.hidden) { err.hidden = true; err.textContent = ''; }
  };
  actionInput.addEventListener('input', clearError);
  reason.addEventListener('input', clearError);

  const form = el('form', { class: 'stack' }, err, ok,
    el('div', { class: 'field' },
      el('label', {}, 'Action ID'),
      actionInput,
      el('span', { class: 'hint' }, 'On the notice you were sent, and filled in for you if you arrived from it.')),
    el('div', { class: 'field' },
      el('label', {}, 'Your appeal'),
      reason,
      el('span', { class: 'hint' }, 'A person reads this. What happened, in your own words, beats anything formal.')),
    el('div', { class: 'row-line' }, submit));

  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    err.hidden = true;
    ok.hidden = true;
    const actionId = actionInput.value.trim();
    if (!actionId) {
      err.hidden = false;
      err.textContent = 'Enter the action ID from your notice.';
      actionInput.focus();
      return;
    }
    if (!reason.value.trim()) {
      err.hidden = false;
      err.textContent = 'Tell the reviewer why this should be reconsidered.';
      reason.focus();
      return;
    }
    busy = true;
    submit.setAttribute('aria-busy', 'true');
    submit.textContent = 'Submitting…';
    try {
      const res = await Api.submitAppeal({ actionId, reason: reason.value.trim() });
      ok.hidden = false;
      ok.textContent = 'Appeal received'
        + (res && res.id ? ' (reference ' + String(res.id).slice(0, 8) + ').' : '.')
        + ' A reviewer will look at it as soon as they can.';
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
  // Only offered to someone who can act on the answer. Telling a signed-in reader
  // they do not need to be signed in is noise on a page they are already inside.
  if (isAuthed()) {
    card.appendChild(el('p', { class: 'auth-alt' },
      el('a', { href: route('/support/appeals') }, 'Back to my appeals')));
  }
  // Not when the field is already filled in: focusing an input the reader cannot
  // see the contents of scrolls the page out from under the notice they just read.
  if (!actionInput.value) actionInput.focus();
}

export default { renderSupport, renderMyAppeals, renderNewAppeal };

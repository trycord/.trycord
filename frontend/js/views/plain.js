// Everything that is not a workspace, a conversation or a settings tree.
//
// Support and the legal documents are read outside the shell, the way the sign-in
// screens are. Invitations, creating a community and a missing page are ordinary
// pages that happen to need very little.

import { el } from '../dom.js';
import { icon } from '../icons.js';
import { State, refreshServers } from '../store.js';
import Api from '../api.js';
import { path, navigate } from '../nav.js';
import { toast, errorToast } from '../ui.js';
import { page, heading, section } from './util.js';

// -- public documents --------------------------------------------------------

function pubShell(title, body) {
  return el('div', { class: 'pub-page' },
    el('header', { class: 'pub-head' },
      el('a', { class: 'pub-back', href: path('/home') }, icon('chevron-left', { size: 18 }), 'Back to Trycord'),
      el('span', { class: 'pub-title' }, title)),
    el('main', { class: 'pub-body' }, body));
}

export function renderSupport() {
  const instance = State.instance || {};
  const body = el('div', { class: 'pub-doc' },
    el('h1', {}, 'Support'),
    el('p', {}, 'Trycord is self-hosted, so the people who can help are the people who run this instance.'),
    el('div', { class: 'pub-links' },
      instance.supportUrl ? el('a', { class: 'btn btn--primary', href: instance.supportUrl }, 'Open the support page') : null,
      el('a', { class: 'btn btn--default', href: path('/login') }, 'Back to sign in')),
  );
  return { raw: true, node: pubShell('Support', body), head: [] };
}

export function renderLegal(ctx) {
  const title = ctx.params && ctx.params.doc ? String(ctx.params.doc) : 'Legal';
  const body = el('div', { class: 'pub-doc' },
    el('h1', {}, 'Legal'),
    el('p', {}, 'The terms and privacy policy for this instance are published on its public site.'),
    el('div', { class: 'pub-links' },
      el('a', { class: 'btn btn--default', href: path('/terms') }, 'Terms of Service'),
      el('a', { class: 'btn btn--default', href: path('/privacy') }, 'Privacy Policy')),
    el('p', { class: 'muted-note' }, 'Requested document: ' + title));
  return { raw: true, node: pubShell('Legal', body), head: [] };
}

// -- invitations -------------------------------------------------------------

export function renderInvite(ctx) {
  const code = ctx.params.code;
  const host = el('div', { class: 'invite-card' });
  const node = page({ narrow: true },
    heading('You have been invited', 'Accept to join this community.'),
    host);

  function showJoin() {
    host.replaceChildren();
    const button = el('button', { class: 'btn btn--primary btn--lg', type: 'button' }, 'Join community');
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const out = await Api.joinInvite(code);
        const server = out && (out.server || out);
        await refreshServers();
        toast('Joined.', { type: 'success' });
        if (server && server.id) navigate('/server/' + server.id);
        else navigate('/home');
      } catch (error) { errorToast(error); button.disabled = false; }
    });
    host.appendChild(el('div', { class: 'invite-state' },
      icon('users', { size: 26 }),
      el('div', { class: 'invite-state-title' }, 'An invitation to join'),
      el('div', { class: 'invite-state-code' }, code),
      button));
  }

  async function load() {
    if (!State.user) {
      host.replaceChildren(el('div', { class: 'invite-state' },
        el('div', { class: 'invite-state-title' }, 'Sign in to accept'),
        el('a', { class: 'btn btn--primary', href: path('/login?next=' + encodeURIComponent('/invite/' + code)) }, 'Sign in')));
      return;
    }
    showJoin();
  }

  return { node, head: [], onMount: load };
}

// -- creating a community ----------------------------------------------------

export function renderServerCreate() {
  const name = el('input', { class: 'input', maxlength: '60', placeholder: 'Ember Works' });
  const description = el('textarea', { class: 'input', rows: '3', maxlength: '400', placeholder: 'What is this place for?' });
  const isPublic = el('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': 'Public' });
  const isDiscoverable = el('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': 'Discoverable' });
  let publicValue = false;
  let discoverable = false;
  isPublic.addEventListener('click', () => { publicValue = !publicValue; isPublic.setAttribute('aria-checked', String(publicValue)); });
  isDiscoverable.addEventListener('click', () => { discoverable = !discoverable; isDiscoverable.setAttribute('aria-checked', String(discoverable)); });

  const error = el('div', { class: 'form-error' });
  const submit = el('button', { class: 'btn btn--primary', type: 'button' }, 'Create community');
  submit.addEventListener('click', async () => {
    error.textContent = '';
    if (!name.value.trim()) { error.textContent = 'Give your community a name.'; return; }
    submit.disabled = true;
    try {
      const server = await Api.createServer({
        name: name.value.trim(),
        description: description.value,
        isPublic: publicValue,
        isDiscoverable: discoverable,
      });
      await refreshServers();
      toast('Community created.', { type: 'success' });
      if (server && server.id) navigate('/server/' + server.id);
      else navigate('/home');
    } catch (err) { error.textContent = err.message || 'Could not create the community.'; }
    finally { submit.disabled = false; }
  });

  const host = el('div', { class: 'settings-card' },
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Name'), name),
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Description'), description),
    el('div', { class: 'field-row' },
      el('div', { class: 'field-row-main' },
        el('div', { class: 'field-row-title' }, 'Public'),
        el('div', { class: 'field-row-hint' }, 'Anyone with the link may read the preview.')),
      isPublic),
    el('div', { class: 'field-row' },
      el('div', { class: 'field-row-main' },
        el('div', { class: 'field-row-title' }, 'Discoverable'),
        el('div', { class: 'field-row-hint' }, 'Appears in Discover searches.')),
      isDiscoverable),
    error,
    el('div', { class: 'settings-actions' }, submit));

  const node = page({ narrow: true },
    heading('Create a community', 'A home for your people.'),
    host,
    section('What happens next', el('p', { class: 'muted-note' },
      'You become the owner. Add channels, invite people, and shape it as you go.')));

  return { node, head: [], onMount() { name.focus(); } };
}

// -- nothing here ------------------------------------------------------------

export function renderNotFound() {
  const node = page({ narrow: true },
    el('div', { class: 'view-empty' },
      el('div', { class: 'view-empty-title' }, 'That page does not exist'),
      el('div', { class: 'view-empty-text' }, 'Follow the rail back to somewhere real.'),
      el('a', { class: 'btn btn--primary', href: path('/home') }, 'Go home')));
  return { node, head: [] };
}

export default { renderSupport, renderLegal, renderInvite, renderServerCreate, renderNotFound };

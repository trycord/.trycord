// Everything on a phone that is not a workspace, a conversation or a settings
// tree: the public documents, invitations, creating a community, and a missing
// page. The public documents are read outside the shell, the way the sign-in
// screens are; the rest are ordinary shell screens.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { State, refreshServers } from '../../../packages/store.js';
import Api from '../../../packages/api.js';
import { path, publicPath, navigate } from '../../../packages/nav.js';
import { toast } from '../ui.js';
import { screen, notice, field, textInput, textArea } from './util.js';

function pubShell(title, body) {
  return el('div', { class: 'm-pub' },
    el('header', { class: 'm-pub__head' },
      el('a', { class: 'm-pub__back', href: path('/home') }, icon('chevron-left', { size: 18 }), 'Back to Trycord'),
      el('span', { class: 'm-pub__title' }, title)),
    el('main', { class: 'm-pub__body' }, body));
}

export function renderSupport() {
  const node = pubShell('Support', el('div', { class: 'm-stack' },
    el('h1', { class: 'm-hero__title' }, 'Support'),
    el('p', { class: 'm-lede' }, 'Trycord is self-hosted, so the people who run this instance are the ones who can help.'),
    el('div', { class: 'm-actions' },
      el('a', { class: 'm-btn m-btn--ghost', href: publicPath('/terms') }, 'Terms'),
      el('a', { class: 'm-btn m-btn--ghost', href: publicPath('/privacy') }, 'Privacy'))));
  return { raw: true, node, title: 'Support' };
}

export function renderLegal(ctx) {
  const doc = ctx.params.doc;
  const node = pubShell('Legal', el('div', { class: 'm-stack' },
    el('h1', { class: 'm-hero__title' }, doc ? doc.replace(/-/g, ' ') : 'Legal'),
    el('p', { class: 'm-lede' }, 'The terms and privacy policy for this instance are published on its public site.'),
    el('div', { class: 'm-actions' },
      el('a', { class: 'm-btn m-btn--ghost', href: publicPath('/terms') }, 'Terms of Service'),
      el('a', { class: 'm-btn m-btn--ghost', href: publicPath('/privacy') }, 'Privacy Policy'))));
  return { raw: true, node, title: 'Legal' };
}

export function renderInvite(ctx) {
  const code = ctx.params.code;
  const host = el('div', { class: 'm-stack' });
  const node = screen(host);

  async function load() {
    host.replaceChildren();
    if (!State.user) {
      host.appendChild(el('div', { class: 'm-stack' },
        notice({ title: 'An invitation', text: 'Sign in to accept it.' }),
        el('a', { class: 'm-btn m-btn--primary', href: path('/login?next=' + encodeURIComponent('/invite/' + code)) }, 'Sign in')));
      return;
    }
    const button = el('button', { class: 'm-btn m-btn--primary m-btn--block', type: 'button' }, 'Join community');
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const out = await Api.joinInvite(code);
        const server = out && (out.server || out);
        await refreshServers();
        toast('Joined.', { type: 'success' });
        navigate(server && server.id ? '/server/' + server.id : '/home');
      } catch (error) { toast(error.message, { type: 'danger' }); button.disabled = false; }
    });
    host.appendChild(el('div', { class: 'm-stack' },
      notice({ title: 'An invitation to join', text: code }), button));
  }

  return { node, head: { lead: 'back', title: 'Invitation' }, onMount: load };
}

export function renderServerCreate() {
  const host = el('div', { class: 'm-stack' });
  const name = textInput({ placeholder: 'Ember Works', maxlength: 60 });
  const description = textArea({ placeholder: 'What is this place for?', maxlength: 400, rows: 3 });
  const isPublic = el('input', { type: 'checkbox', class: 'm-check' });
  const isDiscoverable = el('input', { type: 'checkbox', class: 'm-check' });
  const error = el('p', { class: 'm-lede' });

  const node = screen(
    el('div', { class: 'm-hero m-hero--quiet' }, el('h1', { class: 'm-hero__title' }, 'Create a community')),
    host);

  host.append(
    field({ label: 'Name', control: name }),
    field({ label: 'Description', control: description }),
    el('label', { class: 'm-check-row' }, isPublic, el('span', {}, 'Public — anyone with the link may read the preview')),
    el('label', { class: 'm-check-row' }, isDiscoverable, el('span', {}, 'Discoverable — appears in Discover searches')),
    error,
    el('button', {
      class: 'm-btn m-btn--primary m-btn--block', type: 'button',
      onClick: async (event) => {
        const button = event.currentTarget;
        if (!name.value.trim()) { error.textContent = 'Give the community a name.'; return; }
        button.disabled = true;
        try {
          const server = await Api.createServer({
            name: name.value.trim(),
            description: description.value,
            isPublic: isPublic.checked,
            isDiscoverable: isDiscoverable.checked,
          });
          await refreshServers();
          toast('Community created.', { type: 'success' });
          navigate(server && server.id ? '/server/' + server.id : '/home');
        } catch (err) { error.textContent = err.message || 'Could not create the community.'; }
        finally { button.disabled = false; }
      },
    }, 'Create'));

  return { node, head: { lead: 'back', title: 'New community' }, onMount() { name.focus(); } };
}

export function renderNotFound() {
  const node = screen(el('div', { class: 'm-state' },
    el('span', { class: 'm-state__icon' }, icon('compass', { size: 24 })),
    el('div', { class: 'm-state__title' }, 'That page does not exist'),
    el('div', { class: 'm-state__text' }, 'Follow the tabs back to somewhere real.'),
    el('a', { class: 'm-btn m-btn--primary', href: path('/home') }, 'Go home')));
  return { node, head: { title: 'Not found' } };
}

export default { renderSupport, renderLegal, renderInvite, renderServerCreate, renderNotFound };

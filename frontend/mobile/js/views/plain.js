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

  // The ways an invitation can be dead, in the same words the desk says -
  // one refusal cannot mean two things across the two clients. Anything
  // that is not one of these keeps the form, because the invitation may be
  // fine and the network may not be.
  const ENDINGS = {
    INVITE_INVALID: {
      title: 'This invite is not right',
      body: 'The link may have been copied with a piece missing. Check you have the whole link, or ask whoever sent it to send it again.',
    },
    INVITE_EXPIRED: {
      title: 'This invite has expired',
      body: 'Invitations here do not stay open forever. Ask whoever sent it for a fresh one.',
    },
    INVITE_REVOKED: {
      title: 'This invite was pulled back',
      body: 'The community took this invitation down. If they still want you in, they can send a new one.',
    },
    INVITE_EXHAUSTED: {
      title: 'This invite has been used up',
      body: 'It let a set number of people in, and that number has arrived. Ask for a new invitation.',
    },
  };

  function showEnding(code) {
    const ending = ENDINGS[code];
    if (!ending) return;
    host.replaceChildren(el('div', { class: 'm-stack' },
      notice({ title: ending.title, text: ending.body }),
      el('a', { class: 'm-btn m-btn--block', href: path('/home') }, 'Back to Trycord')));
  }

  async function load() {
    host.replaceChildren();
    if (!State.user) {
      host.appendChild(el('div', { class: 'm-stack' },
        notice({ title: 'An invitation', text: 'Sign in to accept it.' }),
        el('a', { class: 'm-btn m-btn--primary', href: path('/login?next=' + encodeURIComponent('/invite/' + code)) }, 'Sign in')));
      return;
    }
    const invitation = notice({ title: 'An invitation to join', text: code });
    const button = el('button', { class: 'm-btn m-btn--primary m-btn--block', type: 'button' }, 'Join community');
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const out = await Api.joinInvite(code);
        const server = out && (out.server || out);
        await refreshServers();
        toast('Joined.', { type: 'success' });
        navigate(server && server.id ? '/server/' + server.id : '/home');
      } catch (error) {
        if (ENDINGS[error && error.code]) { showEnding(error.code); return; }
        toast(error.message, { type: 'danger' });
        button.disabled = false;
      }
    });
    host.appendChild(el('div', { class: 'm-stack' }, invitation, button));
    // The preview names the community on the button, and a dead invitation
    // says so now rather than when the button is pressed and refused.
    Api.invitePreview(code).then((p) => {
      if (p && (p.name || p.serverName || p.communityName)) {
        invitation.querySelector('.m-notice__title').textContent = 'An invitation to join ' + (p.name || p.serverName || p.communityName);
      }
    }).catch((error) => {
      if (ENDINGS[error && error.code]) showEnding(error.code);
    });
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

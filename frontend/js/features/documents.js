// The documents.
//
// Support and the legal papers are read outside the workspace, exactly like the
// sign-in gates: a reader without a session still has to be able to read the
// rules. Invitations, community creation and the missing page are ordinary
// in-shell pages that happen to need very little.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { switchControl, fieldRow } from '../ui/primitives.js';
import { State, refreshServers } from '../../packages/store.js';
import Api from '../../packages/api.js';
import { path, publicPath, navigate } from '../../packages/nav.js';
import { toast, errorToast } from '../ui/overlays.js';
import { head, card, fold, blank } from '../ui/page.js';

// -- the outside documents ----------------------------------------------------

export function renderSupport() {
  const instance = State.instance || {};
  const body = el('div', { class: 'paper' },
    el('p', { class: 'paper-kicker' }, 'Document'),
    el('h1', { class: 'paper-title' }, 'Support'),
    el('p', { class: 'paper-lede' },
      'Trycord is self-hosted, so the people who can help are the people who run this instance.'),
    el('div', { class: 'actionline' },
      el('a', { class: 'btn btn--primary', href: publicPath('/support') }, 'Open the support page'),
      instance.supportUrl ? el('a', { class: 'btn btn--default', href: instance.supportUrl }, 'Contact the operators') : null,
      el('a', { class: 'btn btn--default', href: path('/login') }, 'Back to sign in')),
  );
  return { raw: true, node: docShell('Support', body), title: 'Support' };
}

export function renderLegal(ctx) {
  const asked = ctx.params && ctx.params.doc ? String(ctx.params.doc) : '';
  const known = PUBLIC_PAPERS[asked] || null;
  const extra = known && known.path !== '/terms' && known.path !== '/privacy'
    ? el('a', { class: 'btn btn--primary', href: publicPath(known.path) }, known.label)
    : null;
  const body = el('div', { class: 'paper' },
    el('p', { class: 'paper-kicker' }, 'Document'),
    el('h1', { class: 'paper-title' }, known ? known.label : 'Legal'),
    el('p', { class: 'paper-lede' }, 'The terms and privacy policy for this instance are published on its public site.'),
    el('div', { class: 'actionline' },
      el('a', { class: 'btn btn--default', href: publicPath('/terms') }, 'Terms of Service'),
      el('a', { class: 'btn btn--default', href: publicPath('/privacy') }, 'Privacy Policy'),
      extra),
    known ? null : el('p', { class: 'paper-note' }, 'Requested document: ' + asked));
  const title = known ? known.label : 'Legal';
  return { raw: true, node: docShell(title, body), title };
}

const PUBLIC_PAPERS = {
  terms: { path: '/terms', label: 'Terms of Service' },
  privacy: { path: '/privacy', label: 'Privacy Policy' },
  'instances-terms': { path: '/instances-terms', label: 'Official instance terms' },
  'trust-and-safety': { path: '/trust-and-safety', label: 'Trust & Safety' },
  security: { path: '/security', label: 'Security' },
  support: { path: '/support', label: 'Support' },
};

function docShell(title, body) {
  return el('div', { class: 'pub-page' },
    el('header', { class: 'sheet-top' },
      el('a', { class: 'sheet-return', href: path('/home') }, icon('chevron-left', { size: 17 }), 'Back to Trycord'),
      el('span', { class: 'sheet-name' }, title)),
    el('main', { class: 'sheet-body' }, body));
}

// -- invitations --------------------------------------------------------------

export function renderInvite(ctx) {
  const code = ctx.params.code;
  const host = el('div', { class: 'fold fold--tight' });

  // The ways an invitation can be dead, in the words the reader needs. Each
  // one is a real refusal the API answers with its own code - nothing here
  // guesses. A failure that is not one of these (a network that dropped)
  // keeps the form, because the invitation may be fine.
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

  const node = fold([
    head({
      kicker: 'Invitation',
      title: 'You were invited',
      lede: 'Accept to join this community.',
    }),
    host,
  ]);
  const titleEl = node.querySelector('.pagehead-title');
  const ledeEl = node.querySelector('.pagehead-lede');

  function showEnding(code) {
    const ending = ENDINGS[code];
    if (!ending) return;
    titleEl.textContent = ending.title;
    ledeEl.textContent = ending.body;
    host.replaceChildren(card({
      label: 'This invitation',
      glyph: 'mail',
      body: [
        el('div', { class: 'actionline' },
          el('a', { class: 'btn btn--default', href: path('/home') }, 'Back to Trycord')),
      ],
    }));
  }

  function showJoin() {
    const button = el('button', { class: 'btn btn--primary btn--lg', type: 'button' }, 'Join community');
    const title = el('p', { class: 'lede' }, 'Accept to join this community.');
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const out = await Api.joinInvite(code);
        const server = out && (out.server || out);
        await refreshServers();
        toast('Joined.', { type: 'success' });
        if (server && server.id) navigate('/server/' + server.id);
        else navigate('/home');
      } catch (error) {
        if (ENDINGS[error && error.code]) { showEnding(error.code); return; }
        errorToast(error);
        button.disabled = false;
      }
    });
    host.replaceChildren(card({
      label: 'This invite',
      glyph: 'mail',
      body: [
        el('div', { class: 'joincode' }, code),
        title,
        el('div', { class: 'actionline' }, button),
      ],
    }));
    Api.invitePreview(code).then((p) => {
      if (p && (p.name || p.serverName || p.communityName)) {
        title.textContent = 'Join ' + (p.name || p.serverName || p.communityName) + '.';
      }
    }).catch((error) => {
      // A dead invitation says so now, in its own words, instead of waiting
      // for the join button to be pressed and refused.
      if (ENDINGS[error && error.code]) showEnding(error.code);
    });
  }

  function load() {
    if (!State.user) {
      host.replaceChildren(card({
        label: 'Sign in to accept',
        glyph: 'lock',
        body: [
          el('p', { class: 'form-note' }, 'This invitation joins your account to a community.'),
          el('div', { class: 'actionline' },
            el('a', {
              class: 'btn btn--primary',
              href: path('/login?next=' + encodeURIComponent('/invite/' + code)),
            }, 'Sign in')),
        ],
      }));
      return;
    }
    showJoin();
  }

  return { node, onMount: load };
}

// -- creating a community -----------------------------------------------------

export function renderServerCreate() {
  const name = el('input', { class: 'input', maxlength: '60', placeholder: 'Ember Works' });
  const description = el('textarea', { class: 'input', rows: '3', maxlength: '400', placeholder: 'What is this place for?' });
  let publicValue = false;
  let discoverable = false;

  const error = el('p', { class: 'form-error', hidden: true });
  const submit = el('button', { class: 'btn btn--primary', type: 'button' }, 'Create community');
  submit.addEventListener('click', async () => {
    error.hidden = true;
    if (!name.value.trim()) { error.hidden = false; error.textContent = 'Give your community a name.'; return; }
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
    } catch (err) {
      error.hidden = false;
      error.textContent = (err && err.message) || 'Could not create the community.';
    } finally { submit.disabled = false; }
  });

  const node = fold([
    head({
      kicker: 'New community',
      title: 'Start somewhere',
      lede: 'A home for your people.',
    }),
    card({
      label: 'The basics',
      glyph: 'plus',
      body: [
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Name'), name),
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Description'), description),
      ],
      rows: [
        fieldRow('Public', 'Anyone with the link may read the preview.',
          switchControl(false, (value) => { publicValue = value; }, 'Public')),
        fieldRow('Discoverable', 'Appears in Discover searches.',
          switchControl(false, (value) => { discoverable = value; }, 'Discoverable')),
      ],
      foot: [error, el('div', { class: 'actionline' }, submit)],
      footEnd: true,
    }),
    card({
      label: 'What happens next',
      flat: true,
      body: el('p', { class: 'form-note' },
        'You become the owner. Add channels, invite people, and shape it as you go.'),
    }),
  ]);

  return { node, onMount() { name.focus(); } };
}

// -- nothing here -------------------------------------------------------------

export function renderNotFound() {
  const node = fold([blank({
    glyph: 'compass',
    title: 'That page does not exist',
    text: 'Press Ctrl K and ask the command bar for somewhere real.',
    action: el('a', { class: 'btn btn--primary', href: path('/home') }, 'Go home'),
  })]);
  return { node };
}

export default { renderSupport, renderLegal, renderInvite, renderServerCreate, renderNotFound };

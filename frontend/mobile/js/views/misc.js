// The remaining addresses the phone answers.
//
// The directory, discovery, search, collections and the public documents. The
// extension console is the operator's and lives on the desk; the phone says so
// honestly rather than pretending to run it.

import {
  el, clear, icon, Api, toast, failed, hold, failure, emptyState,
  items, row, cardOf, consoleScreen,
} from './kit.js';
import { State } from '../../../packages/store.js';
import { path, publicPath } from '../../../packages/nav.js';
import { renderPlaces } from './places.js';

// -- the directory ------------------------------------------------------------
//
// The desk's Menu is the same list the Communities door draws; the phone keeps
// one finder rather than two.

export function renderMenu(ctx) {
  return renderPlaces(ctx);
}

// -- discover -----------------------------------------------------------------

async function discover(host) {
  const card = cardOf('Discover', []);
  host.appendChild(card);
  const paint = async () => {
    card.replaceChildren(el('div', { class: 'm-kicker' }, 'Discover'), hold());
    try {
      const page = await Api.discover({ page: 1, limit: 24 });
      const rows = items((page && (page.items || page.servers)) || page);
      card.replaceChildren(el('div', { class: 'm-kicker' }, 'Discover'),
        ...(rows.length ? rows.map((entry) => row({
          lead: el('span', { class: 'm-row__chevron' }, icon('compass', { size: 16 })),
          title: entry.name || 'A community',
          sub: entry.description || (entry.memberCount ? entry.memberCount + ' members' : ''),
          side: el('button', {
            class: 'm-go m-go--quiet', type: 'button', 'aria-label': 'Join ' + (entry.name || 'this community'),
            onClick: async () => {
              try {
                await Api.joinDiscover(entry.id);
                toast('Joined');
                await paint();
              } catch (error) { failed(error); }
            },
          }, 'Join'),
        })) : [emptyState('compass', 'Nothing to discover',
          'This instance lists no public communities, or they are not open to join.')]));
    } catch (error) {
      card.replaceChildren(failure(error, paint));
    }
  };
  await paint();
}

// -- search -------------------------------------------------------------------

function search(host) {
  const card = cardOf('Search messages', []);
  const input = el('input', {
    class: 'm-input', type: 'search', placeholder: 'A word to look for',
    'aria-label': 'Search messages',
  });
  const results = el('div', { class: 'm-stack' });
  card.appendChild(input);
  host.append(card, results);

  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) {
      results.replaceChildren(emptyState('search', 'Type to search',
        'Two characters or more, and the instance answers from the communities you are in.'));
      return;
    }
    results.replaceChildren(hold());
    try {
      const hits = await Api.search(q, { limit: 25 });
      const rows = Array.isArray(hits) ? hits : [];
      results.replaceChildren(...(rows.length ? rows.map((hit) => row({
        lead: el('span', { class: 'm-row__chevron' }, icon('message', { size: 16 })),
        title: (hit.authorName || hit.author_name || 'Someone') + ': '
          + String(hit.content || '').slice(0, 80),
        sub: hit.channelName || hit.channel_name || '',
      })) : [emptyState('search', 'No messages found',
        'Nothing in the communities you are in matches that.')]));
    } catch (error) {
      results.replaceChildren(failure(error, run));
    }
  };

  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { run().catch(() => {}); }, 300);
  });
  run().catch(() => {});
}

// -- collections --------------------------------------------------------------

async function collections(host) {
  const card = cardOf('Collections', []);
  host.appendChild(card);
  const paint = async () => {
    card.replaceChildren(el('div', { class: 'm-kicker' }, 'Collections'), hold());
    try {
      const answer = await Api.collections();
      const rows = items((answer && answer.collections) || answer);
      card.replaceChildren(el('div', { class: 'm-kicker' }, 'Collections'),
        ...(rows.length ? rows.map((entry) => row({
          lead: el('span', { class: 'm-row__chevron' }, icon('folder', { size: 16 })),
          title: entry.name || 'A collection',
          sub: (entry.serverName || 'a community')
            + (entry.itemCount ? ' · ' + entry.itemCount + (entry.itemCount === 1 ? ' item' : ' items') : ''),
        })) : [emptyState('folder', 'No collections yet',
          'A collection is a named list you save things into. The desk console makes and fills them.')]));
    } catch (error) {
      card.replaceChildren(failure(error, paint));
    }
  };
  await paint();
}

// -- extensions ---------------------------------------------------------------

function extensions(host) {
  host.appendChild(cardOf('Extensions', [
    el('p', { class: 'm-sheet__note' },
      'The extension console — what may be installed, what is installed, and what it is allowed to do — is an operator surface. Open Trycord on a wider screen to manage it.'),
  ]));
}

// -- public documents ---------------------------------------------------------

function publicDoc(title, lede, actions, note) {
  const node = el('div', { class: 'm-stack' },
    el('div', { class: 'm-card' },
      el('div', { class: 'm-kicker' }, 'Document'),
      el('h2', { class: 'm-auth__title' }, title),
      el('p', { class: 'm-sheet__note' }, lede),
      el('div', { class: 'm-stack' }, actions),
      note ? el('p', { class: 'm-sheet__note' }, note) : null));
  return { raw: true, node };
}

const PAPERS = {
  terms: { path: '/terms', label: 'Terms of Service' },
  privacy: { path: '/privacy', label: 'Privacy Policy' },
  'instances-terms': { path: '/instances-terms', label: 'Official instance terms' },
  'trust-and-safety': { path: '/trust-and-safety', label: 'Trust & Safety' },
  security: { path: '/security', label: 'Security' },
  support: { path: '/support', label: 'Support' },
};

function docLink(label) {
  return el('a', {
    class: 'm-go m-go--block', href: publicPath(label.path),
  }, label.label);
}

export function renderSupport() {
  const instance = State.instance || {};
  const actions = [
    docLink(PAPERS.support),
    instance.supportUrl
      ? el('a', { class: 'm-go m-go--block', href: instance.supportUrl }, 'Contact the operators')
      : null,
    el('a', { class: 'm-go m-go--block', href: path('/login') }, 'Back to sign in'),
  ].filter(Boolean);
  return publicDoc('Support',
    'Trycord is self-hosted, so the people who can help are the people who run this instance.',
    actions);
}

export function renderLegal(ctx) {
  const asked = (ctx && ctx.params && ctx.params.doc) ? String(ctx.params.doc) : '';
  const known = PAPERS[asked] || null;
  const actions = [
    docLink(PAPERS.terms),
    docLink(PAPERS.privacy),
  ];
  const extra = known && known.path !== '/terms' && known.path !== '/privacy'
    ? docLink(known)
    : null;
  if (extra) actions.push(extra);
  return publicDoc(known ? known.label : 'Legal',
    'The terms and privacy policy for this instance are published on its public site.',
    actions,
    known ? null : 'Requested document: ' + asked);
}

// -- the sections the phone answers -------------------------------------------

const SECTIONS = {
  discover,
  search,
  collections,
  extensions,
};

export function renderMisc(ctx) {
  return consoleScreen(ctx.page.id, SECTIONS);
}
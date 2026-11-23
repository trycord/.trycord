// The remaining addresses the phone answers.
//
// The directory, discovery, search, the extension console and the public
// documents. Each is a real screen with the same rows and cards as the rest of
// the phone, reading the same API the desk reads.

import {
  el, icon, Api, toast, failed, hold, failure, emptyState,
  items, row, cardOf, fact, confirm, consoleScreen,
} from './kit.js';
import { State } from '../../../packages/store.js';
import { request } from '../../../packages/api.js';
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
        'No messages in your communities match.')]));
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

const EXT = '/api/extensions';

// The extension console, on a phone. The same four sections the desk opens,
// with the same server calls: what is offered, what is installed, what the
// operator allows, and the workflows that run.
async function extensions(host) {
  const tabs = el('div', { class: 'm-chips' });
  const stage = el('div', { class: 'm-stack' });
  host.append(tabs, stage);
  const sections = [['registry', 'Registry'], ['installed', 'Installed'], ['policy', 'Policy'], ['workflows', 'Workflows']];
  let active = 'registry';

  const paintTabs = () => {
    tabs.replaceChildren(...sections.map(([id, label]) => el('button', {
      class: 'm-chip' + (active === id ? ' m-chip--on' : ''),
      type: 'button',
      'aria-pressed': String(active === id),
      onClick: () => { active = id; paintTabs(); paint(); },
    }, label)));
  };

  const install = async (pkg) => {
    const wanted = (pkg.capabilities || pkg.requestedCapabilities || []).map((c) =>
      typeof c === 'string' ? c : (c.id || c.name || ''));
    if (!(await confirm({
      title: 'Install ' + (pkg.name || pkg.id) + '?',
      text: wanted.length ? 'It asks for: ' + wanted.join(', ') + '. Only install packages you trust.' : 'Only install packages you trust.',
      confirmLabel: 'Install',
    }))) return;
    try {
      const result = await request('POST', EXT + '/install', {
        body: { id: pkg.id, version: pkg.version || null, grants: wanted },
      });
      toast((result && result.granted ? result.granted.length + ' capabilities granted.' : 'Installed.'), { type: 'success' });
      await paint();
    } catch (error) { failed(error); }
  };

  const paint = async () => {
    stage.replaceChildren(hold());
    try {
      if (active === 'registry') {
        const answer = await request('GET', EXT + '/registry');
        const rows = items(answer.extensions || answer.packages || answer);
        stage.replaceChildren(cardOf('Available', rows.length
          ? rows.map((pkg) => row({
            lead: el('span', { class: 'm-row__chevron' }, icon('package', { size: 16 })),
            title: pkg.name || pkg.id,
            sub: pkg.version || (pkg.description || '').slice(0, 80),
            side: el('button', { class: 'm-go m-go--quiet', type: 'button', onClick: () => install(pkg) }, 'Install'),
          }))
          : [emptyState('package', 'No packages offered', 'This instance has no extension registry.')]));
      } else if (active === 'installed') {
        const answer = await request('GET', EXT + '/installed');
        const rows = items(answer.extensions || answer);
        stage.replaceChildren(cardOf('Installed', rows.length
          ? rows.map((ext) => row({
            title: ext.name || ext.id,
            sub: (ext.version || '') + (ext.enabled === false ? ' · off' : ' · on'),
            side: el('button', {
              class: 'm-go m-go--quiet', type: 'button',
              onClick: async () => {
                try {
                  await request('POST', EXT + '/' + encodeURIComponent(ext.id) + (ext.enabled === false ? '/enable' : '/disable'));
                  toast(ext.enabled === false ? 'On' : 'Off');
                  await paint();
                } catch (error) { failed(error); }
              },
            }, ext.enabled === false ? 'Turn on' : 'Turn off'),
          }))
          : [emptyState('package', 'Nothing installed', 'Packages you install show up here.')]));
      } else if (active === 'policy') {
        const answer = await request('GET', EXT + '/policy');
        const policy = (answer && answer.policy) || answer || {};
        stage.replaceChildren(cardOf('Policy', Object.entries(policy).map(([key, value]) =>
          fact(key, typeof value === 'object' ? JSON.stringify(value) : value))));
      } else {
        const answer = await request('GET', EXT + '/workflows');
        const rows = items(answer.workflows || answer);
        stage.replaceChildren(cardOf('Workflows', rows.length
          ? rows.map((flow) => row({
            title: flow.name || flow.id,
            sub: (flow.status || flow.state || '') + (flow.description ? ' · ' + flow.description.slice(0, 60) : ''),
          }))
          : [emptyState('activity', 'No workflows', 'Workflows this instance runs show up here.')]));
      }
    } catch (error) {
      stage.replaceChildren(failure(error, paint));
    }
  };

  paintTabs();
  await paint();
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
  return consoleScreen(ctx.page.id, SECTIONS, ctx);
}
// The tools the phone carries beyond the doors.
//
// The developer platform, the federation console, the status timeline, the
// instance directory, the finder and the public documents. One module because
// they are all the same kind of work: a screen that reads the server and lays
// its answer out in the phone's rows and cards.

import {
  el, clear, icon, Api, confirm, toast, failed, hold, failure, emptyState,
  items, when, statusWord, row, cardOf, fact, wordsSheet, formSheet,
  consoleScreen, describeValue,
} from './kit.js';
import { State } from '../../../packages/store.js';
import { request } from '../../../packages/api.js';
import { path, publicPath } from '../../../packages/nav.js';
import { renderPlaces } from './places.js';

const V1 = '/api/v1';

// -- the developer console: keys ----------------------------------------------

async function keys(host) {
  const card = cardOf('Your API keys', []);
  host.appendChild(card);

  const paint = async () => {
    card.replaceChildren(el('div', { class: 'm-kicker' }, 'Your API keys'), hold());
    try {
      const answer = await request('GET', V1 + '/keys');
      const keys_ = items(answer.keys || answer);
      card.replaceChildren(el('div', { class: 'm-kicker' }, 'Your API keys'),
        ...(keys_.length ? keys_.map((key) => row({
          lead: el('span', { class: 'm-row__chevron' }, icon('key', { size: 16 })),
          title: key.name || 'A key',
          sub: ((key.scopes && key.scopes.length ? key.scopes.join(', ') : 'no scopes')
            + (key.lastUsedAt || key.last_used_at ? ' · used ' + when(key.lastUsedAt || key.last_used_at) : '')),
          side: el('button', {
            class: 'm-go m-go--quiet', type: 'button', 'aria-label': 'Revoke the key',
            onClick: async () => {
              if (!(await confirm({ title: 'Revoke ' + (key.name || 'this key') + '?', text: 'Whatever speaks by it is refused from now on.', confirmLabel: 'Revoke', danger: true }))) return;
              const words = await new Promise((done) => wordsSheet({
                title: 'The reason it is revoked', fieldLabel: 'Reason', confirmLabel: 'Revoke', danger: true,
                placeholder: 'Why the key ends', required: false,
              }, done));
              await request('POST', V1 + '/keys/' + encodeURIComponent(key.id) + '/revoke', { body: { reason: words } });
              toast('The key is revoked');
              await paint();
            },
          }, 'Revoke'),
        })) : [emptyState('key', 'No keys yet', 'Apps use keys. Give each key only what it needs.')]));

      card.appendChild(row({
        title: 'Make a key', lead: el('span', { class: 'm-row__chevron' }, icon('plus', { size: 16 })), chevron: true,
        onClick: async () => {
          let scopes = [];
          try {
            const answer = await request('GET', V1 + '/scopes');
            scopes = items(answer.scopes || answer).map((scope) => typeof scope === 'string' ? scope : (scope.name || scope.id));
          } catch { /* the key can still be made with a scope typed by hand */ }
          await new Promise((done) => formSheet({
            title: 'A new key',
            note: "Copy the secret now. You won't see it again.",
            confirmLabel: 'Make the key',
          }, [
            ['Its name', el('input', { class: 'm-input', type: 'text', maxlength: '60', 'aria-label': 'The name of the key' })],
            ['Scopes, one per line', el('textarea', { class: 'm-area', rows: '4', 'aria-label': 'Scopes' },
              scopes.slice(0, 6).join('\n'))],
          ], done));
          const picks = document.querySelectorAll('.m-sheet input, .m-sheet textarea');
          const out = await request('POST', V1 + '/keys', {
            body: {
              name: picks[0].value.trim(),
              scopes: String(picks[1].value).split('\n').map((line) => line.trim()).filter(Boolean),
            },
          });
          const secret = out && (out.secret || (out.key && out.key.secret));
          toast('The key is made');
          host.appendChild(cardOf('The secret — shown once', [
            el('p', { class: 'm-sheet__note' }, secret || 'The instance did not return a secret; read it in the desk console.'),
          ]));
          await paint();
        },
      }));
    } catch (error) {
      card.replaceChildren(failure(error, paint));
    }
  };
  await paint();
}

// -- the developer console: applications --------------------------------------

async function applications(host) {
  const card = cardOf('Bot applications', []);
  host.appendChild(card);

  const paint = async () => {
    card.replaceChildren(el('div', { class: 'm-kicker' }, 'Bot applications'), hold());
    try {
      const mine = items(await Api.servers());
      const cards = [];
      for (const server of mine) {
        try {
          const answer = await request('GET', V1 + '/communities/' + encodeURIComponent(server.id) + '/applications');
          const apps = items(answer.applications || answer);
          for (const app of apps) {
            cards.push(row({
              lead: el('span', { class: 'm-row__chevron' }, icon('bot', { size: 16 })),
              title: app.name || 'An application',
              sub: 'in ' + (server.name || 'a community') + (app.bot ? ' · speaks as @' + (app.bot.username || 'itself') : ''),
            }));
          }
        } catch { /* a community this reader cannot read the applications of */ }
      }
      card.replaceChildren(el('div', { class: 'm-kicker' }, 'Bot applications'),
        ...(cards.length ? cards : [emptyState('bot', 'No applications yet',
          'An application speaks in a community under its own name. The desk console makes and manages them.')]));
    } catch (error) {
      card.replaceChildren(failure(error, paint));
    }
  };
  await paint();
}

async function documentation(host) {
  host.appendChild(cardOf('The API\'s own documents', [
    row({
      title: 'The OpenAPI description', lead: el('span', { class: 'm-row__chevron' }, icon('file-text', { size: 16 })), chevron: true,
      onClick: () => { window.open(location.origin + V1 + '/openapi.json', '_blank', 'noopener,noreferrer'); },
    }),
    row({
      title: 'The event stream\'s contract', lead: el('span', { class: 'm-row__chevron' }, icon('file-text', { size: 16 })), chevron: true,
      onClick: () => { window.open(location.origin + V1 + '/events', '_blank', 'noopener,noreferrer'); },
    }),
  ]));
}

// The desk answers the bare developer page and its three sections with the
// same console; the phone does the same, and the applications portal's five
// addresses ride the same screens with their own heading.
const PORTAL_NOTES = {
  'applications': 'The portal: the keys, the applications and the documents.',
  'applications.keys': 'The keys an integration speaks with.',
  'applications.applications': 'The applications of the communities here.',
  'applications.dashboard': 'The portal at a glance.',
  'applications.documentation': 'The API\'s own documents.',
  'developer': 'The developer console.',
  'developer.keys': 'The keys an integration speaks with.',
  'developer.applications': 'The applications of the communities here.',
  'developer.documentation': 'The API\'s own documents.',
};

function portalHome(section) {
  return async (host) => {
    const note = PORTAL_NOTES[section] || 'The developer console.';
    host.appendChild(cardOf('The developer platform', [
      el('p', { class: 'm-sheet__note' }, note),
      row({ title: 'API keys', lead: el('span', { class: 'm-row__chevron' }, icon('key', { size: 16 })), chevron: true, onClick: () => keys(host) }),
      row({ title: 'Applications', lead: el('span', { class: 'm-row__chevron' }, icon('bot', { size: 16 })), chevron: true, onClick: () => applications(host) }),
      row({ title: 'Documents', lead: el('span', { class: 'm-row__chevron' }, icon('file-text', { size: 16 })), chevron: true, onClick: () => documentation(host) }),
    ]));
    if (section.indexOf('keys') !== -1) await keys(host);
    else if (section.indexOf('applications') !== -1 && section !== 'applications') await applications(host);
    else if (section.indexOf('documentation') !== -1) await documentation(host);
  };
}

// -- federation ---------------------------------------------------------------

async function federation(host) {
  const outgoingCard = cardOf('What leaves', []);
  const peersCard = cardOf('The peers', []);
  const reportsCard = cardOf('Reports from peers', []);
  host.append(outgoingCard, peersCard, reportsCard);

  try {
    const rows = items(await Api.continuumOutgoing());
    outgoingCard.replaceChildren(el('div', { class: 'm-kicker' }, 'What leaves'),
      ...(rows.length ? rows.map((entry) => row({
        lead: el('span', { class: 'm-row__chevron' }, icon('send', { size: 16 })),
        title: entry.name || entry.communityId || 'A community',
        sub: 'to ' + (entry.instanceId || 'a peer') + (entry.lastSentAt ? ' · ' + when(entry.lastSentAt) : ''),
        side: el('button', {
          class: 'm-go m-go--quiet', type: 'button', 'aria-label': 'Stop sending',
          onClick: async () => {
            if (!(await confirm({ title: 'Stop sending this?', text: 'The peer stops receiving what happens here.', confirmLabel: 'Stop', danger: true }))) return;
            try {
              await Api.continuumDeleteOutgoing(entry.id);
              toast('Stopped');
              host.replaceChildren();
              await federation(host);
            } catch (error) { failed(error); }
          },
        }, 'Stop'),
      })) : [emptyState('send', 'Nothing leaves', 'Communities you share appear here.')]));
  } catch (error) {
    outgoingCard.replaceChildren(failure(error, () => { host.replaceChildren(); return federation(host); }));
  }

  try {
    const peers = items(await Api.continuumFederated());
    peersCard.replaceChildren(el('div', { class: 'm-kicker' }, 'The peers'),
      ...(peers.length ? peers.map((peer) => row({
        lead: el('span', { class: 'm-row__chevron' }, icon('globe', { size: 16 })),
        title: peer.name || peer.instanceId || 'A peer',
        sub: peer.status || '',
      })) : [emptyState('globe', 'No peers', 'Instances an operator added appear here.')]));
  } catch (error) {
    peersCard.replaceChildren(failure(error, () => { host.replaceChildren(); return federation(host); }));
  }

  try {
    const rows = items(await Api.myFederationReports());
    reportsCard.replaceChildren(el('div', { class: 'm-kicker' }, 'Reports from peers'),
      ...(rows.length ? rows.map((report) => row({
        lead: el('span', { class: 'm-row__chevron' }, icon('flag', { size: 16 })),
        title: report.reason || 'A report',
        sub: (report.instanceName || report.instanceId || '') + (report.createdAt ? ' · ' + when(report.createdAt) : ''),
        side: el('span', { class: 'm-row__note' }, statusWord(report.status)),
      })) : [emptyState('flag', 'Nothing from the peers', 'Reports from other sites appear here.')]));
  } catch (error) {
    reportsCard.replaceChildren(failure(error, () => { host.replaceChildren(); return federation(host); }));
  }
}

// -- status -------------------------------------------------------------------

async function status(host) {
  const card = cardOf('The timeline', []);
  host.appendChild(card);
  const paint = async () => {
    card.replaceChildren(el('div', { class: 'm-kicker' }, 'The timeline'), hold());
    try {
      const answer = await Api.incidentStatus({ limit: 50 });
      const rows = items(answer.incidents || answer);
      card.replaceChildren(el('div', { class: 'm-kicker' }, 'The timeline'),
        ...(rows.length ? rows.map((entry) => row({
          lead: el('span', { class: 'm-row__chevron' }, icon('activity', { size: 16 })),
          title: entry.title || 'An entry',
          sub: String(entry.body || '').slice(0, 120) + (entry.createdAt ? ' · ' + when(entry.createdAt) : ''),
          side: el('span', { class: 'm-row__note' }, statusWord(entry.status || entry.kind)),
        })) : [emptyState('activity', 'Nothing on the timeline', 'Outages and updates appear here.')]));
    } catch (error) {
      card.replaceChildren(failure(error, paint));
    }
  };
  await paint();
}

// -- the instance directory ---------------------------------------------------

async function instances(host) {
  const card = cardOf('Other instances', []);
  host.appendChild(card);
  const paint = async () => {
    card.replaceChildren(el('div', { class: 'm-kicker' }, 'Other instances'), hold());
    try {
      const rows = items(await Api.discoverInstances());
      card.replaceChildren(el('div', { class: 'm-kicker' }, 'Other instances'),
        ...(rows.length ? rows.map((instance) => row({
          lead: el('span', { class: 'm-row__chevron' }, icon('server', { size: 16 })),
          title: instance.name || instance.instanceId || 'An instance',
          sub: instance.description || instance.url || '',
        })) : [emptyState('server', 'No instances listed', 'The directory knows none, or this instance does not federate.')]));
    } catch (error) {
      card.replaceChildren(failure(error, paint));
    }
  };
  await paint();
}

const SECTIONS = {
  'developer': portalHome('developer'),
  'developer.keys': portalHome('developer.keys'),
  'developer.applications': portalHome('developer.applications'),
  'developer.documentation': portalHome('developer.documentation'),
  'applications': portalHome('applications'),
  'applications.keys': portalHome('applications.keys'),
  'applications.applications': portalHome('applications.applications'),
  'applications.dashboard': portalHome('applications.dashboard'),
  'applications.documentation': portalHome('applications.documentation'),
  'federation': federation,
  'status': status,
  'instances': instances,
};

export function renderConsole(ctx) {
  return consoleScreen(ctx.page.id, SECTIONS, ctx);
}
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

const MISC_SECTIONS = {
  discover,
  search,
  collections,
  extensions,
};

export function renderMisc(ctx) {
  return consoleScreen(ctx.page.id, MISC_SECTIONS, ctx);
}

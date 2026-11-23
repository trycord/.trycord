// The operator's and the developer's consoles on the phone.
//
// The developer platform (API keys, bot applications, the API's own
// documents), the federation console (what leaves, what arrives, the peers
// it travels to), the public status timeline, and the instance directory.
// The same API the desk reads, drawn as a phone reads it.

import {
  el, clear, icon, Api, confirm, toast, failed, hold, failure, emptyState,
  items, when, statusWord, row, cardOf, fact, wordsSheet, formSheet,
  consoleScreen, isOperator, refusal, describeValue,
} from './kit.js';
import { State } from '../../../packages/store.js';
import { request } from '../../../packages/api.js';

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
        })) : [emptyState('key', 'No keys yet', 'An integration that speaks for you needs a key, with only the scopes it needs.')]));

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
            note: 'The secret is shown once, when the key is made. It is never shown again.',
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
      })) : [emptyState('send', 'Nothing leaves', 'A community signed to travel appears here.')]));
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
      })) : [emptyState('flag', 'Nothing from the peers', 'Reports other instances filed with this one appear here.')]));
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
        })) : [emptyState('activity', 'Nothing on the timeline', 'Incidents and maintenance appear here as they happen.')]));
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
  return consoleScreen(ctx.page.id, SECTIONS);
}

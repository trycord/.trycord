// Localisation: the reader's preference, and the formatting that follows it.
//
// The preference is the reader's own and the server keeps it. The catalogue is
// the server's too, and the dates and numbers are written the way the locale
// writes them - so a pack that changes the language changes the way a date
// reads as well.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from './helpers/dom-stub.js';

installDomStub();

const { setToken } = await import('../packages/api.js');
const locale = await import('../packages/locale.js');
const { languageView } = await import('../js/features/settingsLanguage.js');
const { dayLabel, shortDate } = await import('../packages/format.js');

function find(node, predicate, found = []) {
  if (!node) return found;
  if (Array.isArray(node)) {
    for (const entry of node) find(entry, predicate, found);
    return found;
  }
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

function classed(word) {
  return (node) => {
    const value = node.getAttribute && node.getAttribute('class');
    return !!value && value.split(/\s+/).indexOf(word) !== -1;
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CATALOGUE = {
  locale: 'fr',
  source: 'reader',
  pack: { locale: 'fr', version: '1.0.0' },
  locales: [{ locale: 'fr', version: '1.0.0', scope: 'instance' }],
  strings: {
    'nav.messages': 'Messages',
    'date.today': "Aujourd'hui",
    'date.yesterday': 'Hier',
  },
};

test('the preference is kept by the server and the catalogue comes back', async () => {
  setToken('reader-a');
  const calls = installFetchStub({
    'http://localhost/api/localisation': { json: CATALOGUE },
    'http://localhost/api/localisation/preference': { json: { locale: 'fr' } },
  });

  await locale.setPreference('fr');
  await wait(20);

  const put = calls.find((call) => call.url.indexOf('/api/localisation/preference') !== -1
    && call.options.method === 'PUT');
  assert.ok(put, 'the preference was never sent');
  assert.deepEqual(put.body, { locale: 'fr' });

  assert.equal(locale.currentLocale(), 'fr', 'the locale in force did not change');
  assert.equal(locale.currentSource(), 'reader');
  assert.equal(locale.t('date.today', 'Today'), "Aujourd'hui", 'the pack\'s string was not used');
});

test('the formatting follows the locale', async () => {
  setToken('reader-a');
  installFetchStub({
    'http://localhost/api/localisation': { json: CATALOGUE },
    'http://localhost/api/localisation/preference': { json: { locale: 'fr' } },
  });
  await locale.loadLocale();
  await wait(10);

  const written = locale.formatDate(new Date('2026-01-15T12:00:00Z'), {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
  assert.match(written, /janvier/, 'the date was not written in French');
  assert.match(written, /2026/);

  const number = locale.formatNumber(1234.5);
  assert.match(number, /234/, 'the number was not written');
  assert.match(number, /,5/, 'the number was not written the French way');
});

test('the day labels come from the pack', async () => {
  setToken('reader-a');
  installFetchStub({
    'http://localhost/api/localisation': { json: CATALOGUE },
    'http://localhost/api/localisation/preference': { json: { locale: 'fr' } },
  });
  await locale.loadLocale();
  await wait(10);

  assert.equal(dayLabel(new Date()), "Aujourd'hui");
  assert.equal(dayLabel(new Date(Date.now() - 86400000)), 'Hier');
  assert.match(shortDate(new Date('2026-01-15T12:00:00Z')), /janv/);
});

test('the language page offers the languages the instance has', async () => {
  setToken('reader-a');
  const calls = installFetchStub({
    'http://localhost/api/localisation/locales': { json: [{ locale: 'fr', version: '1.0.0', scope: 'instance' }] },
    'http://localhost/api/localisation/preference': { json: { locale: 'fr' } },
    'http://localhost/api/localisation': { json: CATALOGUE },
  });

  const view = languageView();
  await view.onMount();
  await wait(20);

  const text = view.node.textContent || '';
  assert.match(text, /fr/, 'the language was not offered');
  assert.match(text, /The instance default/, 'the instance default was not offered');

  const rows = find(view.node, classed('language-row'));
  assert.equal(rows.length, 2, 'the wrong number of languages was offered');
  assert.ok(calls.some((call) => call.url.indexOf('/api/localisation/locales') !== -1),
    'the languages were never read');
});

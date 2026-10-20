// The search filter language, and the searches a reader keeps.
//
// The parser is the platform's, so the command palette and the search panel
// mean the same thing by a typed filter. The saved searches belong to the
// reader: the client asks for its own list and never names another reader.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub, waitFor } from './helpers/dom-stub.js';

installDomStub();

const {
  parseQuery, parseFilter, buildQuery, filterChips, filterSuggestions, checkFilterValue,
  listSaved, saveSearch, removeSaved, listHistory, clearHistory,
} = await import('../packages/search.js');
const { setToken } = await import('../packages/api.js');
const { renderSearch } = await import('../js/features/search.js');
const { openPalette } = await import('../js/shell/palette.js');

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

test('every filter is read the way the server reads it', () => {
  const parsed = parseQuery('release notes from:ada in:general before:2026-01-01 after:2025-12-01 has:file type:image is:unread');
  assert.deepEqual(parsed.terms, ['release', 'notes']);
  assert.equal(parsed.filters.from, 'ada');
  assert.equal(parsed.filters.in, 'general');
  assert.equal(parsed.filters.before, '2026-01-01');
  assert.equal(parsed.filters.after, '2025-12-01');
  assert.equal(parsed.filters.has, 'file');
  assert.equal(parsed.filters.type, 'image');
  assert.equal(parsed.filters.is, 'unread');
  assert.equal(parsed.hasFilters, true);
});

test('a quoted value carries a space', () => {
  const parsed = parseQuery('in:"general chat" release');
  assert.equal(parsed.filters.in, 'general chat');
  assert.deepEqual(parsed.terms, ['release']);
});

test('a word that is not a filter is a search term', () => {
  const parsed = parseQuery('colour:blue https://example.dev/thing');
  assert.deepEqual(parsed.filters, {});
  assert.deepEqual(parsed.terms, ['colour:blue', 'https://example.dev/thing']);
  assert.equal(parsed.hasFilters, false);
});

test('a filter this build knows but does not accept is refused', () => {
  assert.throws(() => parseQuery('type:audio'), (error) => {
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.match(error.message, /not one of/);
    return true;
  });
  assert.throws(() => parseQuery('before:yesterday'), (error) => {
    assert.equal(error.code, 'VALIDATION_ERROR');
    return true;
  });
});

test('a filter given twice keeps the last value', () => {
  const parsed = parseQuery('from:ada from:rin');
  assert.equal(parsed.filters.from, 'rin');
});

test('the chips carry the filters as they were written', () => {
  const parsed = parseQuery('from:ada before:2026-01-01');
  const chips = filterChips(parsed.filters);
  assert.deepEqual(chips.map((chip) => chip.text), ['from:ada', 'before:2026-01-01']);
  assert.equal(buildQuery(parsed.terms, parsed.filters), 'from:ada before:2026-01-01');
});

test('the suggestions offer the keys and the values they accept', () => {
  const list = filterSuggestions('type');
  assert.ok(list.some((entry) => entry.key === 'type' && entry.value === 'image'));
  assert.ok(list.some((entry) => entry.key === 'type' && entry.value === 'code'));
  assert.ok(!list.some((entry) => entry.key === 'from'), 'a key that does not match was offered');
});

test('a filter is read on its own', () => {
  assert.deepEqual(parseFilter('from:ada'), { key: 'from', value: 'ada' });
  assert.equal(parseFilter('ada'), null);
  assert.equal(parseFilter('from:ada in:general'), null);
  assert.equal(checkFilterValue('has', 'file'), 'file');
});

// -- the two places the query is read ----------------------------------------

test('the palette and the search panel read the same query', async () => {
  const calls = installFetchStub({
    'http://localhost/api/search?q=from%3Aada+release&limit=12': { json: [] },
    'http://localhost/api/users/search?q=from%3Aada+release': { json: [] },
  });

  const palette = openPalette();
  const input = find(palette.element, classed('palette-input'))[0];
  assert.ok(input, 'the palette has no search field');
  input.value = 'from:ada release';
  input.dispatch('input', {});

  // The palette keeps the filters as filters and says so.
  const chips = await waitFor(() => {
    const found = find(palette.element, classed('palette-item-hint'))
      .map((node) => node.textContent);
    return found.some((text) => String(text).indexOf('from:ada') !== -1) ? found : null;
  });
  assert.ok(chips, 'the palette did not show the filter it had read');

  // And the search it runs carries the whole query, filters and all.
  const asked = await waitFor(() => calls.find((call) => call.url.indexOf('/api/search?') !== -1));
  assert.ok(asked, 'the palette did not search');
  assert.match(asked.url, /from%3Aada/);

  const page = renderSearch({
    page: { id: 'search' },
    query: new URLSearchParams('q=from%3Aada release'),
    params: {},
    rest: [],
  });
  const field = find(page.node, classed('search-input'))[0];
  assert.equal(field.value, 'release', 'the panel did not split the query the same way');
  const chip = find(page.node, classed('filter-chip-text'))[0];
  assert.equal(chip.textContent, 'from:ada', 'the panel did not make the same filter');

  palette.close();
});

// -- the searches the reader keeps -------------------------------------------

test('the saved searches are listed', async () => {
  setToken('reader-a');
  installFetchStub({
    'http://localhost/api/search/saved': {
      json: [
        { id: 's1', name: 'Ada on releases', query: 'from:ada release' },
        { id: 's2', name: 'Files', query: 'has:file' },
      ],
    },
    'http://localhost/api/search/history': { json: [] },
    'http://localhost/api/search?q=release&limit=25': { json: [] },
  });

  const page = renderSearch({ page: { id: 'search' }, query: new URLSearchParams(), params: {}, rest: [] });
  await page.onMount();

  const drawn = await waitFor(() => {
    const text = page.node.textContent || '';
    return text.indexOf('Ada on releases') !== -1 ? text : null;
  });
  assert.ok(drawn, 'the saved searches were not drawn');
  assert.match(drawn, /Files/);
});

test('a search is saved from the query that is in front of the reader', async () => {
  setToken('reader-a');
  const calls = installFetchStub({
    'http://localhost/api/search/saved': { json: [] },
    'http://localhost/api/search/history': { json: [] },
    'http://localhost/api/search?q=release+from%3Aada&limit=25': { json: [] },
  });

  const page = renderSearch({
    page: { id: 'search' },
    query: new URLSearchParams('q=from%3Aada release'),
    params: {},
    rest: [],
  });
  await page.onMount();

  const save = await waitFor(() => find(page.node, (node) => node.tagName === 'BUTTON'
    && String(node.textContent).indexOf('Save this search') !== -1)[0]);
  assert.ok(save, 'there is no way to save the search');
  save.click();

  const form = await waitFor(() => {
    const dialog = find(document.body, classed('dialog'))
      .filter((node) => String(node.textContent).indexOf('Save this search') !== -1)[0];
    if (!dialog) return null;
    return find(dialog, (node) => node.tagName === 'FORM')[0];
  });
  assert.ok(form, 'saving a search opened no dialog');
  const dialog = form.parentNode;
  const name = find(dialog, (node) => node.tagName === 'INPUT')[0];
  name.value = 'Ada on releases';
  form.submit();

  const posted = await waitFor(() => calls.find((call) => call.url.indexOf('/api/search/saved') !== -1
    && call.options.method === 'POST'));
  assert.ok(posted, 'the search was never saved');
  assert.deepEqual(posted.body, { name: 'Ada on releases', query: 'release from:ada' });
});

test('the saved searches belong to the reader who asks for them', async () => {
  setToken('reader-a');
  const calls = installFetchStub({
    'http://localhost/api/search/saved': { json: [] },
    'http://localhost/api/search/history': { json: [] },
    'http://localhost/api/search?q=release&limit=25': { json: [] },
  });

  await listSaved();
  await saveSearch('Mine', 'release');
  await removeSaved('s1');
  await listHistory();
  await clearHistory();

  const owner = calls.filter((call) => call.url.indexOf('/api/search/saved') !== -1
    || call.url.indexOf('/api/search/history') !== -1);
  assert.ok(owner.length >= 4, 'the reader\'s own lists were not asked for');
  for (const call of owner) {
    assert.ok(call.options.headers.Authorization, 'a saved search was asked for without the session');
    assert.equal(call.url.indexOf('user='), -1, 'the client named a reader');
    assert.equal(call.url.indexOf('owner='), -1, 'the client named a reader');
  }
});

// The search panel, on a phone.
//
// The words to look for, the filters to narrow by, the searches the reader has
// saved and the queries they have run lately.
//
// The filter language is the platform's (packages/search.js) - the same parser
// the command palette and the desktop panel use - so `from:ada` means the same
// thing everywhere.
//
// A phone has no room for a field beside a list of results, so the filters live
// in a sheet that comes up from the edge a thumb can reach, and the chips that
// are in force stay on the screen above the results.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import {
  parseQuery, parseFilter, checkFilterValue, buildQuery, filterChips, filterSuggestions,
  listSaved, saveSearch, removeSaved, listHistory, clearHistory, removeHistoryEntry,
} from '../../../packages/search.js';
import { empty, loading, failure, iconButton } from '../components.js';
import { screen, section, actions, primaryButton, notice } from './util.js';
import { sheet, toast } from '../ui.js';
import { relativeTime } from '../../../packages/format.js';

const DEBOUNCE_MS = 260;
const MIN_LENGTH = 2;

function stateFrom(text) {
  const parsed = parseQuery(text);
  return { terms: parsed.terms.join(' '), filters: parsed.filters };
}

// One filter, as the chip that carries it. The chip keeps the value as it was
// written, so the query that goes back to the server is the one the reader
// typed.
function filterChip(chip, onRemove) {
  return el('span', { class: 'm-filter-chip' },
    el('span', { class: 'm-filter-chip-text' }, chip.text),
    el('button', {
      class: 'm-filter-chip-remove', type: 'button',
      'aria-label': 'Remove the filter ' + chip.text,
      onClick: () => onRemove(chip.key),
    }, icon('x', { size: 12 })));
}

// The sheet where a filter is written.
//
// The suggestions are the keys this build knows and the values each of them
// accepts, so a filter that the server would refuse is not offered as one.
function filterSheet(state, onApplied) {
  const field = el('input', {
    class: 'm-input', type: 'text', placeholder: 'from:ada',
    'aria-label': 'Add a filter', autocomplete: 'off', spellcheck: 'false',
  });
  const suggestions = el('div', { class: 'm-list' });
  const note = el('p', { class: 'm-notice__text' });

  const layer = sheet({
    title: 'Filters',
    body: el('div', { class: 'm-stack' },
      field,
      suggestions,
      note),
    footer: actions([
      primaryButton('Add filter', apply, { block: true }),
    ]),
  });

  function paintSuggestions() {
    const typed = field.value.trim();
    clear(suggestions);
    if (!typed) return;
    const list = filterSuggestions(typed).slice(0, 8);
    for (const entry of list) {
      suggestions.appendChild(el('button', {
        class: 'm-row', type: 'button',
        onClick: () => {
          field.value = entry.key + ':' + (entry.value || '');
          field.focus();
        },
      },
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title' }, entry.key + (entry.value ? ':' + entry.value : '')),
        el('span', { class: 'm-row__sub' }, entry.label + ' · ' + entry.hint))));
    }
  }

  function apply() {
    const text = field.value.trim();
    if (!text) return;
    const parsed = parseFilter(text);
    if (!parsed) {
      note.textContent = 'That is not a filter. Write it as from:ada.';
      return;
    }
    try {
      checkFilterValue(parsed.key, parsed.value);
    } catch (error) {
      note.textContent = error.message;
      return;
    }
    note.textContent = '';
    state.filters = Object.assign({}, state.filters, { [parsed.key]: parsed.value });
    layer.close();
    onApplied();
  }

  field.addEventListener('input', paintSuggestions);
  return layer;
}

export function renderSearch(ctx) {
  const initial = (ctx.query && ctx.query.get('q')) || '';
  // A query the server would refuse is refused here too, with the same
  // words, rather than opening a screen that cannot be drawn.
  let state = { terms: '', filters: {} };
  let problem = null;
  try {
    state = stateFrom(initial);
  } catch (error) {
    problem = error.message;
    state = { terms: initial, filters: {} };
  }

  const input = el('input', {
    class: 'm-input', type: 'search', placeholder: 'Search messages',
    'aria-label': 'Search messages', autocomplete: 'off', spellcheck: 'false',
  });
  input.value = state.terms;

  const chips = el('div', { class: 'm-filter-chips' });
  const results = el('div', { class: 'm-list' });
  const saved = el('div', { class: 'm-list' });
  const history = el('div', { class: 'm-list' });
  const note = el('p', { class: 'm-notice__text' });

  const host = el('div', { class: 'm-stack' });
  const node = screen(
    el('div', { class: 'm-hero m-hero--quiet' },
      el('h1', { class: 'm-hero__title' }, 'Search'),
      el('div', { class: 'm-hero__sub' }, 'What has been said, and where.')),
    host);

  let timer = null;
  let generation = 0;

  function queryText() {
    return buildQuery(state.terms.split(/\s+/).filter(Boolean), state.filters);
  }

  function paintChips() {
    clear(chips);
    for (const chip of filterChips(state.filters)) {
      chips.appendChild(filterChip(chip, (key) => {
        const next = Object.assign({}, state.filters);
        delete next[key];
        state.filters = next;
        paintChips();
        run();
      }));
    }
  }

  function applyQuery(text) {
    const parsed = stateFrom(text);
    state.terms = parsed.terms;
    state.filters = parsed.filters;
    input.value = state.terms;
    paintChips();
    run();
  }

  async function run() {
    const query = queryText();
    if (query.length < MIN_LENGTH) {
      clear(results);
      if (problem) {
        results.appendChild(notice({ tone: 'danger', title: 'That query was refused', text: problem }));
        return;
      }
      results.appendChild(empty({
        icon: 'search',
        title: 'Type to search',
        text: 'Two characters or more, and the instance answers from the communities you are in.',
      }));
      return;
    }
    const mine = ++generation;
    clear(results);
    results.appendChild(loading('Searching'));
    try {
      const rows = await Api.search(query, { limit: 25 });
      if (mine !== generation) return;
      const hits = Array.isArray(rows) ? rows : [];
      clear(results);
      if (!hits.length) {
        results.appendChild(empty({
          icon: 'search',
          title: 'No messages found',
          text: 'Nothing in the communities you are in matches that.',
        }));
        return;
      }
      for (const hit of hits) {
        const isDocument = hit.kind === 'document';
        const where = isDocument
          ? (hit.server_name || 'a community')
          : '#' + (hit.channel_name || 'channel');
        const author = hit.author_display || hit.author_name || '';
        results.appendChild(el('a', {
          class: 'm-row', href: isDocument
            ? '/server/' + hit.server_id
            : '/server/' + hit.server_id + '/channel/' + hit.channel_id,
        },
        el('span', { class: 'm-row__lead' }, icon(isDocument ? 'file' : 'message', { size: 17 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title truncate' },
            (isDocument ? hit.title : String(hit.content || '').replace(/\s+/g, ' ').trim()) || '(an attachment)'),
          el('span', { class: 'm-row__sub truncate' }, [author, where].filter(Boolean).join(' · ')))));
      }
      note.textContent = hits.length + (hits.length === 1 ? ' result' : ' results');
    } catch (error) {
      if (mine !== generation) return;
      clear(results);
      results.appendChild(failure(error, () => run()));
    }
  }

  async function paintSaved() {
    try {
      const rows = await listSaved();
      const entries = Array.isArray(rows) ? rows : [];
      clear(saved);
      if (!entries.length) {
        saved.appendChild(empty({
          icon: 'pin',
          title: 'No saved searches',
          text: 'Save a search and it waits here, filters and all.',
        }));
        return;
      }
      for (const entry of entries) {
        saved.appendChild(el('div', { class: 'm-row' },
          el('button', {
            class: 'm-row__body m-row__body--button', type: 'button',
            onClick: () => applyQuery(entry.query),
          },
          el('span', { class: 'm-row__title' }, entry.name),
          el('span', { class: 'm-row__sub truncate' }, entry.query)),
          el('span', { class: 'm-row__actions' },
            iconButton('trash', 'Remove the saved search ' + entry.name, async () => {
              try {
                await removeSaved(entry.id);
                toast('Saved search removed.', { type: 'success' });
                paintSaved();
              } catch (error) { toast(error.message, { type: 'danger' }); }
            }))));
      }
    } catch (error) {
      clear(saved);
      saved.appendChild(failure(error, paintSaved));
    }
  }

  function openSaveDialog() {
    const query = queryText();
    if (!query) {
      toast('Search for something first, then save it.', { type: 'danger' });
      return;
    }
    const name = el('input', {
      class: 'm-input', type: 'text', 'aria-label': 'The name of the saved search',
      placeholder: 'Release notes from Ada',
    });
    const layer = sheet({
      title: 'Save this search',
      body: el('div', { class: 'm-stack' },
        el('p', { class: 'm-lede' }, query),
        el('label', { class: 'm-field' },
          el('span', { class: 'm-field__label' }, 'Name'),
          name)),
      footer: actions([
        primaryButton('Save', async () => {
          try {
            await saveSearch(name.value, query);
            layer.close();
            toast('Search saved.', { type: 'success' });
            paintSaved();
          } catch (error) { toast(error.message, { type: 'danger' }); }
        }, { block: true }),
      ]),
    });
  }

  async function paintHistory() {
    try {
      const rows = await listHistory();
      const entries = Array.isArray(rows) ? rows : [];
      clear(history);
      if (!entries.length) {
        history.appendChild(empty({
          icon: 'clock',
          title: 'Nothing searched yet',
          text: 'The queries you run are kept here, and you can clear them.',
        }));
        return;
      }
      for (const entry of entries) {
        history.appendChild(el('div', { class: 'm-row' },
          el('button', {
            class: 'm-row__body m-row__body--button', type: 'button',
            onClick: () => applyQuery(entry.query),
          },
          el('span', { class: 'm-row__title truncate' }, entry.query),
          el('span', { class: 'm-row__sub' }, relativeTime(entry.createdAt))),
          el('span', { class: 'm-row__actions' },
            iconButton('x', 'Forget the search ' + entry.query, async () => {
              try {
                await removeHistoryEntry(entry.id);
                paintHistory();
              } catch (error) { toast(error.message, { type: 'danger' }); }
            }))));
      }
    } catch (error) {
      clear(history);
      history.appendChild(failure(error, paintHistory));
    }
  }

  input.addEventListener('input', () => {
    state.terms = input.value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  });

  paintChips();

  const filterButton = el('button', {
    class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
    onClick: () => filterSheet(state, () => { paintChips(); run(); }),
  }, icon('filter', { size: 16 }), 'Filters');

  const saveButton = el('button', {
    class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
    onClick: openSaveDialog,
  }, icon('pin', { size: 16 }), 'Save');

  const clearButton = el('button', {
    class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
    onClick: async () => {
      try {
        await clearHistory();
        toast('Search history cleared.', { type: 'success' });
        paintHistory();
      } catch (error) { toast(error.message, { type: 'danger' }); }
    },
  }, 'Clear');

  host.append(
    section('Search', el('div', { class: 'm-stack' },
      input,
      el('div', { class: 'm-filter-bar' }, chips, filterButton, saveButton),
      note)),
    section('Results', results),
    section('Saved searches', saved),
    section('Recent searches', history, { action: clearButton }));

  return {
    node,
    head: { title: 'Search' },
    onMount: async () => {
      paintSaved();
      paintHistory();
      await run();
    },
    cleanup() {
      if (timer) clearTimeout(timer);
    },
  };
}

export default { renderSearch };

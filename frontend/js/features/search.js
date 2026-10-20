// The search panel.
//
// One place to look for what has been said: the words to look for, the filters
// to narrow by, the searches the reader has saved and the queries they have
// run lately.
//
// The filter language is the platform's (packages/search.js) - the same parser
// the command palette uses - so `from:ada` means the same thing in both
// places, and a filter the server would refuse is refused here first with the
// same words.
//
// The saved searches and the recent queries belong to the reader: the server
// answers them from the owner, so this screen only ever asks for its own.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import {
  parseQuery, parseFilter, checkFilterValue, buildQuery, filterChips, filterSuggestions,
  listSaved, saveSearch, renameSaved, removeSaved,
  listHistory, clearHistory, removeHistoryEntry,
} from '../../packages/search.js';
import { head, card, row, blank, fault, fold, hold } from '../ui/page.js';
import { openDialog, confirmDialog, errorToast, toast } from '../ui/overlays.js';
import { path } from '../../packages/nav.js';
import { relativeTime } from '../../packages/format.js';

const DEBOUNCE_MS = 240;
const MIN_LENGTH = 2;

// The words and the filters, and the query they make.
function stateFrom(text) {
  const parsed = parseQuery(text);
  return { terms: parsed.terms.join(' '), filters: parsed.filters };
}

// One filter, as the chip that carries it. The chip keeps the value as it was
// written, so the query that goes back to the server is the one the reader
// typed.
function chipFor(key, value, onRemove) {
  return el('span', { class: 'filter-chip' },
    el('span', { class: 'filter-chip-text' }, key + ':' + value),
    el('button', {
      class: 'filter-chip-remove', type: 'button',
      'aria-label': 'Remove the filter ' + key + ':' + value,
      onClick: () => onRemove(key),
    }, icon('x', { size: 12 })));
}

// The filter bar: the chips that are in force, the field a new one is written
// in, and the suggestions that field offers.
function filterBar(state, onChange) {
  const chips = el('div', { class: 'filter-chips' });
  const suggestions = el('ul', {
    class: 'filter-suggestions', role: 'listbox', 'aria-label': 'Filter suggestions',
    hidden: 'true',
  });
  const field = el('input', {
    class: 'input filter-field', type: 'text',
    placeholder: 'from:ada', 'aria-label': 'Add a filter',
    autocomplete: 'off', spellcheck: 'false',
  });
  const note = el('p', { class: 'filter-note', role: 'status', 'aria-live': 'polite' });

  const remove = (key) => {
    const next = Object.assign({}, state.filters);
    delete next[key];
    state.filters = next;
    onChange();
  };

  function paintChips() {
    chips.replaceChildren(...filterChips(state.filters).map((chip) =>
      chipFor(chip.key, chip.value, remove)));
  }

  function paintSuggestions() {
    const typed = field.value.trim();
    if (!typed) {
      suggestions.replaceChildren();
      suggestions.hidden = true;
      return;
    }
    const list = filterSuggestions(typed).slice(0, 8);
    if (!list.length) {
      suggestions.replaceChildren();
      suggestions.hidden = true;
      return;
    }
    suggestions.replaceChildren(...list.map((entry) => el('li', {
      class: 'filter-suggestion', role: 'option', 'aria-selected': 'false',
    },
    el('button', {
      class: 'filter-suggestion-button', type: 'button',
      onClick: () => {
        field.value = entry.key + ':' + (entry.value || '');
        field.focus();
        paintSuggestions();
      },
    },
    el('span', { class: 'filter-suggestion-key' }, entry.key),
    el('span', { class: 'filter-suggestion-label' }, entry.label),
    entry.value ? el('span', { class: 'filter-suggestion-value' }, entry.value) : null,
    el('span', { class: 'filter-suggestion-hint' }, entry.hint)))));
    suggestions.hidden = false;
  }

  function apply() {
    const text = field.value.trim();
    if (!text) return;
    const parsed = parseFilter(text);
    if (!parsed) {
      note.textContent = 'That is not a filter. Write it as from:ada.';
      note.classList.add('is-warn');
      return;
    }
    try {
      checkFilterValue(parsed.key, parsed.value);
    } catch (error) {
      note.textContent = error.message;
      note.classList.add('is-warn');
      return;
    }
    note.textContent = '';
    note.classList.remove('is-warn');
    state.filters = Object.assign({}, state.filters, { [parsed.key]: parsed.value });
    field.value = '';
    paintSuggestions();
    onChange();
  }

  field.addEventListener('input', paintSuggestions);
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    apply();
  });
  field.addEventListener('blur', () => { suggestions.hidden = true; });

  paintChips();

  return {
    node: el('div', { class: 'filter-bar' },
      chips,
      el('div', { class: 'filter-row' },
        field,
        el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          onClick: apply,
        }, 'Add filter')),
      suggestions,
      note),
    paintChips,
    focus() { field.focus(); },
  };
}

// The result of one search: a message, or a document.
function hitRow(hit) {
  const isDocument = hit.kind === 'document';
  const author = hit.author_display || hit.author_name || '';
  const where = isDocument
    ? (hit.server_name || 'a community')
    : '#' + (hit.channel_name || 'channel');
  const route = isDocument
    ? '/server/' + hit.server_id
    : '/server/' + hit.server_id + '/channel/' + hit.channel_id;
  const text = isDocument ? hit.title : String(hit.content || '').replace(/\s+/g, ' ').trim();

  return row({
    link: true,
    href: path(route),
    class: 'search-hit',
    lead: el('span', { class: 'search-hit-glyph' }, icon(isDocument ? 'file' : 'message', { size: 15 })),
    title: text || '(an attachment)',
    sub: [author, where].filter(Boolean).join(' · '),
    meta: hit.created_at ? relativeTime(hit.created_at) : '',
  });
}

export function renderSearch(ctx) {
  const initial = (ctx.query && ctx.query.get('q')) || '';
  // A query the server would refuse is refused here too, with the same
  // words, rather than opening a page that cannot be drawn.
  let state = { terms: '', filters: {} };
  let problem = null;
  try {
    state = stateFrom(initial);
  } catch (error) {
    problem = error.message;
    state = { terms: initial, filters: {} };
  }

  const input = el('input', {
    class: 'input search-input', type: 'search',
    placeholder: 'Search messages',
    'aria-label': 'Search messages',
    autocomplete: 'off', spellcheck: 'false',
  });
  input.value = state.terms;

  const results = el('div', { class: 'search-results' });
  const resultNote = el('p', { class: 'search-note', role: 'status', 'aria-live': 'polite' });

  const savedList = el('div', { class: 'rowlist' });
  const historyList = el('div', { class: 'rowlist' });

  const bar = filterBar(state, () => { run(); });

  function queryText() {
    return buildQuery(state.terms.split(/\s+/).filter(Boolean), state.filters);
  }

  function applyQuery(text) {
    const parsed = stateFrom(text);
    state.terms = parsed.terms;
    state.filters = parsed.filters;
    input.value = state.terms;
    bar.paintChips();
    run();
  }

  // -- the results ------------------------------------------------------------

  let generation = 0;
  let timer = null;

  async function run() {
    const query = queryText();
    if (query.length < MIN_LENGTH) {
      results.replaceChildren(blank({
        glyph: 'search',
        title: 'Type to search',
        text: 'Two characters or more, and the instance answers from the communities you are in.',
      }));
      resultNote.textContent = '';
      return;
    }
    const mine = ++generation;
    results.replaceChildren(hold('Searching'));
    try {
      const rows = await Api.search(query, { limit: 25 });
      if (mine !== generation) return;
      const hits = Array.isArray(rows) ? rows : [];
      results.replaceChildren(...(hits.length
        ? hits.map(hitRow)
        : [blank({
          glyph: 'search',
          title: 'No messages found',
          text: 'Nothing in the communities you are in matches that.',
        })]));
      resultNote.textContent = hits.length + (hits.length === 1 ? ' result' : ' results');
    } catch (error) {
      if (mine !== generation) return;
      results.replaceChildren(fault(error, () => run()));
      resultNote.textContent = '';
    }
  }
  // -- the saved searches ------------------------------------------------------

  async function paintSaved() {
    try {
      const rows = await listSaved();
      const saved = Array.isArray(rows) ? rows : [];
      savedList.replaceChildren(...(saved.length ? saved.map((entry) => row({
        class: 'saved-row',
        lead: el('span', { class: 'search-hit-glyph' }, icon('pin', { size: 15 })),
        title: entry.name,
        sub: entry.query,
        onClick: () => applyQuery(entry.query),
        side: el('div', { class: 'cardrow-side' },
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            'aria-label': 'Rename the saved search ' + entry.name,
            onClick: (event) => { event.preventDefault(); event.stopPropagation(); renameSaved(entry); },
          }, 'Rename'),
          el('button', {
            class: 'btn btn--danger btn--sm', type: 'button',
            'aria-label': 'Delete the saved search ' + entry.name,
            onClick: (event) => { event.preventDefault(); event.stopPropagation(); removeOneSaved(entry); },
          }, 'Delete')),
      })) : [blank({
        glyph: 'pin',
        title: 'No saved searches',
        text: 'Save a search and it waits here, filters and all.',
      })]));
    } catch (error) {
      savedList.replaceChildren(fault(error, paintSaved));
    }
  }

  function renameSaved(entry) {
    const name = el('input', { class: 'input', type: 'text', value: entry.name, 'aria-label': 'The name of the saved search' });
    const dialog = openDialog({
      title: 'Rename this search',
      body: el('form', {
        class: 'fold', onSubmit: async (event) => {
          event.preventDefault();
          try {
            await renameSaved(entry.id, name.value);
            dialog.close();
            paintSaved();
          } catch (error) { errorToast(error); }
        },
      }, name,
      el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Save')),
    });
    name.focus();
  }

  async function removeOneSaved(entry) {
    const yes = await confirmDialog({
      title: 'Delete this saved search?',
      body: entry.name + ' goes, and the search it names with it.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!yes) return;
    try {
      await removeSaved(entry.id);
      toast('Saved search deleted');
      paintSaved();
    } catch (error) { errorToast(error); }
  }

  function openSaveDialog() {
    const query = queryText();
    if (!query) {
      toast('Search for something first, then save it.');
      return;
    }
    const name = el('input', {
      class: 'input', type: 'text', 'aria-label': 'The name of the saved search',
      placeholder: 'Release notes from Ada',
    });
    const dialog = openDialog({
      title: 'Save this search',
      sub: query,
      body: el('form', {
        class: 'fold', onSubmit: async (event) => {
          event.preventDefault();
          try {
            await saveSearch(name.value, query);
            dialog.close();
            toast('Search saved');
            paintSaved();
          } catch (error) { errorToast(error); }
        },
      }, name,
      el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Save')),
    });
    name.focus();
  }

  // -- the history --------------------------------------------------------------

  async function paintHistory() {
    try {
      const rows = await listHistory();
      const history = Array.isArray(rows) ? rows : [];
      historyList.replaceChildren(...(history.length ? history.map((entry) => row({
        class: 'history-row',
        lead: el('span', { class: 'search-hit-glyph' }, icon('clock', { size: 15 })),
        title: entry.query,
        meta: relativeTime(entry.createdAt),
        onClick: () => applyQuery(entry.query),
        side: el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'Forget the search ' + entry.query,
          onClick: (event) => { event.preventDefault(); event.stopPropagation(); forgetHistory(entry); },
        }, 'Forget'),
      })) : [blank({
        glyph: 'clock',
        title: 'Nothing searched yet',
        text: 'The queries you run are kept here, and you can clear them.',
      })]));
    } catch (error) {
      historyList.replaceChildren(fault(error, paintHistory));
    }
  }

  async function forgetHistory(entry) {
    try {
      await removeHistoryEntry(entry.id);
      paintHistory();
    } catch (error) { errorToast(error); }
  }

  async function clearAllHistory() {
    const yes = await confirmDialog({
      title: 'Clear the search history?',
      body: 'Every query you have run is forgotten. The searches you saved stay.',
      confirmLabel: 'Clear',
      danger: true,
    });
    if (!yes) return;
    try {
      await clearHistory();
      toast('Search history cleared');
      paintHistory();
    } catch (error) { errorToast(error); }
  }

  // -- the wiring ---------------------------------------------------------------

  input.addEventListener('input', () => {
    state.terms = input.value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (timer) clearTimeout(timer);
    run();
  });

  const searchButton = el('button', {
    class: 'btn btn--primary btn--sm', type: 'button',
    onClick: () => { if (timer) clearTimeout(timer); run(); },
  }, icon('search', { size: 15 }), 'Search');

  const node = fold([
    head({
      kicker: 'Everything',
      title: 'Search',
      lede: 'What has been said, and where.',
      actions: el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        onClick: openSaveDialog,
      }, icon('pin', { size: 14 }), 'Save this search'),
    }),
    card({
      label: 'Search', glyph: 'search', tight: true,
      body: el('div', { class: 'search-bar' }, input, searchButton),
    }),
    card({
      label: 'Filters', glyph: 'filter',
      note: 'from:ada in:"general chat" before:2026-01-01 has:file type:image is:unread',
      body: bar.node,
    }),
    el('div', { class: 'search-layout' },
      el('div', { class: 'search-main' },
        card({
          label: 'Results', glyph: 'message', flush: true,
          body: fold([resultNote, results], { tight: true }),
        })),
      el('div', { class: 'search-side' },
        card({
          label: 'Saved searches', glyph: 'pin', flush: true, body: savedList,
        }),
        card({
          label: 'Recent searches', glyph: 'clock', flush: true,
          actions: el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: clearAllHistory,
          }, 'Clear'),
          body: historyList,
        }))),
  ]);

  return {
    node,
    onMount: async () => {
      paintSaved();
      paintHistory();
      await run();
      input.focus();
    },
    cleanup() {
      if (timer) clearTimeout(timer);
    },
  };
}

export default { renderSearch };

// The search filter language, and the searches a reader keeps.
//
// The client parses a query exactly as the server does, so a filter written in
// the command palette means the same thing in the search panel, and a filter
// the server would refuse is refused here first with the same wording.
//
// The rules are the server's:
//
//   - a token whose key is not one this build knows is a search term, so a
//     query that happens to contain a colon is still a search
//   - a token whose key is known but whose value is not one that key accepts
//     is refused, because a filter that quietly matches nothing is worse than
//     one that says so
//   - a value may be quoted, so it can carry a space
//
// The saved searches and the recent queries belong to the reader alone. The
// server answers them from the owner, so the client never names a reader: it
// asks for its own list and nothing else.

import Api from './api.js';

// The filters this build knows, and what each of them accepts.
export const FILTERS = {
  from: { kind: 'author', values: null, label: 'Author', hint: 'Who wrote it' },
  in: { kind: 'channel', values: null, label: 'Channel', hint: 'The channel it is in' },
  before: { kind: 'before', values: null, label: 'Before', hint: 'A date: YYYY-MM-DD' },
  after: { kind: 'after', values: null, label: 'After', hint: 'A date: YYYY-MM-DD' },
  has: { kind: 'has', values: ['file'], label: 'Has', hint: 'What it carries' },
  type: { kind: 'type', values: ['image', 'video', 'link', 'code'], label: 'Type', hint: 'The kind of message' },
  is: { kind: 'is', values: ['unread'], label: 'Is', hint: 'What is true of it' },
};

export const FILTER_KEYS = Object.keys(FILTERS);

// A key is a word; a value is everything after the first colon.
const FILTER_TOKEN = /^([A-Za-z][A-Za-z0-9_]*):(.*)$/s;

// A date is a calendar day or a full timestamp.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function bad(message) {
  const error = new Error(message);
  error.code = 'VALIDATION_ERROR';
  throw error;
}

// Split a query into tokens, keeping a quoted run together.
//
// A quote may open in the middle of a token - from:"two words" is one token -
// so the scanner tracks the quoting rather than splitting on whitespace and
// hoping.
export function tokenize(query) {
  const out = [];
  let current = '';
  let quoted = false;
  for (const ch of String(query == null ? '' : query)) {
    if (ch === '"') {
      quoted = !quoted;
      current += ch;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (current) { out.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

// One token: either a term, or a filter.
function readToken(token) {
  const m = FILTER_TOKEN.exec(token);
  if (!m) return { term: token };

  const key = m[1].toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(FILTERS, key)) return { term: token };

  let value = m[2];
  if (value.startsWith('"')) {
    // A quoted value has to be closed, or the token is not a filter at all:
    // an unterminated quote is a typo in a search, not a filter.
    if (value.length < 2 || !value.endsWith('"')) return { term: token };
    value = value.slice(1, -1);
  } else if (value.includes('"')) {
    return { term: token };
  }

  return { filter: key, value };
}

// A date as an instant. A calendar day is the start of that day in UTC.
export function parseDate(value) {
  const text = String(value || '').trim();
  if (DATE_ONLY.test(text)) {
    const at = Date.parse(text + 'T00:00:00.000Z');
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
  }
  const at = Date.parse(text);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

// The value a filter was given, checked against what that filter accepts.
//
// The value is kept as it was written: a date stays "2026-01-01" rather than
// becoming an instant, because the chip shows what the reader typed and the
// query is sent back to the server the way it was written.
function checkValue(key, value) {
  const spec = FILTERS[key];
  if (!value) bad(key + ': needs a value');
  if (spec.values && !spec.values.includes(value.toLowerCase())) {
    bad(key + ': "' + value + '" is not one of: ' + spec.values.join(', '));
  }
  if (key === 'before' || key === 'after') {
    const at = parseDate(value);
    if (!at) bad(key + ': "' + value + '" is not a date (use YYYY-MM-DD)');
  }
  return value;
}

// Check a value without keeping it. The server normalises dates to an instant;
// this says only whether the value is one the filter accepts.
export function checkFilterValue(key, value) {
  return checkValue(String(key || '').toLowerCase(), value);
}

/**
 * Parse a query into its terms and its filters.
 *
 * @param {string} query
 * @returns {{ terms: string[], filters: object, hasFilters: boolean }}
 */
export function parseQuery(query) {
  const terms = [];
  const filters = {};

  for (const token of tokenize(query)) {
    const read = readToken(token);
    if (read.term !== undefined) {
      terms.push(read.term);
      continue;
    }
    // A filter given twice keeps the last value: two different authors cannot
    // both be the author of one message, so the last one is the one the
    // reader meant to change.
    filters[read.filter] = checkValue(read.filter, read.value);
  }

  return { terms, filters, hasFilters: Object.keys(filters).length > 0 };
}

// One filter, read on its own: what the filter field holds before it is
// applied. It is null when the text is not a filter at all.
export function parseFilter(text) {
  const tokens = tokenize(String(text == null ? '' : text).trim());
  if (tokens.length !== 1) return null;
  const read = readToken(tokens[0]);
  if (!read.filter) return null;
  return { key: read.filter, value: read.value };
}

// Is this key a filter this build knows?
export function isFilter(key) {
  return Object.prototype.hasOwnProperty.call(FILTERS, String(key || '').toLowerCase());
}

// The filters as a reader would write them, in the order the keys are declared.
export function describeFilters(filters) {
  const out = {};
  for (const key of FILTER_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(filters || {}, key)) continue;
    out[key] = filters[key];
  }
  return out;
}

// One filter, as the chip that carries it: the key, the value, and the text.
export function filterChip(key, value) {
  return {
    key,
    value: String(value == null ? '' : value),
    text: key + ':' + value,
    label: (FILTERS[key] && FILTERS[key].label) || key,
  };
}

// The chips for a set of filters.
export function filterChips(filters) {
  const described = describeFilters(filters);
  return FILTER_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(described, key))
    .map((key) => filterChip(key, described[key]));
}

// The query text for a set of terms and filters. A value with a space in it is
// quoted, so the text parses back to the same thing.
export function buildQuery(terms, filters) {
  const parts = [];
  for (const term of terms || []) {
    if (term === undefined || term === null || term === '') continue;
    parts.push(String(term));
  }
  for (const chip of filterChips(filters)) {
    const value = chip.value.includes(' ') ? '"' + chip.value + '"' : chip.value;
    parts.push(chip.key + ':' + value);
  }
  return parts.join(' ');
}

// The filters a reader is offered while they type: the keys that match what
// has been typed so far, each with the values it accepts.
export function filterSuggestions(typed) {
  const text = String(typed || '').trim().toLowerCase();
  const key = text.split(':')[0];
  const out = [];
  for (const name of FILTER_KEYS) {
    if (key && !name.startsWith(key)) continue;
    const spec = FILTERS[name];
    if (!spec.values) {
      out.push({ key: name, label: spec.label, hint: spec.hint, value: null });
      continue;
    }
    for (const value of spec.values) {
      out.push({ key: name, label: spec.label, hint: spec.hint, value });
    }
  }
  return out;
}

// ---- the reader's own saved searches ----------------------------------------

// The reader's saved searches. The server answers from the owner alone, so the
// list is the reader's and nobody else's.
export function listSaved() {
  return Api.savedSearches();
}

// Save a search under a name. The query is stored whole, filters and all, so
// running it again means the same thing.
export function saveSearch(name, query) {
  return Api.createSavedSearch({ name: String(name || '').trim(), query: String(query || '').trim() });
}

export function renameSaved(id, name) {
  return Api.updateSavedSearch(id, { name: String(name || '').trim() });
}

export function removeSaved(id) {
  return Api.deleteSavedSearch(id);
}

// ---- the reader's own recent queries ----------------------------------------

export function listHistory() {
  return Api.searchHistory();
}

export function clearHistory() {
  return Api.clearSearchHistory();
}

export function removeHistoryEntry(id) {
  return Api.deleteSearchHistoryEntry(id);
}

export default {
  FILTERS, FILTER_KEYS, parseQuery, parseFilter, checkFilterValue, describeFilters,
  filterChip, filterChips, buildQuery, filterSuggestions, isFilter, parseDate, tokenize,
  listSaved, saveSearch, renameSaved, removeSaved,
  listHistory, clearHistory, removeHistoryEntry,
};

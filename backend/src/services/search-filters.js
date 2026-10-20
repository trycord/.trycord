// The search filter language.
//
// A query is a list of terms and a list of filters. A filter is written
// key:value, and the value may be quoted so it can carry a space:
//
//   release notes            terms
//   from:ada                 the author is ada
//   in:"general chat"        the channel is called "general chat"
//   before:2026-01-01        written before that day
//   after:2026-01-01         written on or after that day
//   has:file                 the message carries a file
//   type:image               the message carries an image
//   is:unread                the reader has not read it
//
// Two rules decide what a token is:
//
//   - a token whose key is not one this build knows is a search term, so a
//     query that happens to contain a colon is still a search and does not
//     fail
//   - a token whose key is known but whose value is not one that key accepts
//     is refused, because a filter that quietly matches nothing is worse
//     than one that says so
//
// The filters are applied together with the permission check, never before
// it: a filter narrows what a reader may see, and cannot widen it. The
// module therefore decides what a query means and nothing about who may see
// the answer - that stays in the search index, where it already was.

const FILTERS = {
  from: { kind: 'author', values: null },
  in: { kind: 'channel', values: null },
  before: { kind: 'before', values: null },
  after: { kind: 'after', values: null },
  has: { kind: 'has', values: ['file'] },
  type: { kind: 'type', values: ['image', 'video', 'link', 'code'] },
  is: { kind: 'is', values: ['unread'] },
};

const FILTER_KEYS = Object.keys(FILTERS);

// A key is a word; a value is everything after the first colon.
const FILTER_TOKEN = /^([A-Za-z][A-Za-z0-9_]*):(.*)$/s;

// A date is a calendar day or a full timestamp. A calendar day means the
// start of that day, so "before:2026-01-01" is the day before and
// "after:2026-01-01" is that day and the ones after it.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function bad(message) {
  const e = new Error(message);
  e.code = 'VALIDATION_ERROR';
  throw e;
}

// Split a query into tokens, keeping a quoted run together.
//
// A quote may open in the middle of a token - from:"two words" is one token -
// so the scanner tracks the quoting rather than splitting on whitespace and
// hoping.
function tokenize(query) {
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

// The value a filter was given, checked against what that filter accepts.
function checkValue(key, value) {
  const spec = FILTERS[key];
  if (!value) bad(key + ': needs a value');
  if (spec.values && !spec.values.includes(value.toLowerCase())) {
    bad(key + ': "' + value + '" is not one of: ' + spec.values.join(', '));
  }
  if (key === 'before' || key === 'after') {
    const at = parseDate(value);
    if (!at) bad(key + ': "' + value + '" is not a date (use YYYY-MM-DD)');
    return at;
  }
  return value;
}

// A date as an instant. A calendar day is the start of that day in UTC.
function parseDate(value) {
  const text = String(value || '').trim();
  if (DATE_ONLY.test(text)) {
    const at = Date.parse(text + 'T00:00:00.000Z');
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
  }
  const at = Date.parse(text);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/**
 * Parse a query into its terms and its filters.
 *
 * @param {string} query
 * @returns {{ terms: string[], filters: object, hasFilters: boolean }}
 */
function parse(query) {
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

// The filters as a reader would write them, for echoing back to the client.
function describe(filters) {
  const out = {};
  for (const key of FILTER_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(filters, key)) continue;
    out[key] = filters[key];
  }
  return out;
}

module.exports = { parse, describe };

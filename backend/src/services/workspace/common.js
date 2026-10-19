// Shared helpers for the workspace services.
//
// Small, deliberately boring things every one of them needs: a way to refuse
// something with a code the API understands, a way to cap a string the way
// every other service in this repository caps one, and the two validators
// that keep untrusted input from becoming a link or a date the server cannot
// compare.

const { Codes } = require('../../errors');

// A refusal with a code the error envelope knows about.
//
// The codes are the ones in errors.js. A code that is not in that table would
// be answered as an internal error, which is exactly the wrong answer for a
// validation failure, so this is the only way to refuse.
function fail(code, message) {
  // A code the error envelope does not know would be answered as an internal
  // error, which is the wrong answer for a refusal. Caught here, where the
  // mistake is, rather than in the response.
  if (!Codes[code]) throw new Error('workspace: unknown refusal code ' + code);
  const e = new Error(message);
  e.code = code;
  throw e;
}

// A refusal that carries structured details to the client.
//
// A conflict is the one answer that is useless without them: "this document
// changed" tells the editor nothing it can act on, while the current revision
// tells it exactly what to reload.
function conflict(message, details) {
  const e = new Error(message);
  e.code = 'CONFLICT';
  e.details = details;
  throw e;
}

function text(value, max, field) {
  const s = String(value == null ? '' : value).trim();
  if (s.length > max) fail('VALIDATION_ERROR', `${field} must be ${max} characters or fewer`);
  return s;
}

function required(value, max, field) {
  const s = text(value, max, field);
  if (!s) fail('VALIDATION_ERROR', `${field} is required`);
  return s;
}

// A link the member opens themselves.
//
// http and https only. The server never fetches a stored link - it hands it
// back and the member decides where it goes - but a javascript: target is
// still a target somebody will click, so it is refused at the door.
function httpUrl(value) {
  const s = required(value, 512, 'url');
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    fail('VALIDATION_ERROR', 'a link must be a full http or https URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail('VALIDATION_ERROR', 'a link must be http or https');
  }
  return parsed.toString();
}

// An instant, stored as a UTC ISO string.
//
// Refused rather than coerced: a date the server cannot parse is a date it
// cannot compare, and comparing instants is the whole point of storing them.
function instant(value, field) {
  const s = text(value, 64, field);
  if (!s) fail('VALIDATION_ERROR', `${field} is required`);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) fail('VALIDATION_ERROR', `${field} must be an ISO timestamp`);
  return d.toISOString();
}

function optionalInstant(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return instant(value, field);
}

// A positive integer, or null when the value is absent.
function positiveInt(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail('VALIDATION_ERROR', `${field} must be a whole number of at least 1`);
  return n;
}

function oneOf(value, allowed, field, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    fail('VALIDATION_ERROR', `${field} is required`);
  }
  const s = String(value).trim();
  if (!allowed.includes(s)) fail('VALIDATION_ERROR', `${field} must be one of: ${allowed.join(', ')}`);
  return s;
}

// A list of short labels, lowercased and de-duplicated.
function labels(value) {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of raw) {
    const s = text(item, 64, 'label').toLowerCase();
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > 20) fail('VALIDATION_ERROR', 'a card may carry at most 20 labels');
  return out;
}

module.exports = {
  fail, conflict, text, required, httpUrl, instant, optionalInstant,
  positiveInt, oneOf, labels,
};

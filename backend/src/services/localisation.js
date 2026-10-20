// Localisation.
//
// The product's strings are English, in the source. This module is the
// architecture around that: a pack is a set of translations for one locale,
// an operator installs it, a reviewer signs it off, and the server answers
// each request in the locale it decided on.
//
// A pack is untrusted content. It says what the interface says; it cannot
// say what a control does. Two rules keep that true:
//
//   - a translated string may not contain anything that could execute
//   - a translated string may not change the placeholders, because a
//     placeholder the interface does not know how to fill is a broken
//     interface
//
// Both are checked before a pack is stored, and checked again on install,
// so a pack that was edited on disk is refused the same way.
//
// There is no machine translation here and no network call: a pack is a file
// an operator puts on the instance.

const crypto = require('crypto');
const db = require('../db');
const { now, uuid } = require('../clock');
const settings = require('./settings');

// The source catalogue.
//
// The English strings a pack translates, keyed by the name the client uses.
// A pack may translate any of them; a key that is not here is not a string
// this build has, and a pack that claims to translate it is refused rather
// than half-applied.
const SOURCE_STRINGS = {
  'nav.messages': 'Messages',
  'nav.channels': 'Channels',
  'nav.people': 'People',
  'nav.settings': 'Settings',
  'action.send': 'Send',
  'action.cancel': 'Cancel',
  'action.save': 'Save',
  'action.delete': 'Delete',
  'action.reply': 'Reply',
  'action.search': 'Search',
  'search.placeholder': 'Search messages',
  'search.results': '{count} results',
  'search.noResults': 'No messages found',
  'error.generic': 'Something went wrong',
  'error.network': 'The server could not be reached',
  'error.notFound': 'Not found',
  'error.forbidden': 'You do not have permission to do that',
  'notification.newMessage': '{name} sent a message',
  'date.today': 'Today',
  'date.yesterday': 'Yesterday',
};

// The pack formats this build understands. A pack that declares another one
// is refused, by name: an unreadable pack is not silently ignored.
const KNOWN_FORMAT_VERSIONS = [1];

const LOCALE_SHAPE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const VERSION_SHAPE = /^\d+(\.\d+){0,2}([-+][A-Za-z0-9.-]+)?$/;
const KEY_SHAPE = /^[a-z0-9]+([._-][a-z0-9]+)*$/;

// What a translated string may not contain.
//
// The list is short on purpose. A translation is prose: it has no markup, no
// template expression, no script address and no control character. Anything
// outside ordinary prose is refused, because there is no legitimate reason
// for a translation to carry it.
const FORBIDDEN_IN_A_TRANSLATION = [
  { re: /[<>]/, why: 'it contains markup' },
  { re: /\{\{|\$\{/, why: 'it contains a template expression' },
  { re: /(?:javascript|vbscript)\s*:/i, why: 'it contains a script address' },
  { re: /data\s*:\s*text\/html/i, why: 'it contains an inline document' },
  { re: /[`\\]/, why: 'it contains a template or escape character' },
  { re: /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/, why: 'it contains a control character' },
];

function bad(message) {
  const e = new Error(message);
  e.code = 'VALIDATION_ERROR';
  throw e;
}

function notFound() {
  const e = new Error('no such localisation pack');
  e.code = 'NOT_FOUND';
  throw e;
}

// The placeholders a string carries. The interface fills these in, so a
// translation has to keep exactly the same ones.
function placeholders(text) {
  const out = new Set();
  const re = /\{([A-Za-z0-9_]+)\}/g;
  let m;
  while ((m = re.exec(String(text))) !== null) out.add(m[1]);
  return out;
}

function samePlaceholders(a, b) {
  if (a.size !== b.size) return false;
  for (const key of a) if (!b.has(key)) return false;
  return true;
}

// What is wrong with a translated string, if anything.
function stringProblem(key, value) {
  if (typeof value !== 'string') return 'the translation for "' + key + '" is not text';
  if (!value.trim()) return 'the translation for "' + key + '" is empty';
  for (const rule of FORBIDDEN_IN_A_TRANSLATION) {
    if (rule.re.test(value)) {
      return 'the translation for "' + key + '" is refused because ' + rule.why;
    }
  }
  const original = SOURCE_STRINGS[key];
  if (!samePlaceholders(placeholders(original), placeholders(value))) {
    return 'the translation for "' + key + '" does not keep the same placeholders as the original';
  }
  return null;
}

/**
 * Check a pack.
 *
 * Every problem is reported, not just the first one: an author who has five
 * strings to fix should be told about all five.
 *
 * @param {object} pack
 * @returns {{ pack: object, problems: string[] }}
 */
function validatePack(pack) {
  const problems = [];
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
    return { pack: null, problems: ['a pack has to be an object'] };
  }

  const formatVersion = Number(pack.formatVersion);
  if (!Number.isInteger(formatVersion) || !KNOWN_FORMAT_VERSIONS.includes(formatVersion)) {
    problems.push(
      'pack format version ' + JSON.stringify(pack.formatVersion)
      + ' is not known to this build (known: ' + KNOWN_FORMAT_VERSIONS.join(', ') + ')'
    );
  }

  const locale = String(pack.locale == null ? '' : pack.locale).trim();
  if (!LOCALE_SHAPE.test(locale)) {
    problems.push('"' + locale + '" is not a locale this build accepts');
  }

  const version = String(pack.version == null ? '' : pack.version).trim();
  if (!VERSION_SHAPE.test(version)) {
    problems.push('"' + version + '" is not a version');
  }

  const name = String(pack.name == null ? '' : pack.name).trim();
  if (!name) problems.push('a pack needs a name');

  const strings = pack.strings;
  if (!strings || typeof strings !== 'object' || Array.isArray(strings)) {
    problems.push('a pack needs a set of strings');
  } else {
    const keys = Object.keys(strings);
    if (!keys.length) problems.push('a pack needs at least one string');
    for (const key of keys) {
      if (!KEY_SHAPE.test(key)) {
        problems.push('"' + key + '" is not a string name');
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(SOURCE_STRINGS, key)) {
        problems.push('"' + key + '" is not a string this build knows');
        continue;
      }
      const problem = stringProblem(key, strings[key]);
      if (problem) problems.push(problem);
    }
  }

  const allowed = settings.read('localisation.allowedLocales', []);
  if (Array.isArray(allowed) && allowed.length && locale
      && !allowed.some((entry) => String(entry).toLowerCase() === locale.toLowerCase())) {
    problems.push('"' + locale + '" is not one of the locales this instance allows');
  }

  if (problems.length) return { pack: null, problems };

  return {
    pack: {
      formatVersion,
      locale,
      version,
      name,
      description: String(pack.description == null ? '' : pack.description).trim().slice(0, 255),
      strings,
      author: String(pack.author == null ? '' : pack.author).trim().slice(0, 128) || null,
      reviewer: String(pack.reviewer == null ? '' : pack.reviewer).trim().slice(0, 128) || null,
    },
    problems: [],
  };
}

// A hash of the pack's content, so two installs of the same file are
// recognisable as the same thing.
function sourceHash(pack) {
  const canonical = JSON.stringify({
    formatVersion: pack.formatVersion,
    locale: pack.locale,
    version: pack.version,
    strings: pack.strings,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Install a pack.
 *
 * @param {object} raw        the pack as it was written
 * @param {object} options
 * @param {string} options.actorId   who installed it
 * @param {string} [options.serverId] the community it belongs to
 * @param {string} [options.reviewState] 'approved' or 'pending'
 */
async function installPack(raw, options) {
  const opts = options || {};
  const checked = validatePack(raw);
  if (checked.problems.length) {
    const e = new Error('this pack was refused: ' + checked.problems.join('; '));
    e.code = 'VALIDATION_ERROR';
    e.problems = checked.problems;
    throw e;
  }
  const pack = checked.pack;

  const id = uuid();
  const ts = now();
  await db.run(
    'INSERT INTO localisation_packs (id, locale, version, format_version, name, description,'
    + ' strings, author, reviewer, review_state, reviewer_id, server_id, source_hash,'
    + ' installed_by, created_at, updated_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id, pack.locale, pack.version, pack.formatVersion, pack.name, pack.description || null,
      JSON.stringify(pack.strings), pack.author, pack.reviewer,
      opts.reviewState === 'approved' ? 'approved' : 'pending',
      opts.reviewState === 'approved' ? (opts.actorId || null) : null,
      opts.serverId || null, sourceHash(pack), opts.actorId || null, ts, ts,
    ]
  );
  return get(id);
}

async function get(id) {
  const row = await db.get(
    `SELECT id, locale, version, format_version AS formatVersion, name, description,
            strings, author, reviewer, review_state AS reviewState, server_id AS serverId,
            source_hash AS sourceHash, created_at AS createdAt, updated_at AS updatedAt
       FROM localisation_packs WHERE id = ?`,
    [id]
  );
  if (!row) notFound();
  row.strings = parseStrings(row.strings);
  return row;
}

function parseStrings(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// The packs installed on this instance, and the community ones for a
// community.
async function listPacks(options) {
  const opts = options || {};
  const where = [];
  const params = [];
  if (opts.serverId) {
    where.push('(server_id IS NULL OR server_id = ?)');
    params.push(opts.serverId);
  } else if (opts.instanceOnly) {
    where.push('server_id IS NULL');
  }
  const rows = await db.all(
    `SELECT id, locale, version, format_version AS formatVersion, name, description,
            author, reviewer, review_state AS reviewState, server_id AS serverId,
            source_hash AS sourceHash, created_at AS createdAt, updated_at AS updatedAt
       FROM localisation_packs
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY locale ASC, version DESC`,
    params
  );
  return rows;
}

// The packs that are in force for a scope.
//
// A community's own pack overrides the instance's pack for the same locale,
// and only an approved pack is in force: a pack waiting for a review is
// stored but not served.
async function effectivePacks(options) {
  const opts = options || {};
  const rows = await db.all(
    `SELECT id, locale, version, strings, review_state AS reviewState, server_id AS serverId
       FROM localisation_packs
      WHERE review_state = 'approved'
        AND (server_id IS NULL ${opts.serverId ? 'OR server_id = ?' : ''})`,
    opts.serverId ? [opts.serverId] : []
  );

  const out = new Map();
  for (const row of rows) {
    const key = String(row.locale).toLowerCase();
    const existing = out.get(key);
    // The community's pack wins over the instance's for the same locale.
    if (existing && existing.serverId && !row.serverId) continue;
    out.set(key, {
      id: row.id,
      locale: row.locale,
      version: row.version,
      serverId: row.serverId,
      strings: parseStrings(row.strings),
    });
  }
  return out;
}

// The locale a request is answered in.
//
// In this order: the reader's own preference, the instance's default, and
// the browser's Accept-Language. Each of them is used only when a pack
// exists for it, so an instance with no French pack answers English even
// when the browser asks for French.
//
// The answer says which of them was used, so the client and the operator can
// both see why.
function negotiate(options) {
  const opts = options || {};
  const available = opts.available || new Map();

  const preferred = String(opts.preferred || '').trim();
  if (preferred) {
    const found = lookup(available, preferred);
    if (found) return { locale: found.locale, source: 'reader', pack: found };
  }

  const fallback = String(opts.defaultLocale || '').trim();
  if (fallback) {
    const found = lookup(available, fallback);
    if (found) return { locale: found.locale, source: 'instance', pack: found };
  }

  const browser = matchAcceptLanguage(opts.acceptLanguage, available);
  if (browser) return { locale: browser.locale, source: 'browser', pack: browser };

  return { locale: 'en', source: 'fallback', pack: null };
}

// A locale, as a pack would spell it: exactly, then by its base language.
function lookup(available, wanted) {
  const map = available instanceof Map ? available : new Map();
  const text = String(wanted || '').trim().toLowerCase();
  if (!text) return null;
  const exact = map.get(text);
  if (exact) return exact;
  const base = text.split('-')[0];
  for (const [locale, pack] of map) {
    if (String(locale).split('-')[0] === base) return pack;
  }
  return null;
}

// The browser's preference, best first.
//
// The q values are honoured, and a tag falls back to its base language, so a
// browser asking for fr-CA is answered with the French pack when there is
// one.
function matchAcceptLanguage(header, available) {
  const text = String(header || '').trim();
  if (!text) return null;
  const map = available instanceof Map ? available : new Map();

  const tags = [];
  text.split(',').forEach((part, index) => {
    const [tag, ...params] = part.trim().split(';');
    const name = tag.trim().toLowerCase();
    if (!name) return;
    let quality = 1;
    for (const param of params) {
      const q = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
      if (q) quality = Math.min(Math.max(Number(q[1]), 0), 1);
    }
    if (quality <= 0) return;
    tags.push({ name, quality, index });
  });

  tags.sort((a, b) => (b.quality - a.quality) || (a.index - b.index));
  for (const tag of tags) {
    const found = lookup(map, tag.name);
    if (found) return found;
  }
  return null;
}

// The strings a client should use for a locale: the source catalogue with the
// pack's translations on top. A pack that translates only part of the
// catalogue leaves the rest in English, which is what a partial translation
// means.
function stringsFor(pack) {
  const out = Object.assign({}, SOURCE_STRINGS);
  if (pack && pack.strings) {
    for (const [key, value] of Object.entries(pack.strings)) {
      if (Object.prototype.hasOwnProperty.call(SOURCE_STRINGS, key)) out[key] = value;
    }
  }
  return out;
}

// The reader's own preferred locale.
async function preferenceOf(userId) {
  if (!userId) return null;
  const row = await db.get('SELECT locale FROM reader_locale_settings WHERE user_id = ?', [userId]);
  return row ? row.locale : null;
}

async function setPreference(userId, locale) {
  const text = String(locale == null ? '' : locale).trim();
  if (!text) {
    await db.run('DELETE FROM reader_locale_settings WHERE user_id = ?', [userId]);
    return { locale: null };
  }
  if (!LOCALE_SHAPE.test(text)) bad('"' + text + '" is not a locale this build accepts');
  const ts = now();
  await db.upsert(
    'reader_locale_settings',
    ['user_id', 'locale', 'updated_at'],
    [userId, text, ts],
    ['user_id'],
    { locale: db.newRef('locale'), updated_at: db.newRef('updated_at') }
  );
  return { locale: text };
}

// A reviewer signs a pack off, or turns it down.
async function reviewPack(id, options) {
  const opts = options || {};
  const decision = String(opts.decision || '').toLowerCase();
  if (decision !== 'approved' && decision !== 'rejected') {
    bad('a review is either approved or rejected');
  }
  const row = await db.get('SELECT id FROM localisation_packs WHERE id = ?', [id]);
  if (!row) notFound();
  const ts = now();
  await db.run(
    'UPDATE localisation_packs SET review_state = ?, reviewer_id = ?, reviewer = ?, updated_at = ?'
    + ' WHERE id = ?',
    [decision, opts.reviewerId || null, opts.reviewerName || null, ts, id]
  );
  return get(id);
}

async function removePack(id) {
  const info = await db.run('DELETE FROM localisation_packs WHERE id = ?', [id]);
  if (!info.changes) notFound();
  return { ok: true, id };
}

module.exports = {
  validatePack, installPack, get, listPacks, effectivePacks, removePack, reviewPack,
  negotiate, stringsFor, preferenceOf, setPreference,
};

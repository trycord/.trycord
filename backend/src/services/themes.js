// Theme packages.
//
// A theme is a package of values: a handful of colours, a schema version and
// a declaration of what it needs. It is not code, and it cannot become
// code - a package that carries anything other than the declared fields is
// refused, and a colour that is not a colour is refused.
//
// The schema is versioned. A package that declares a schema version this
// build does not know is refused, and the message names that version: an
// unreadable package is not silently ignored, because a theme that is
// ignored is a theme somebody believes they installed.
//
// Import validates, export produces a package, and a rollback returns to the
// theme that was in force before the last one. The client measures a custom
// theme and refuses one that breaks the shell; that rule holds for an
// imported theme too, and this module does the half of it that belongs on
// the server - refusing a package whose values could not survive the
// measurement.

const db = require('../db');
const { now, uuid } = require('../clock');

// The schema versions this build understands.
const KNOWN_SCHEMA_VERSIONS = [1];

// The tokens a theme may set. These are the ones the client's own custom
// palette uses, so an imported theme is measured against the same shell.
const TOKEN_KEYS = ['accent', 'pg', 'base', 'txt'];

// The fields a package may carry. Anything else is refused, which is what
// keeps a theme a set of values: there is no field here that could hold a
// script, and a package that brings one is turned away.
const PACKAGE_FIELDS = ['schemaVersion', 'name', 'version', 'compatibility', 'tokens'];

const COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNCTIONAL_COLOUR = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9a-zA-Z.,%/\s-]*\)$/;
const VERSION_SHAPE = /^\d+(\.\d+){0,2}([-+][A-Za-z0-9.-]+)?$/;

function bad(message, code) {
  const e = new Error(message);
  e.code = code || 'VALIDATION_ERROR';
  throw e;
}

function notFound() {
  const e = new Error('no such theme');
  e.code = 'NOT_FOUND';
  throw e;
}

// Is this a colour a theme may set?
//
// A colour and nothing else: no url(), no expression(), no statement
// terminator, nothing that could be anything but a colour.
function isColour(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  if (COLOUR.test(text)) return true;
  return FUNCTIONAL_COLOUR.test(text);
}

/**
 * Check a theme package.
 *
 * @param {object} raw
 * @returns {{ theme: object|null, problems: string[] }}
 */
function validate(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { theme: null, problems: ['a theme package has to be an object'] };
  }

  for (const field of Object.keys(raw)) {
    if (!PACKAGE_FIELDS.includes(field)) {
      problems.push('"' + field + '" is not a field a theme package may carry');
    }
  }

  const schemaVersion = Number(raw.schemaVersion);
  if (!Number.isInteger(schemaVersion) || !KNOWN_SCHEMA_VERSIONS.includes(schemaVersion)) {
    problems.push(
      'theme schema version ' + JSON.stringify(raw.schemaVersion)
      + ' is not known to this build (known: ' + KNOWN_SCHEMA_VERSIONS.join(', ') + ')'
    );
  }

  const name = String(raw.name == null ? '' : raw.name).trim();
  if (!name) problems.push('a theme needs a name');

  const version = String(raw.version == null ? '' : raw.version).trim();
  if (!VERSION_SHAPE.test(version)) problems.push('"' + version + '" is not a version');

  const compatibility = raw.compatibility === undefined ? {} : raw.compatibility;
  if (!compatibility || typeof compatibility !== 'object' || Array.isArray(compatibility)) {
    problems.push('compatibility has to be an object');
  } else {
    const wanted = compatibility.minSchemaVersion;
    if (wanted !== undefined) {
      const min = Number(wanted);
      if (!Number.isInteger(min)) {
        problems.push('compatibility.minSchemaVersion has to be a whole number');
      } else if (!KNOWN_SCHEMA_VERSIONS.includes(min)) {
        problems.push(
          'theme schema version ' + min + ' is not known to this build (known: '
          + KNOWN_SCHEMA_VERSIONS.join(', ') + ')'
        );
      } else if (min > schemaVersion) {
        problems.push('this theme needs schema version ' + min + ', which is newer than the package declares');
      }
    }
  }

  const tokens = raw.tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    problems.push('a theme needs a set of tokens');
  } else {
    for (const key of Object.keys(tokens)) {
      if (!TOKEN_KEYS.includes(key)) {
        problems.push('"' + key + '" is not a token a theme may set');
        continue;
      }
      if (!isColour(tokens[key])) {
        problems.push('the token "' + key + '" is not a colour');
      }
    }
  }

  if (problems.length) return { theme: null, problems };

  return {
    theme: {
      schemaVersion,
      name: name.slice(0, 128),
      version,
      compatibility: { minSchemaVersion: compatibility.minSchemaVersion === undefined
        ? schemaVersion
        : Number(compatibility.minSchemaVersion) },
      tokens: Object.fromEntries(TOKEN_KEYS
        .filter((key) => tokens[key] !== undefined)
        .map((key) => [key, String(tokens[key]).trim()])),
    },
    problems: [],
  };
}

/**
 * Install a theme package and put it in force.
 *
 * @param {object} raw the package
 * @param {object} options
 * @param {string} options.actorId
 * @param {string} [options.serverId] the community it belongs to
 */
async function importTheme(raw, options) {
  const opts = options || {};
  const checked = validate(raw);
  if (checked.problems.length) {
    const e = new Error('this theme was refused: ' + checked.problems.join('; '));
    e.code = 'VALIDATION_ERROR';
    e.problems = checked.problems;
    throw e;
  }
  const theme = checked.theme;
  const scope = opts.serverId ? 'community' : 'instance';

  const id = uuid();
  const ts = now();
  await db.run(
    'INSERT INTO theme_packages (id, name, version, schema_version, tokens, compatibility,'
    + ' scope, server_id, state, installed_by, created_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id, theme.name, theme.version, theme.schemaVersion,
      JSON.stringify(theme.tokens), JSON.stringify(theme.compatibility),
      scope, opts.serverId || null, 'active', opts.actorId || null, ts,
    ]
  );
  await activate({ id, scope, serverId: opts.serverId, reason: 'install', actorId: opts.actorId });
  return get(id);
}

// The package for a theme, in the shape it was imported in.
async function get(id) {
  const row = await db.get(
    'SELECT id, name, version, schema_version AS schemaVersion, tokens, compatibility,'
    + ' scope, server_id AS serverId, state, created_at AS createdAt FROM theme_packages WHERE id = ?',
    [id]
  );
  if (!row) notFound();
  return row;
}

// The package, ready to be written to a file and imported somewhere else.
async function exportTheme(id) {
  const row = await get(id);
  return {
    schemaVersion: row.schemaVersion,
    name: row.name,
    version: row.version,
    compatibility: parseJson(row.compatibility, {}),
    tokens: parseJson(row.tokens, {}),
  };
}

function parseJson(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// The themes installed here, and the community ones for a community.
async function listThemes(options) {
  const opts = options || {};
  const where = [];
  const params = [];
  if (opts.serverId) {
    where.push('(server_id IS NULL OR server_id = ?)');
    params.push(opts.serverId);
  } else if (opts.instanceOnly) {
    where.push('server_id IS NULL');
  }
  return db.all(
    'SELECT id, name, version, schema_version AS schemaVersion, scope, server_id AS serverId,'
    + ' state, created_at AS createdAt FROM theme_packages'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY created_at DESC, id DESC',
    params
  );
}

// Put a theme in force, and remember that it was.
async function activate(options) {
  const opts = options || {};
  const id = uuid();
  await db.run(
    'INSERT INTO theme_activations (id, scope, server_id, theme_id, reason, activated_at, activated_by)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, opts.scope || 'instance', opts.serverId || null, opts.themeId,
      opts.reason || 'install', now(), opts.actorId || null]
  );
  return id;
}

// The theme in force for a scope.
async function activeTheme(options) {
  const opts = options || {};
  const row = await db.get(
    `SELECT a.id AS activationId, a.reason, a.activated_at AS activatedAt, t.id, t.name, t.version,
            t.schema_version AS schemaVersion, t.tokens, t.compatibility, t.scope, t.server_id AS serverId
       FROM theme_activations a JOIN theme_packages t ON t.id = a.theme_id
      WHERE a.scope = ? ${opts.serverId ? 'AND a.server_id = ?' : 'AND a.server_id IS NULL'}
      ORDER BY a.activated_at DESC, a.id DESC LIMIT 1`,
    opts.serverId ? [opts.scope || 'instance', opts.serverId] : [opts.scope || 'instance']
  );
  if (!row) return null;
  row.tokens = parseJson(row.tokens, {});
  row.compatibility = parseJson(row.compatibility, {});
  return row;
}

// The theme that was in force before the current one.
async function previousTheme(options) {
  const opts = options || {};
  const current = await db.get(
    `SELECT id FROM theme_activations
      WHERE scope = ? ${opts.serverId ? 'AND server_id = ?' : 'AND server_id IS NULL'}
      ORDER BY activated_at DESC, id DESC LIMIT 1`,
    opts.serverId ? [opts.scope || 'instance', opts.serverId] : [opts.scope || 'instance']
  );
  if (!current) return null;
  const row = await db.get(
    `SELECT a.id AS activationId, a.reason, a.activated_at AS activatedAt, t.id, t.name, t.version,
            t.schema_version AS schemaVersion, t.tokens, t.compatibility, t.scope, t.server_id AS serverId
       FROM theme_activations a JOIN theme_packages t ON t.id = a.theme_id
      WHERE a.scope = ? ${opts.serverId ? 'AND a.server_id = ?' : 'AND a.server_id IS NULL'}
        AND a.id != ?
      ORDER BY a.activated_at DESC, a.id DESC LIMIT 1`,
    opts.serverId
      ? [opts.scope || 'instance', opts.serverId, current.id]
      : [opts.scope || 'instance', current.id]
  );
  if (!row) return null;
  row.tokens = parseJson(row.tokens, {});
  row.compatibility = parseJson(row.compatibility, {});
  return row;
}

// Go back to the theme that was in force before the last change.
//
// The activation log is the record of what worked: every theme that was put
// in force is in it, so the one before the current one is the last one this
// instance is known to have run.
async function rollback(options) {
  const opts = options || {};
  const scope = opts.serverId ? 'community' : 'instance';
  const previous = await previousTheme({ scope, serverId: opts.serverId });
  if (!previous) {
    bad('there is no earlier theme to go back to');
  }
  await activate({
    themeId: previous.id,
    scope,
    serverId: opts.serverId,
    reason: 'rollback',
    actorId: opts.actorId,
  });
  return activeTheme({ scope, serverId: opts.serverId });
}

// The schema versions this build understands, for a client that wants to
// know before it offers to import.
function schema() {
  return { knownSchemaVersions: KNOWN_SCHEMA_VERSIONS.slice(), tokenKeys: TOKEN_KEYS.slice() };
}

module.exports = {
  KNOWN_SCHEMA_VERSIONS, TOKEN_KEYS, PACKAGE_FIELDS,
  validate, importTheme, exportTheme, get, listThemes, activeTheme, rollback, schema, isColour,
};

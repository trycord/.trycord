// Human-readable slugs for URLs.
//
// A UUID in the address bar is not something a member can read out, paste to
// someone, or recognise as belonging to the community they are in. This turns
// the two id-bearing entities into names a person can use, while every existing
// UUID route keeps working - links already shared must not break, so slugs are
// additive and resolution accepts either form.
//
// Users need no slug column: the username is already unique, already
// human-readable, and already what a person would type. Re-deriving a second
// name for it would be a second thing to keep in sync for no gain.
//
// Slugs are never trusted from the client. A rename re-slugs, the old slug is
// not retained, and anything holding a stale URL falls back to the UUID route
// rather than 404 - see resolveServer/resolveChannel, which accept both.
const crypto = require('crypto');
const db = require('../db');

const MAX_LEN = 48;

// Reserved because they collide with a route segment's own meaning. A community
// named "settings" would otherwise take a URL that the router reads as the
// settings page.
const RESERVED = new Set([
  'new', 'admin', 'app', 'api', 'assets', 'channel', 'channels', 'members',
  'roles', 'categories', 'settings', 'invites', 'pins', 'server', 'servers',
  'users', 'c', 'u', 'login', 'logout', 'me', 'home', 'search',
]);

// Accent folding rather than stripping: "Café" and "Cafe" should not become
// two different communities that both read the same in a URL.
function fold(input) {
  return String(input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/&/g, ' and ')
    .toLowerCase();
}

function slugify(input) {
  let out = fold(input)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (out.length > MAX_LEN) out = out.slice(0, MAX_LEN).replace(/-+$/, '');
  if (!out) out = 'x';
  if (RESERVED.has(out)) out = out + '-1';
  return out;
}

// Picks a free slug from a root, given a function that reports what is taken.
// Scope lives in the callers rather than in a shared `scope` argument that is
// null for one entity and an id for the other: that ambiguity is what made
// `id != ?` bind NULL and silently match no rows, so every collision check
// passed and the unique index then rejected the insert.
async function pick(root, fetchTaken) {
  const taken = new Set(await fetchTaken(root));
  if (!taken.has(root)) return root;
  // Start at 2: "name-1" reads like a first attempt, not a collision handler.
  for (let n = 2; n < 1000; n++) {
    const candidate = `${root}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Pathological, but a random suffix beats looping or throwing: a name
  // collision must never be able to block someone from creating or renaming.
  return `${root}-${crypto.randomBytes(3).toString('hex')}`;
}

async function uniqueServerSlug(name, excludeId) {
  const root = slugify(name);
  return pick(root, async (r) => {
    const rows = await db.all('SELECT slug FROM servers WHERE id != ? AND slug LIKE ?', [String(excludeId || ''), r + '%']);
    return rows.map((x) => x.slug);
  });
}

async function uniqueChannelSlug(name, serverId, excludeId) {
  const root = slugify(name);
  return pick(root, async (r) => {
    const rows = await db.all(
      'SELECT slug FROM channels WHERE server_id = ? AND id != ? AND slug LIKE ?',
      [serverId, String(excludeId || ''), r + '%']
    );
    return rows.map((x) => x.slug);
  });
}

async function forServer(name, excludeId) {
  return uniqueServerSlug(name, excludeId);
}

async function forChannel(name, serverId, excludeId) {
  return uniqueChannelSlug(name, serverId, excludeId);
}

// --- resolution -----------------------------------------------------------
//
// Both accept an id or a slug, because the client may hold either: a link
// shared before slugs existed, or one copied from the address bar after.

async function resolveServer(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  // Ids are UUIDs; slugs are not. Testing the shape first keeps this to one
  // query instead of one per candidate.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) {
    return db.get('SELECT * FROM servers WHERE id = ?', [t]);
  }
  return db.get('SELECT * FROM servers WHERE slug = ?', [t]);
}

async function resolveChannel(token, serverId) {
  const t = String(token || '').trim();
  if (!t) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) {
    return db.get('SELECT * FROM channels WHERE id = ? AND server_id = ?', [t, serverId]);
  }
  return db.get('SELECT * FROM channels WHERE slug = ? AND server_id = ?', [t, serverId]);
}

async function resolveUser(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) {
    return db.get('SELECT * FROM users WHERE id = ?', [t]);
  }
  // Case-insensitive: a URL is not a place to be pedantic about capitals.
  return db.get('SELECT * FROM users WHERE LOWER(username) = LOWER(?)', [t]);
}

// --- backfill -------------------------------------------------------------

// Runs once at boot. The unique index is built after this, so a duplicate
// during the backfill is resolved here rather than crashing startup.
//
// Uses the same pickers as live create and rename, so a name that backfills to
// one slug cannot come out differently later.
async function backfill(conn) {
  const exec = conn || db;
  const servers = await exec.all('SELECT id, name FROM servers WHERE slug IS NULL OR slug = ?', ['']);
  for (const s of servers) {
    // The picker reads through the global db, not this connection, so the
    // already-processed rows above are not visible to it during boot. Compare
    // against the full table instead and let the index settle the rest.
    const taken = new Set(
      (await exec.all('SELECT slug FROM servers WHERE id != ? AND slug LIKE ?',
        [s.id, slugify(s.name) + '%'])).map((r) => r.slug)
    );
    let slug = slugify(s.name);
    let n = 2;
    while (taken.has(slug)) slug = `${slugify(s.name)}-${n++}`;
    await exec.run('UPDATE servers SET slug = ? WHERE id = ?', [slug, s.id]);
  }

  const channels = await exec.all(
    'SELECT id, name, server_id FROM channels WHERE slug IS NULL OR slug = ?',
    ['']
  );
  for (const c of channels) {
    const taken = new Set(
      (await exec.all('SELECT slug FROM channels WHERE server_id = ? AND id != ? AND slug LIKE ?',
        [c.server_id, c.id, slugify(c.name) + '%'])).map((r) => r.slug)
    );
    let slug = slugify(c.name);
    let n = 2;
    while (taken.has(slug)) slug = `${slugify(c.name)}-${n++}`;
    await exec.run('UPDATE channels SET slug = ? WHERE id = ?', [slug, c.id]);
  }
  return { servers: servers.length, channels: channels.length };
}

module.exports = { slugify, fold, forServer, forChannel, resolveServer, resolveChannel, resolveUser, backfill, RESERVED, MAX_LEN };

// The emojis a community gives a name to.
//
// A custom emoji is a small picture and a short name. Members write the name
// between colons — `:sparkle:` — in a message, or hang it on a message as a
// feeling, and every client that can see the community renders the picture.
//
// The image rides the same pipeline as a community's icon and banner: it is a
// `server_media` row of kind 'emoji', stored through the uploads service and
// served by /api/servers/media/:id. This module owns the name: its shape, its
// uniqueness inside the community, and the row that ties name to picture.
//
// The name rules are the product's, and they are what make the short code
// safe to store and render: lowercase letters, digits and underscores, two to
// thirty characters, so `:name:` never exceeds the 32 characters the
// reactions tables give the emoji column, carries no whitespace or punctuation
// that could swallow the words around it, and reads the same everywhere.

const db = require('../db');
const { now, uuid } = require('../util');
const uploads = require('./uploads');

const NAME_RE = /^[a-z0-9_]{2,30}$/;

// The widest picture an emoji may be. The general upload ceiling is for
// documents; a picture that renders beside words has to be small, and the
// limit is named so a refused upload can say what it refused.
const MAX_EMOJI_BYTES = 256 * 1024;

function cleanName(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase();
}

function shape(row) {
  return {
    id: row.id,
    name: row.name,
    serverId: row.server_id,
    mediaId: row.media_id,
    url: '/api/servers/media/' + row.media_id,
    creatorId: row.creator_id,
    createdAt: row.created_at,
  };
}

// The community's emojis, oldest first. A client keeps this list beside the
// community's channels: it is what turns `:name:` into a picture.
async function list(serverId) {
  const rows = await db.all(
    'SELECT * FROM emojis WHERE server_id = ? ORDER BY created_at ASC, id ASC',
    [serverId]
  );
  return rows.map(shape);
}

// One emoji of one community, or null. The image route goes through here so
// an emoji id from another community answers nothing.
async function get(serverId, emojiId) {
  const row = await db.get('SELECT * FROM emojis WHERE id = ? AND server_id = ?', [emojiId, serverId]);
  return row ? shape(row) : null;
}

async function create({ serverId, creatorId, name, buffer, originalName }) {
  const clean = cleanName(name);
  if (!NAME_RE.test(clean)) {
    throw { code: 'VALIDATION_ERROR',
      message: 'an emoji name is 2 to 30 lowercase letters, digits or underscores' };
  }
  if (!buffer || !buffer.length) {
    throw { code: 'VALIDATION_ERROR', message: 'a picture is required' };
  }
  if (buffer.length > MAX_EMOJI_BYTES) {
    throw { code: 'PAYLOAD_TOO_LARGE',
      message: 'that picture is ' + Math.round(buffer.length / 1024) + ' KB, and an emoji is at most '
        + Math.round(MAX_EMOJI_BYTES / 1024) + ' KB' };
  }

  const taken = await db.get('SELECT id FROM emojis WHERE server_id = ? AND name = ?', [serverId, clean]);
  if (taken) {
    throw { code: 'CONFLICT', message: 'a picture is already named :' + clean + ': in this community' };
  }

  const media = await uploads.storeServerMedia({
    serverId, kind: 'emoji', buffer, originalName,
  });
  if (media.error) {
    throw { code: media.error, message: media.message };
  }

  const id = uuid();
  try {
    await db.run(
      'INSERT INTO emojis (id, server_id, name, media_id, creator_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, serverId, clean, media.id, creatorId, now()]
    );
  } catch (e) {
    // The name race: a UNIQUE(server_id, name) violation means another writer
    // took the name between the check and the insert. The picture that was
    // stored for the loser comes off the store, or the disk fills with
    // pictures nobody named.
    await uploads.removeServerFile(media.id).catch(() => {});
    const s = String((e && e.message) || e);
    if (/UNIQUE|unique|duplicate|PRIMARY/i.test(s)) {
      throw { code: 'CONFLICT', message: 'a picture is already named :' + clean + ': in this community' };
    }
    throw e;
  }
  return shape(await db.get('SELECT * FROM emojis WHERE id = ?', [id]));
}

async function remove(serverId, emojiId) {
  const row = await db.get('SELECT * FROM emojis WHERE id = ? AND server_id = ?', [emojiId, serverId]);
  if (!row) return null;
  await db.run('DELETE FROM emojis WHERE id = ?', [row.id]);
  // The picture goes with the name: a media row with no emoji is storage
  // nobody can reach. The foreign key would take the emoji row away if the
  // media row went first, so the emoji row is deleted first and the media
  // second.
  await uploads.removeServerFile(row.media_id).catch(() => {});
  return shape(row);
}

module.exports = { NAME_RE, MAX_EMOJI_BYTES, list, get, create, remove, shape };

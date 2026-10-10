// Small shared helpers. Deliberately short: anything here that grows a second caller
// with different needs is a sign it should be two things.

const crypto = require('crypto');

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

// A URL-safe opaque token: 32 bytes of entropy, base64url, no padding.
const opaqueToken = () => crypto.randomBytes(32).toString('base64url');

const isUuid = (v) => typeof v === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// A stable colour for an account with no avatar, derived from the name so the same
// person is always the same tone. Every entry is a dark, low-saturation warm tone, so a
// screen full of them reads as one product rather than as a bag of sweets.
const AVATAR_COLORS = [
  '#4a3f36', '#3f463c', '#4d4438', '#453a3a', '#3a4046',
  '#524a3f', '#414839', '#4a3f42', '#3e4540', '#514535',
];

function hashColor(str) {
  const s = String(str || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function slug(text) {
  const base = String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'community';
}

// Display-only name: no paths, no control characters, capped length. A label, never a
// filesystem path.
function cleanFilename(name) {
  return String(name || 'upload')
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 150) || 'upload';
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : (many || one + 's')}`;
}

module.exports = {
  now, uuid, opaqueToken, isUuid,
  hashColor, slug, cleanFilename, plural,
};

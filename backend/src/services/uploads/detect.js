// What is this file, actually?
//
// Two decisions live here and nothing else does them.
//
// The first is that a file's type is detected, never declared. The client says what it
// likes in its Content-Type and that header is ignored entirely; the answer comes from
// magic bytes, with text formats checked for actually looking like text so that binary
// garbage with a .txt alias does not pass.
//
// The second is the policy that makes "accept anything" safe. A file we cannot place is
// not refused - it is stored as application/octet-stream and served as a download. The
// risk was never that a file exists; it is that a browser is asked to interpret it. So
// interpretation is decided here, on the way out, by INLINE_MIMES: an .html or .svg
// attachment goes out as a download rather than as a script running on the app's origin
// with the reader's session.

const MAX_SIZE = 8 * 1024 * 1024; // bytes
const MAX_ATTACHMENTS_PER_MESSAGE = 10;

const EXT_FOR_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
};

// Magic-byte check for the binary types we accept. Returns the sniffed MIME or null.
// Never trusts the client-supplied Content-Type.
function sniffBinary(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) return 'image/webp';
  if (buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  return null;
}

// Identity media - an avatar, a community icon or banner - is an image and nothing
// else. sniffBinary also recognises PDF, so the check has to name what it wants rather
// than test for "something recognisable": both call sites used to promise images only
// and quietly accept a PDF.
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// Whitelisted text files must be plausible text: no NUL, no unexpected C0 control bytes,
// and nothing that decodes to U+FFFD (invalid UTF-8).
function sniffText(buf, ext) {
  const mime = EXT_FOR_MIME['text/' + ext];
  const allowed = ext === 'txt' ? 'text/plain' : ext === 'md' ? 'text/markdown' : ext === 'csv' ? 'text/csv' : ext === 'json' ? 'application/json' : null;
  const resolved = allowed || mime;
  if (!resolved) return null;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0) return null;
    if (b < 0x20 && b !== 9 && b !== 10 && b !== 13 && b !== 12) return null;
    if (b === 0x7f) return null;
  }
  if (buf.toString('utf8').indexOf('\uFFFD') !== -1) return null;
  return resolved;
}

function safeExt(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : '';
}

// Display-only name: no paths, no control characters, capped length. It is a label,
// never a filesystem path.
function cleanFilename(name) {
  const s = String(name || 'upload')
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 150);
  return s || 'upload';
}

// A file we cannot place is not refused - it is stored as opaque bytes. Calling it
// text/plain because the bytes happen to be printable would put an .html or an .svg in
// the inline set and quietly decide what a browser may do with it.
const UNKNOWN_MIME = 'application/octet-stream';

// Types a browser may be allowed to interpret on this origin. Everything else goes out
// as an attachment no matter what it claims to be.
const INLINE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf',
  'text/plain', 'text/markdown', 'text/csv', 'application/json',
]);

function isInlineMime(mime) {
  return INLINE_MIMES.has(String(mime || '').toLowerCase());
}

// How a stored file is sent, whichever route is serving it.
//
// Two headers, and the first is the one the inline set above depends on: without nosniff
// a browser may run bytes the server meant as data regardless of the Content-Type that
// was sent with them, which would make the allowlist decorative. The second says the
// response is per-viewer, because every file here is behind an authorisation check and a
// shared cache must not keep it.
//
// These three lines were written out at each of the three routes that serve a stored file
// - a message attachment, an avatar, a community icon - and had already drifted, two
// setting them in one order and the third in another. Content-Type is not here because it
// genuinely differs: an attachment is served as its own type when it is inline and as
// octet-stream when it is not, and the route is what knows.
function sendHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=3600');
}

function detectMime(buf, originalName) {
  const bin = sniffBinary(buf);
  if (bin) return bin;
  const text = sniffText(buf, safeExt(originalName));
  if (text) return text;
  return UNKNOWN_MIME;
}

// Allow ids from the wire to be used safely in SQL IN lists. Strict on purpose: only
// uuid-shaped strings pass.
const ID_RE = /^[a-f0-9-]{1,64}$/i;
function sanitizeIds(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => typeof x === 'string' && ID_RE.test(x))
    .slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
}

module.exports = {
  MAX_SIZE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  EXT_FOR_MIME,
  IMAGE_MIMES,
  UNKNOWN_MIME,
  sniffBinary,
  safeExt,
  cleanFilename,
  isInlineMime,
  sendHeaders,
  detectMime,
  sanitizeIds,
};

// Bytes, and the encodings the wire uses.
//
// The server's primitives speak base64url without padding, raw 32-byte keys and
// UTF-8 text. Everything that crosses between the two halves of Trycord is one
// of those three, so they are defined once here and used everywhere: a key
// encoded one way and decoded another is a bug that looks like a broken
// protocol.
//
// The base64url here is strict. The server's decoder is lenient - Node's
// decoder ignores what it does not understand - but the only strings that ever
// cross the wire are the ones this file produced, and refusing anything else
// is what lets the envelope validation say "this is not base64url" and mean it.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const DECODE = new Map();
for (let i = 0; i < ALPHABET.length; i += 1) DECODE.set(ALPHABET[i], i);

/** The largest number of bytes getRandomValues() will fill in one call. */
const RANDOM_CHUNK = 65536;

/** Whether a value is a byte string. */
export function isBytes(value) {
  return value instanceof Uint8Array;
}

/** UTF-8 bytes of a string. */
export function utf8(text) {
  return new TextEncoder().encode(String(text));
}

/** The string a byte string holds, read as UTF-8. */
export function fromUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

/** Bytes of a hexadecimal string. */
export function fromHex(text) {
  const clean = String(text).trim();
  if (clean.length % 2 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error('not a hexadecimal string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** The hexadecimal form of a byte string. */
export function hex(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** One byte string after another. */
export function concatBytes(...parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Four bytes, big-endian: a counter that cannot be re-spelled. */
export function u32be(value) {
  const out = new Uint8Array(4);
  const n = Number(value) >>> 0;
  out[0] = (n >>> 24) & 0xff;
  out[1] = (n >>> 16) & 0xff;
  out[2] = (n >>> 8) & 0xff;
  out[3] = n & 0xff;
  return out;
}

/** base64url, without padding: the encoding every key travels in. */
export function b64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += ALPHABET[(triple >>> 18) & 63];
    out += ALPHABET[(triple >>> 12) & 63];
    if (i + 1 < bytes.length) out += ALPHABET[(triple >>> 6) & 63];
    if (i + 2 < bytes.length) out += ALPHABET[triple & 63];
  }
  return out;
}

/**
 * The bytes a base64url string holds.
 *
 * Anything that is not base64url is refused rather than decoded as far as it
 * can: a truncated key is a key that opens nothing, and a caller that cannot
 * tell a truncated key from a whole one will use it.
 */
export function unb64(text) {
  if (typeof text !== 'string' || !text.length) {
    throw new Error('expected a base64url string');
  }
  if (text.length % 4 === 1) {
    throw new Error('not a base64url string');
  }
  const out = new Uint8Array((text.length * 3) / 4 | 0);
  let at = 0;
  for (let i = 0; i < text.length; i += 4) {
    const a = DECODE.get(text[i]);
    const b = DECODE.get(text[i + 1]);
    const c = text.length > i + 2 ? DECODE.get(text[i + 2]) : undefined;
    const d = text.length > i + 3 ? DECODE.get(text[i + 3]) : undefined;
    if (a === undefined || b === undefined) throw new Error('not a base64url string');
    if (c === undefined && text.length > i + 2) throw new Error('not a base64url string');
    if (d === undefined && text.length > i + 3) throw new Error('not a base64url string');
    out[at] = (a << 2) | (b >>> 4);
    at += 1;
    if (c === undefined) break;
    out[at] = ((b & 15) << 4) | (c >>> 2);
    at += 1;
    if (d === undefined) break;
    out[at] = ((c & 3) << 6) | d;
    at += 1;
  }
  return out.subarray(0, at);
}

/** Whether two byte strings hold the same bytes. */
export function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i] ^ b[i];
  return difference === 0;
}

/** Random bytes from the platform's generator. */
export function randomBytes(length) {
  const out = new Uint8Array(length);
  const source = globalThis.crypto;
  if (!source || typeof source.getRandomValues !== 'function') {
    throw new Error('this browser has no secure random source');
  }
  for (let at = 0; at < out.length; at += RANDOM_CHUNK) {
    source.getRandomValues(out.subarray(at, Math.min(at + RANDOM_CHUNK, out.length)));
  }
  return out;
}

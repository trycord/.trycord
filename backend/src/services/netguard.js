// Where this instance is allowed to reach out to.
//
// One guard, used by every subsystem that fetches an address somebody else
// chose: the federation peer probe, the discovery directory reader, and
// anything added later. Two copies of these rules would drift, and a rule
// that drifted is how a private network gets reached by accident.
//
// What is refused:
//   - a host that resolves into a private, loopback, link-local or multicast
//     range, unless the operator has explicitly allowed local addresses
//   - the cloud metadata endpoints, by name and by their well-known address
//   - embedded credentials in a URL
//   - a scheme that is not http or https
//
// What is not this module's business: whether the peer is trusted, whether the
// answer is welcome, what the response says. Those belong to the caller.

const dns = require('dns').promises;
const net = require('net');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 262144;

function isIpv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map((x) => Number(x));
  if (o.some((x) => x > 255)) return null;
  return o;
}

function isPrivateIpv4(o) {
  if (o[0] === 10) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 169 && o[1] === 254) return true;
  if (o[0] === 127) return true;
  if (o[0] === 0) return true;
  if (o[0] >= 224 && o[0] <= 239) return true;
  return false;
}

function isPrivateIpv6(host) {
  const h = host.toLowerCase();
  if (h === '::1' || h === '[::1]') return true;
  if (h.startsWith('::ffff:')) {
    // An IPv4-mapped address is an IPv4 address wearing a hat.
    const mapped = h.slice(7);
    const o = isIpv4(mapped);
    return o ? isPrivateIpv4(o) : true;
  }
  if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

const METADATA_NAMES = ['metadata.google.internal', 'metadata', 'instance-data', 'magic-mirror'];

// Whether a host name is one this instance refuses to reach.
function forbiddenHost(host, options) {
  const opts = options || {};
  const allowLocal = !!opts.allowLocalhost;
  const h = String(host || '').toLowerCase().trim();
  if (h === '' || h === 'localhost' || h === '::1' || h === '[::1]') return !allowLocal;

  const o = isIpv4(h);
  if (o) {
    if (o[0] === 127) return !allowLocal;
    return isPrivateIpv4(o);
  }
  if (net.isIPv6(h.replace(/^\[|\]$/g, ''))) {
    if (isPrivateIpv6(h)) return !allowLocal;
    return false;
  }
  if (METADATA_NAMES.indexOf(h) !== -1) return true;
  if (h.startsWith('.') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  return false;
}

// Checks an origin and returns it normalised, or throws with a reason.
function validateOrigin(origin, options) {
  const opts = options || {};
  const text = String(origin || '').trim();
  if (!text) throw new Error('origin is required');
  if (text.includes('@')) throw new Error('origin must not contain credentials');

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('origin must be a valid http(s) URL');
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') throw new Error('origin must be http(s)');
  if (url.username || url.password) throw new Error('origin must not contain credentials');

  const host = url.hostname.toLowerCase();
  const isLoopback = host === 'localhost' || host === '::1' || host === '[::1]'
    || (isIpv4(host) && isIpv4(host)[0] === 127);

  // A loopback address is refused unless the caller explicitly opted in.
  // Treating it as always-allowed would turn every caller into a way into the
  // host's own network.
  if (forbiddenHost(host, { allowLocalhost: !!opts.allowLocalhost })) {
    throw new Error('origin host is not allowed');
  }
  if (scheme === 'http:' && !isLoopback && !opts.allowInsecure) {
    throw new Error('origin must use https');
  }
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return url.origin + path;
}

// A DNS answer that points into a private range is refused even when the name
// itself looked harmless: a name that resolves to 127.0.0.1 is the classic
// way past a hostname check.
async function resolvesToPrivate(host, options) {
  const opts = options || {};
  const allowLocal = !!opts.allowLocalhost;
  const h = String(host || '').toLowerCase().trim();
  if (isIpv4(h) || net.isIPv6(h.replace(/^\[|\]$/g, ''))) {
    return forbiddenHost(h, { allowLocalhost: allowLocal });
  }
  let answers;
  try {
    answers = await dns.lookup(h, { all: true });
  } catch {
    return true;
  }
  for (const answer of answers) {
    const addr = String(answer.address || '').toLowerCase();
    if (net.isIPv6(addr) && isPrivateIpv6(addr)) return true;
    const o = isIpv4(addr);
    if (!o) continue;
    if (o[0] === 127) return !allowLocal;
    if (isPrivateIpv4(o)) return true;
  }
  return false;
}

// Fetches a JSON document from an address somebody else chose.
//
// The rules: the origin is validated, the name is resolved and checked, no
// redirect is followed (a redirect is the easiest way to arrive somewhere
// else), the response is bounded in size and time, and only a JSON body is
// accepted. Returns { ok, status, data } or { ok:false, error }.
async function fetchJson(url, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;

  let origin;
  try {
    origin = validateOrigin(url, opts);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  let target;
  try {
    target = new URL(origin);
  } catch {
    return { ok: false, error: 'origin is not a valid URL' };
  }

  if (await resolvesToPrivate(target.hostname, opts)) {
    return { ok: false, error: 'origin host is not allowed' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(target.toString(), {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return { ok: false, error: 'answered HTTP ' + res.status };
    }
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    if (type && !type.includes('json')) {
      return { ok: false, error: 'answered with ' + type + ' rather than JSON' };
    }
    const text = await readBounded(res, maxBytes);
    if (text === null) return { ok: false, error: 'the answer was too large' };
    try {
      return { ok: true, status: res.status, data: JSON.parse(text) };
    } catch {
      return { ok: false, error: 'the answer was not JSON' };
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, error: 'the request timed out' };
    return { ok: false, error: (e && e.message) || 'the request failed' };
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(res, maxBytes) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) {
    const text = await res.text();
    return text.length > maxBytes ? null : text;
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch { /* already closed */ }
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

module.exports = {
  forbiddenHost,
  validateOrigin,
  resolvesToPrivate,
  fetchJson,
  isPrivateIpv4,
  isPrivateIpv6,
};

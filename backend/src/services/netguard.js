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
const dnsCallback = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

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

// Whether an address is one this instance refuses to reach.
//
// A complete list of the ranges that are not the public internet, so that a
// name which answers with one of them cannot be used to reach the network
// the instance sits in. The ranges that matter are the private ones, the
// loopback one, the link-local one - which is where the cloud metadata
// endpoints live - and the ranges that are neither public nor routable.
function isPrivateAddress(address) {
  const raw = String(address || '').trim().toLowerCase();
  if (!raw) return true;
  const o = isIpv4(raw);
  if (o) {
    if (o[0] === 0 || o[0] === 10 || o[0] === 127) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 169 && o[1] === 254) return true;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // carrier-grade NAT
    if (o[0] === 192 && o[1] === 0 && o[2] === 0) return true; // IETF protocol assignments
    if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return true; // benchmarking
    if (o[0] >= 224) return true; // multicast and reserved
    return false;
  }
  const bare = raw.replace(/^\[|\]$/g, '');
  if (net.isIPv6(bare)) {
    if (bare === '::' || bare === '::1') return true;
    if (bare.startsWith('::ffff:')) return isPrivateAddress(bare.slice(7));
    if (bare.startsWith('fe80') || bare.startsWith('fc') || bare.startsWith('fd')) return true;
    // The documentation range, and the unique-local range in its other spellings.
    if (bare.startsWith('2001:db8')) return true;
    return false;
  }
  // Not an address at all: treat it as a name and let the caller resolve it.
  return forbiddenHost(raw, {});
}

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

// A DNS lookup that refuses to hand back a private address.
//
// The check that a name resolves to a public address, and the connection
// that follows it, are two different resolutions of the same name. A name
// with a short TTL can answer one way for the check and another way for the
// connection, and the second answer is the one that is connected to - which
// is how a hostname check is walked past.
//
// So the address that is connected to is the address that was checked: the
// lookup is done here, and the result is refused if it is not a public
// address.
function guardedLookup(hostname, options, callback) {
  const done = typeof options === 'function' ? options : callback;
  const flags = typeof options === 'function' ? {} : (options || {});
  const allowLocal = !!(flags.trycordAllowLocalhost);
  dnsCallback.lookup(hostname, { all: false }, (error, address, family) => {
    if (error) return done(error);
    if (!allowLocal && isPrivateAddress(address)) {
      return done(new Error('that host resolves to a private address'));
    }
    done(null, address, family);
  });
}

// Fetches an HTML document from an address somebody else chose.
//
// The rules, all of them about the fact that the instance is doing the
// asking and the other side is choosing:
//
//   - the name is resolved and checked, and the address connected to is the
//     address that was checked;
//   - redirects are followed one at a time and every hop is checked before
//     it is fetched, so a redirect into the instance's own network is
//     refused rather than fetched and then noticed;
//   - there is a cap on the number of hops, on the time and on the size;
//   - only HTML is read.
//
// Returns { ok, status, html, finalUrl } or { ok: false, error }.
async function fetchHtml(url, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects === undefined ? 3 : opts.maxRedirects;
  const accept = opts.accept || 'text/html,application/xhtml+xml';
  const userAgent = opts.userAgent || 'TrycordBot/1.0 (+link preview)';

  let target;
  try { target = new URL(String(url)); } catch { return { ok: false, error: 'not a URL' }; }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { ok: false, error: 'only http and https are fetched' };
  }
  if (target.username || target.password) {
    return { ok: false, error: 'the URL carries credentials' };
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (await resolvesToPrivate(target.hostname, { allowLocalhost: !!opts.allowLocalhost })) {
      return { ok: false, error: 'that host resolves to a private address' };
    }
    const answer = await request(target, {
      timeoutMs, maxBytes, accept, userAgent,
      allowLocalhost: !!opts.allowLocalhost,
    });
    if (answer.error) return answer;
    if (answer.redirect) {
      let next;
      try { next = new URL(answer.location, target); } catch {
        return { ok: false, error: 'the redirect was not a URL' };
      }
      if (next.protocol !== 'https:' && next.protocol !== 'http:') {
        return { ok: false, error: 'the redirect left http and https' };
      }
      if (next.username || next.password) {
        return { ok: false, error: 'the redirect carried credentials' };
      }
      target = next;
      continue;
    }
    return answer;
  }
  return { ok: false, error: 'too many redirects' };
}

// One request, without following anything.
function request(target, opts) {
  return new Promise((resolve) => {
    const transport = target.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };

    const req = transport.request(target, {
      method: 'GET',
      // The lookup is told whether a local address is allowed, so the
      // address that is connected to is the one that was checked.
      lookup: (hostname, flags, done) => guardedLookup(
        hostname, { ...(flags || {}), trycordAllowLocalhost: opts.allowLocalhost }, done,
      ),
      headers: { Accept: opts.accept, 'User-Agent': opts.userAgent },
      // The address is checked by the lookup, so the connection cannot land
      // somewhere the check did not look at.
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        finish({ redirect: true, location: res.headers.location });
        return;
      }
      const type = String(res.headers['content-type'] || '').toLowerCase();
      if (status < 200 || status >= 300) {
        res.resume();
        finish({ ok: false, error: 'answered HTTP ' + status });
        return;
      }
      if (type && !/text\/html|application\/xhtml/.test(type)) {
        res.resume();
        finish({ ok: false, error: 'answered with ' + type + ' rather than HTML', contentType: type });
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > opts.maxBytes) {
          res.destroy();
          finish({ ok: false, error: 'the answer was too large' });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        finish({
          ok: true,
          status,
          html: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'),
          finalUrl: target.toString(),
        });
      });
      res.on('error', (error) => finish({ ok: false, error: error.message }));
    });

    req.setTimeout(opts.timeoutMs, () => {
      req.destroy();
      finish({ ok: false, error: 'the request timed out' });
    });
    req.on('error', (error) => finish({ ok: false, error: error.message }));
    req.end();
  });
}

// Assert that a host may be reached.
//
// The check is the one `fetchJson` makes, reduced to the question on its own:
// is this host somewhere the instance is allowed to go? It is what a caller
// asks before it fetches a URL somebody else chose - a link preview's image,
// a webhook's endpoint - where the answer has to be "yes" before the request
// is made rather than after.
//
// The name it had in the callers - `assertPublicHost` - is what it is called
// there, and the function was **not exported**. The import therefore resolved
// to `undefined`, every call raised a TypeError, and the callers caught it:
// every link preview came back "unavailable" and every outgoing webhook was
// refused with "must be a public address". The hole was closed by accident,
// and removing the dead call would have opened it.
//
// So it exists, and it throws rather than returning a boolean: a caller that
// forgets to handle the refusal should fail loudly.
async function assertPublicHost(host, options = {}) {
  const name = String(host || '').trim().toLowerCase();
  if (!name) {
    throw new Error('a host is required');
  }
  if (forbiddenHost(name, options)) {
    throw new Error('that host is not a public address');
  }
  if (await resolvesToPrivate(name, options)) {
    throw new Error('that host resolves to a private address');
  }
  return true;
}

module.exports = {
  forbiddenHost,
  validateOrigin,
  resolvesToPrivate,
  fetchJson,
  fetchHtml,
  assertPublicHost,
  isPrivateAddress,
  isPrivateIpv4,
  isPrivateIpv6,
};

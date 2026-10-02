// Outbound-address guards.
//
// This instance fetches URLs on an admin's or a user's say-so: link previews and
// webhook deliveries. Both are SSRF surfaces, and both would let a caller aim a
// request at 169.254.169.254 or 127.0.0.1 and read the response back into this
// application. So the rule lives here, once, rather than in each caller.
//
// The check has two halves, and the second half is the one that usually gets
// missed: a hostname that was public when it was validated can resolve to a
// private address by the time the request is made (DNS rebinding). Callers
// therefore validate at save time *and* call assertPublicHost immediately before
// connecting.

const net = require('net');
const dns = require('dns').promises;

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    if (p[0] >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::') return true;
    if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (m) return isPrivateAddress(m[1]);
    return false;
  }
  // Not an address at all, so it cannot be judged. Treat as unsafe: the caller
  // wants a guard, and guessing "safe" is the wrong way to be wrong.
  return true;
}

// Resolves once and checks every answer, so a name with one public and one
// private A record cannot be used by picking the public one.
async function assertPublicHost(hostname) {
  const literal = net.isIP(hostname);
  const addrs = literal
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true });
  if (!addrs.length) throw new Error('host did not resolve');
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new Error('host is not public');
  }
  return addrs[0].address;
}

// Validates a URL for an outbound request this instance will make.
async function assertSafeUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { const e = new Error('not a URL'); e.code = 'VALIDATION_ERROR'; throw e; }
  if (u.protocol !== 'https:') { const e = new Error('url must be https'); e.code = 'VALIDATION_ERROR'; throw e; }
  if (u.username || u.password) { const e = new Error('url must not contain credentials'); e.code = 'VALIDATION_ERROR'; throw e; }
  await assertPublicHost(u.hostname);
  return u;
}

module.exports = { isPrivateAddress, assertPublicHost, assertSafeUrl };
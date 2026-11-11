// Which origins this instance answers.
//
// Split out of server.js because it is the part of the boot a reader most needs to be
// able to check on its own, and it is the part where a mistake is a security mistake
// rather than a cosmetic one. It decides who may talk to a self-hosted Trycord, and the
// desktop app's custom scheme is the case that keeps biting: it can never be inferred the
// way localhost and file: can, so it has to be allowlisted by name.
//
// Nothing here reaches into the rest of the boot. Given a list of configured origins, it
// answers one question: may this origin have the response?

function originCovers(pattern, origin) {
  // The bare-star refusal comes first. A "*" pattern can never be honoured, and having
  // the check after the equality test meant "*" matched the literal origin "*" - which no
  // browser sends, so it was harmless, and it meant the rule held by luck rather than by
  // construction.
  if (pattern === '*') return false;

  // Hostnames are case-insensitive and browsers send them lowercased, so a configured
  // origin written as CLIENT_ORIGIN=https://TRYCord.dev was refused with nothing to say
  // why. The wildcard branch below already lowercased before comparing; this one did not,
  // so the two disagreed about the same host.
  const wanted = String(pattern || '').toLowerCase();
  const given = String(origin || '').toLowerCase();
  if (wanted === given) return true;
  if (!pattern.includes('*')) return false;

  // The only wildcard form supported is a "*." label at the start of the HOST:
  //   https://*.trycord.dev
  // Written with string operations rather than a regex on purpose - the
  // pattern is not a valid URL (that is the whole point of the wildcard), and
  // an escaped-delimiter regex for it is easy to get subtly wrong.
  const schemeEnd = pattern.indexOf('://');
  if (schemeEnd < 0) return false;
  const scheme = pattern.slice(0, schemeEnd);
  if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme)) return false;  // literal scheme only
  const hostPart = pattern.slice(schemeEnd + 3);
  if (!hostPart.startsWith('*.')) return false;
  // No second wildcard anywhere else in the host or port.
  if (hostPart.slice(1).includes('*')) return false;

  let p, o;
  try {
    // Replace the "*" label only, keeping the dot that separates it from the
    // base host: "*.trycord.dev" -> "wildcard-label.trycord.dev".
    p = new URL(scheme + '://wildcard-label' + hostPart.slice(1));
    o = new URL(origin);
  } catch {
    return false;
  }
  // Wildcards only ever cover subdomains of an http(s) site. A custom-scheme
  // origin such as the desktop app's "trycord://app" is always matched exactly.
  if (p.protocol !== 'http:' && p.protocol !== 'https:') return false;
  if (p.protocol !== o.protocol) return false;
  if (p.port !== o.port) return false;
  // Hostnames are case-insensitive. Strip the label we just substituted back
  // off, leaving the base domain the wildcard actually covers.
  const base = p.hostname.toLowerCase().slice('wildcard-label.'.length);
  const host = o.hostname.toLowerCase();
  if (!base || !host.endsWith('.' + base)) return false;
  // Exactly one label: "a.trycord.dev" matches, "a.b.trycord.dev" does not, and
  // the bare apex is not covered by a "*." pattern.
  const label = host.slice(0, host.length - base.length - 1);
  return label.length > 0 && !label.includes('.');
}

// The desktop app's own origin. Registered as a privileged scheme in the
// Electron main process, so it has a real, non-opaque origin — which means the
// backend must allowlist it by name like any other client.
const DESKTOP_ORIGIN = 'trycord://app';

// A browser on the operator's own machine.
//
// The documented production allowlist is explicit, and an explicit allowlist
// used to disable the development loopback rule entirely. The result was a
// public site served at http://127.0.0.1:9971 asking an API on another origin
// for a sign-in, and the browser reporting an opaque network failure because
// the preflight came back without an Access-Control-Allow-Origin header.
//
// Loopback is safe to answer alongside an explicit allowlist: a page served
// from localhost is already running on the reader's machine, and this API
// authenticates with bearer tokens rather than ambient cookies. It is not a
// wildcard and it cannot name a remote host.
function isLoopbackOrigin(origin) {
  try {
    const u = new URL(String(origin || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]') return true;
    const v4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(u.hostname);
    return !!v4 && [v4[1], v4[2], v4[3]].every((part) => Number(part) <= 255);
  } catch {
    return false;
  }
}


// Origins already explained, so a misconfiguration is logged once rather than
// on every request.
const refusedOrigins = new Set();

function warnRefusedOrigin(origin, clientOrigins) {
  if (refusedOrigins.has(origin)) return;
  refusedOrigins.add(origin);
  // The desktop app is the case that actually bites: it is a custom scheme, so
  // it can never be inferred the way localhost or file: can.
  if (origin.startsWith('trycord:')) {
    console.warn(
      '[warn] refused origin ' + origin + ' - this is the desktop app scheme. '
      + 'Add it to CLIENT_ORIGIN, e.g. CLIENT_ORIGIN='
      + (clientOrigins.length ? clientOrigins.join(',') + ',' : '')
      + DESKTOP_ORIGIN
    );
    return;
  }
  console.warn('[warn] refused origin ' + origin + ' (not matched by CLIENT_ORIGIN)');
}

// The origins the instance answers.
//
// `clientOrigins` is the operator's allowlist. `ownOrigins` is the address
// the instance itself is published at - the instance's own origin, and the
// origin of the global directory it belongs to.
//
// The instance's own origin is always answered, and it is not a
// cross-origin question in the first place: a request from the instance's
// own site carries that site's origin, and it arrived on that origin.
// Refusing it meant the instance sent no Access-Control-Allow-Origin header
// to its own site and logged a warning about itself at every boot.
function corsOptions(clientOrigins, ownOrigins) {
  const own = (ownOrigins || []).filter(Boolean);
  return {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl, same-origin navigations, health probes
      if (isLoopbackOrigin(origin)) return cb(null, true);
      if (own.some((p) => originCovers(p, origin))) return cb(null, true);
      if (clientOrigins.length) {
        if (clientOrigins.some((p) => originCovers(p, origin))) return cb(null, true);
        warnRefusedOrigin(origin, clientOrigins);
        return cb(null, false);
      }
      // "null" is a real Origin header - a sandboxed iframe or a data: document sends
      // it - and it is not a URL, so the constructor below throws on it and the check for
      // it was unreachable code. It has to be asked before parsing, not after.
      if (origin === 'null') return cb(null, true);
      try {
        const u = new URL(origin);
        const host = u.hostname;
        if (u.protocol === 'file:') return cb(null, true);
        if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return cb(null, true);
        warnRefusedOrigin(origin, clientOrigins);
        return cb(new Error('CORS: origin not allowed'));
      } catch {
        warnRefusedOrigin(origin, clientOrigins);
        return cb(new Error('CORS: origin not allowed'));
      }
    },
    // The same-origin answer rides with the request: the cors middleware
    // only hands the policy the Origin header, so the Host comparison
    // happens here, in the delegate it calls per request.
    credentials: true,
  };
}

// The delegate cors calls per request, so the same-origin question - "is
// this origin the address the request arrived at?" - can see the Host
// header. Without it, the instance refused its own LAN address: the page
// loaded, and every write from it was refused at the door, which read as an
// app that only worked after a reload. A request whose Origin is the very
// address it arrived at is the instance's own site speaking to itself -
// same-origin, never a cross-origin question.
function sameHostOf(origin, reqHost) {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = String(reqHost || '');
    const bracket = host.startsWith('[');
    const name = bracket ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
    const port = bracket ? (host.includes(']:') ? host.slice(host.indexOf(']:') + 2) : undefined)
      : (host.slice(name.length).startsWith(':') ? host.slice(name.length + 1) : undefined);
    if (u.hostname !== name) return false;
    const originPort = u.port || (u.protocol === 'https:' ? '443' : '80');
    const hostPort = port || (originPort === '443' ? '443' : '80');
    return String(originPort) === String(hostPort);
  } catch {
    return false;
  }
}

function corsDelegate(policy) {
  return (req, cb) => {
    const origin = req.headers.origin;
    if (origin && req.headers.host && sameHostOf(origin, req.headers.host)) {
      return cb(null, { origin: true, credentials: policy.credentials });
    }
    policy.origin(origin, cb);
  };
}

module.exports = {
  corsOptions,
  corsDelegate,
  originCovers,
  // The desktop app's own origin, which cannot be inferred and has to be named.
  DESKTOP_ORIGIN,
};

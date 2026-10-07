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

function corsOptions(clientOrigins) {
  return {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl, same-origin navigations, health probes
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
  };
}

module.exports = {
  corsOptions,
  originCovers,
  // The desktop app's own origin, which cannot be inferred and has to be named.
  DESKTOP_ORIGIN,
};

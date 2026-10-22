'use strict';

// The response-security policy the two server roles share.
//
// These headers used to be built inline in boot() of the API server. The
// split deployment gave the same responsibility to the frontend server -
// which serves the same web client and public site - and a policy copied by
// hand into a second file is a policy two copies of which will one day
// disagree. So the middleware lives here, and both entries call it. What it
// says is unchanged, line for line.
//
// Security headers. Hardens the app surface without breaking the documented
// cross-origin configuration (the client can be pointed at another API
// origin at runtime), so CSP connect-src origins are derived from runtime
// config plus a per-instance allowlist knob (CSP_CONNECT_ORIGINS in .env,
// comma-separated). The real app page has no inline scripts, so script-src
// is strict; the static showcase gallery is dev-only and exempted from that
// one rule.
//
// These are scheme-sources and host-sources and are emitted verbatim, so
// anything that means "this origin" has to carry its own quotes. An unquoted
// 'self' is not a valid source expression: the browser discards the directive
// it appears in, which for connect-src means every API call is refused and
// the application boots signed out with no error to explain it.

// The API the client talks to, and the one it falls back to. API_URL is the
// deployment's own name for that primary; TRYCORD_API_URL is the older name
// and still wins if set, so an existing deployment keeps its behaviour.
//
// The public URL is the last fallback. A process with no configured API
// origin is serving the API itself, so its own public address is the answer
// the client needs. The frontend server passes no instance here on purpose:
// its public address is not an API, and it is required to name the API
// explicitly (validated at start-up), so the fallback never fires for it.
function apiOrigin(inst) {
  const configured = String(process.env.TRYCORD_API_URL || process.env.API_URL || '').trim();
  if (configured) return configured;
  return String((inst && inst.publicUrl) || '');
}

// The failover origin, raw. Used as configured: it is validated where it is
// consumed, and a raw value keeps the same behaviour as before.
function apiBackup() {
  return String(process.env.API_BACKUP_URL || '').trim();
}

// Reduce a candidate to a bare origin string (scheme + host + port) or
// null. Origins cannot carry spaces, quotes, or semicolons, so the
// result is always safe to interpolate into the CSP header.
function cspOriginOf(o) {
  try {
    const u = new URL(String(o || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch { return null; }
}

// Build the middleware. The policy is computed once per process from
// configured origins and nothing else - never from request input. The
// client can be pointed at another API origin at runtime through backend.json
// or the settings selector, both of which the operator controls, but a query
// parameter must not be able to authorize one: an attacker link carrying
// ?api=<their origin> would otherwise be granted the exact connect-src
// allowance it needs to receive the reader's bearer-carrying requests, which
// is the policy defeating the thing it exists for. An origin the operator has
// not configured stays refused by the browser.
function securityHeaders({ inst } = {}) {
  const cspConnect = ["'self'", 'ws:', 'wss:'];
  const cspImg = ["'self'", 'data:', 'blob:'];
  const primary = apiOrigin(inst);
  const backup = apiBackup();
  const publicUrl = String((inst && inst.publicUrl) || '');
  const globalUrl = String((inst && inst.globalUrl) || '');
  const addCspOrigin = (o) => {
    try {
      const origin = new URL(o).origin;
      cspConnect.push(origin, origin.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:'));
      cspImg.push(origin);
    } catch { /* ignore unparseable */ }
  };
  // The backup has to be allowed here as well as the primary. A failover the
  // policy then refuses presents as an empty application rather than as a
  // switch, which is the same symptom as having no failover at all.
  [primary, backup, publicUrl, globalUrl].forEach((o) => o && addCspOrigin(o));
  // The two loopback origins, because an operator developing against this
  // instance reaches it from there. Nothing else is here by default.
  //
  // https://trycord.dev used to be in this list, which meant every self-hosted
  // instance shipped a Content-Security-Policy naming the official network - a
  // client served from somebody's own server was permitted to send its traffic
  // to it. Self-hosting is a property of the architecture, so an origin that
  // has nothing to do with the operator's instance does not belong in the
  // operator's policy. If they do want it, they set CSP_CONNECT_ORIGINS,
  // which is what that setting is for.
  ['http://localhost:9971', 'http://127.0.0.1:9971'].forEach(addCspOrigin);
  String(process.env.CSP_CONNECT_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean).forEach(addCspOrigin);

  const buildCsp = (allowInlineScripts) => {
    const connect = [...new Set(cspConnect)];
    return [
      "default-src 'self'",
      `connect-src ${connect.join(' ')}`,
      allowInlineScripts ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      `img-src ${[...new Set(cspImg)].join(' ')}`,
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
  };

  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', req.path.indexOf('showcase') !== -1 ? buildCsp(true) : buildCsp(false));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // Only over TLS: browsers ignore the header on a plain-http response, and keying
    // it off the request's own scheme keeps it correct behind a terminating proxy.
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    next();
  };
}

module.exports = { apiOrigin, apiBackup, cspOriginOf, securityHeaders };

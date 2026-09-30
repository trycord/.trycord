// hardcode a backend origin.

// Production backend. Public configuration — safe to expose, and the
export const DEFAULT_BACKEND_URL = 'https://trycord-api.wispbyte.app';
const LOCAL_BACKEND_URL = 'http://localhost:9971';

const LS_BACKEND = 'trycord.backendUrl';

let staticBackend = null; // from backend.json, loaded once at boot
// The origin backend.json configured, which is not necessarily the one in use:
// a failover moves staticBackend and must be reversible, so the configured value
// is kept. clearFailover restores this one.
let configuredBackend = null;
// Backup origins from the same file, tried in order when the primary cannot be
// reached. Only the hosted front end ships this key; a self-hoster's
// backend.json has no `fallbackUrls`, so an operator's own instance is never
// quietly repointed somewhere else.
let staticFallbacks = [];
let staticLoaded = false;

// Set when the client moved itself to a backup. Accounts, communities and
// messages live on one instance's database, so a silent switch looks to the
// user like a wrong password and an empty community list. This is what the UI
// reads to say what happened.
let failoverNotice = null;

function plausibleUrl(u) {
  if (!u) return null;
  const t = String(u).trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(t) ? t : null;
}

// The object literal that is the second argument of the first `Object.assign(`
// call in `text`, as { start, end } indexes of its braces.
//
// The first argument cannot be skipped by looking for the next '{': the snippet
// is `Object.assign(window.TRYCORD_CONFIG || {}, {...})`, so that finds the
// fallback object and yields `{}`. This walks the parentheses to the top-level
// comma that ends the first argument instead. String-aware, so a paren or comma
// inside a JSON string value does not count.
function secondArgObjectLiteral(text) {
  const callAt = text.indexOf('Object.assign(');
  if (callAt === -1) return null;
  const argsStart = callAt + 'Object.assign('.length;

  let depth = 0, inStr = false, esc = false, argStart = argsStart;
  for (let k = argsStart; k < text.length; k++) {
    const ch = text[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return null; // call ended without a second argument
      depth--;
    } else if (ch === ',' && depth === 0) {
      // Start of the second argument; take its first balanced object.
      const start = text.indexOf('{', k + 1);
      if (start === -1) return null;
      let d = 0, s = false, e = false;
      for (let m = start; m < text.length; m++) {
        const c2 = text[m];
        if (s) {
          if (e) e = false;
          else if (c2 === '\\') e = true;
          else if (c2 === '"') s = false;
          continue;
        }
        if (c2 === '"') s = true;
        else if (c2 === '{') d++;
        else if (c2 === '}') {
          d--;
          if (d === 0) return { start, end: m };
        }
      }
      return null;
    }
    void argStart;
  }
  return null;
}

function plausibleUrlList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const u = plausibleUrl(item);
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

// call is cross-origin, and the backend has to allowlist that scheme explicitly
// — a browser or a static host never has to. So a failed probe from here is far
// more likely to be a missing CLIENT_ORIGIN entry than a dead host, and saying
// so saves the reader a debugging session.
function looksLikeAppOrigin() {
  try {
    const p = String(location.protocol || '').toLowerCase();
    return p.length > 1 && p !== 'http:' && p !== 'https:' && p !== 'file:';
  } catch {
    return false;
  }
}

function readRuntimeConfig() {
  try {
    return window.TRYCORD_CONFIG && typeof window.TRYCORD_CONFIG === 'object' ? window.TRYCORD_CONFIG : {};
  } catch {
    return {};
  }
}

function isLocalContext() {
  try {
    const p = window.location.protocol;
    if (p === 'file:' || p === 'about:') return true;
    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '';
  } catch {
    return true;
  }
}

function resolveBackend() {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('api');
    const v = plausibleUrl(fromQuery);
    if (v) return { url: v, source: 'launch argument' };
  } catch { /* ignore */ }

  try {
    const saved = plausibleUrl(localStorage.getItem(LS_BACKEND));
    if (saved) return { url: saved, source: 'saved setting' };
  } catch { /* ignore */ }

  if (staticBackend) return { url: staticBackend, source: 'backend.json' };

  const pinned = plausibleUrl(readRuntimeConfig().API_URL);
  if (pinned) return { url: pinned, source: 'server pin' };

  if (isLocalContext()) return { url: LOCAL_BACKEND_URL, source: 'local default' };
  return { url: DEFAULT_BACKEND_URL, source: 'production default' };
}

export const TrycordConfig = {
  LS_API: LS_BACKEND,
  DEFAULT_BACKEND_URL,

  backendUrl() {
    return resolveBackend().url;
  },

  backendSource() {
    return resolveBackend().source;
  },

  apiUrl() {
    return resolveBackend().url;
  },

  // Derive the WebSocket origin from the backend:
  wsUrl(ticket) {
    const base = resolveBackend().url.replace(/^http/i, 'ws');
    return base + '/?ticket=' + encodeURIComponent(ticket);
  },

  async loadStaticConfig() {
    if (staticLoaded) return staticBackend;
    staticLoaded = true;
    try {
      const res = await fetch('./backend.json', { cache: 'no-store' });
      if (!res.ok) return null;
      const json = await res.json();
      staticBackend = plausibleUrl(json && json.backendUrl);
      configuredBackend = staticBackend;
      staticFallbacks = plausibleUrlList(json && json.fallbackUrls);
      return staticBackend;
    } catch {
      return null;
    }
  },

  // Backup origins this build was given. Empty unless the hosted front end
  // supplied them, which is the whole point: self-hosters get none.
  backendFallbacks() {
    return staticFallbacks.slice();
  },

  // Why the client is on a backup origin, or null. Consumed by the UI.
  failover() {
    return failoverNotice;
  },

  // Try each backup in order and adopt the first that answers. Never called
  // when the operator chose their own instance: `backendFallbacks()` is empty
  // for them, and an explicit choice is respected even if a build did ship a
  // list.
  async tryFallbacks(timeoutMs = 6000) {
    const current = resolveBackend().url;
    for (const candidate of staticFallbacks) {
      if (candidate === current) continue;
      const probe = await TrycordConfig.testBackend(candidate, timeoutMs);
      if (!probe.ok) continue;
      staticBackend = candidate;
      failoverNotice = { from: current, to: candidate, name: probe.name || candidate };
      try { localStorage.setItem(LS_BACKEND, candidate); } catch { /* ignore */ }
      return failoverNotice;
    }
    return null;
  },

  // Put the configured origin back and forget the failover, so a recovering
  // instance is picked up again without the user having to know it happened.
  clearFailover() {
    failoverNotice = null;
    staticBackend = configuredBackend;
    if (staticBackend) {
      try { localStorage.setItem(LS_BACKEND, staticBackend); } catch { /* ignore */ }
    } else {
      TrycordConfig.resetBackend();
    }
    return resolveBackend().url;
  },

  async loadRuntimeConfig() {
    if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return null;
    try {
      const base = window.location.origin.replace(/\/+$/, '');
      const res = await fetch(base + '/runtime-config.js', { cache: 'no-store' });
      if (!res.ok) return null;
      const js = await res.text();
      // CSP forbids eval(), so the snippet is not executed. It is not recovered
      // with a regex either: the previous pattern matched the `{}` in
      // `window.TRYCORD_CONFIG || {}` before the real literal, so the capture
      // began `}, {` and JSON.parse rejected it. That failed for every input,
      // including plain ones, and the failure was swallowed - so this function
      // has always returned null and an operator's API_URL pin was silently
      // discarded.
      //
      // Find the literal that is the *second* argument of Object.assign.
      // Scanning forward for the first '{' does not work: the snippet reads
      // `Object.assign(window.TRYCORD_CONFIG || {}, {...})`, so the first brace
      // belongs to the fallback object and parsing it yields `{}`.
      const lit = secondArgObjectLiteral(js);
      if (lit) {
        try {
          const parsed = JSON.parse(js.slice(lit.start, lit.end + 1));
          if (parsed && typeof parsed === 'object') {
            window.TRYCORD_CONFIG = Object.assign(window.TRYCORD_CONFIG || {}, parsed);
            return parsed;
          }
        } catch { /* fall through */ }
      }
      return null;
    } catch {
      return null;
    }
  },

  setApiUrl(url) {
    const v = plausibleUrl(url);
    try {
      if (v) localStorage.setItem(LS_BACKEND, v);
      else localStorage.removeItem(LS_BACKEND);
    } catch { /* ignore */ }
    return v;
  },

  resetBackend() {
    try { localStorage.removeItem(LS_BACKEND); } catch { /* ignore */ }
  },

  // Trycord API (answers /api/instance with JSON). Never throws — returns
  // A cross-origin fetch that fails is ambiguous from inside the browser: DNS,
  // TLS, a dead host, a firewall and a CORS refusal all surface as the same
  // env var and the generic "network error or CORS refusal" hides it.
  async testBackend(url, timeoutMs = 10000) {
    const v = plausibleUrl(url);
    if (!v) return { ok: false, error: 'Enter a valid http(s) URL, e.g. https://api.example.com' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(v + '/api/instance', { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) return { ok: false, error: 'Server answered HTTP ' + res.status + ' — is this a Trycord backend?' };
      const info = await res.json();
      if (!info || typeof info !== 'object') return { ok: false, error: 'Server did not answer like a Trycord backend.' };
      return { ok: true, name: info.name || info.instanceId || 'Trycord backend' };
    } catch (e) {
      if (e && e.name === 'AbortError') return { ok: false, error: 'Connection timed out — check the URL and your network.' };
      if (looksLikeAppOrigin()) {
        return {
          ok: false,
          error: 'The backend refused this app’s origin. Add trycord://app to CLIENT_ORIGIN '
            + 'on that server (and restart it), then test again.',
        };
      }
      return { ok: false, error: 'Cannot reach that backend (network error or CORS refusal).' };
    } finally {
      clearTimeout(timer);
    }
  },
};

export function BACKEND_URL() {
  return TrycordConfig.backendUrl();
}

// Trycord backend configuration — the SINGLE SOURCE OF TRUTH for which
// server this client talks to.
//
// BACKEND_URL resolves with strict precedence:
//   1. ?api=<url> query parameter (the desktop exe passes this on launch)
//   2. Saved backend in localStorage (set via the backend selector UI)
//   3. Static ./backend.json beside the client (for static hosts;
//      lets an operator repoint the client without editing code)
//   4. window.TRYCORD_CONFIG.API_URL from /runtime-config.js (server pin)
//   5. Production default below — unless this is clearly a local dev
//      context (localhost / file://), which keeps http://localhost:9971.
//
// Every REST call, the WebSocket gateway, and health/connection checks
// derive their address from BACKEND_URL. Nothing else in the client may
// hardcode a backend origin.
//
// Kept tiny and dependency-free because it is used by every other module.

// Production backend. Public configuration — safe to expose, and the
// default every fresh install uses. Self-hosters override it per the
// precedence above (backend selector, backend.json, or ?api=).
export const DEFAULT_BACKEND_URL = 'https://trycord-api.wispbyte.app';
const LOCAL_BACKEND_URL = 'http://localhost:9971';

const LS_BACKEND = 'trycord.backendUrl';

let staticBackend = null; // from backend.json, loaded once at boot
let staticLoaded = false;

function plausibleUrl(u) {
  if (!u) return null;
  const t = String(u).trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(t) ? t : null;
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

  // Canonical accessor. Always call this (or BACKEND_URL()) instead of
  // caching the value — the user can switch backends at runtime.
  backendUrl() {
    return resolveBackend().url;
  },

  // Where the current value came from. Shown in the backend selector UI.
  backendSource() {
    return resolveBackend().source;
  },

  // Legacy alias. Prefer backendUrl().
  apiUrl() {
    return resolveBackend().url;
  },

  // Derive the WebSocket origin from the backend:
  //   https://host -> wss://host   |   http://host -> ws://host
  wsUrl(ticket) {
    const base = resolveBackend().url.replace(/^http/i, 'ws');
    return base + '/?ticket=' + encodeURIComponent(ticket);
  },

  // Static ./backend.json beside the client (static-host friendly, no
  // build step, no Node). Best-effort: missing/unreachable file just
  // means "no static pin". Called once during boot.
  async loadStaticConfig() {
    if (staticLoaded) return staticBackend;
    staticLoaded = true;
    try {
      const res = await fetch('./backend.json', { cache: 'no-store' });
      if (!res.ok) return null;
      const json = await res.json();
      staticBackend = plausibleUrl(json && json.backendUrl);
      return staticBackend;
    } catch {
      return null;
    }
  },

  // Fetch the server-provided /runtime-config.js when served over http(s).
  // Harmless no-op when it fails (offline, server pinned elsewhere). File and
  // other non-HTTP(S) clients skip the request instead of logging a failed fetch.
  async loadRuntimeConfig() {
    if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return null;
    try {
      const base = window.location.origin.replace(/\/+$/, '');
      const res = await fetch(base + '/runtime-config.js', { cache: 'no-store' });
      if (!res.ok) return null;
      const js = await res.text();
      // CSP forbids eval(); the server emits a tiny deterministic snippet:
      //   window.TRYCORD_CONFIG = Object.assign(window.TRYCORD_CONFIG || {}, {...});
      // Extract the JSON payload embedded between the braces.
      const m = js.match(/=\s*Object\.assign\([^;]*?\{\s*([\s\S]*?)\s*\}\)?;/);
      if (m) {
        try {
          const parsed = JSON.parse('{' + m[1] + '}');
          window.TRYCORD_CONFIG = Object.assign(window.TRYCORD_CONFIG || {}, parsed);
          return parsed;
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

  // Forget the saved backend; the precedence chain falls back to
  // backend.json / server pin / default.
  resetBackend() {
    try { localStorage.removeItem(LS_BACKEND); } catch { /* ignore */ }
  },

  // Probe a backend candidate: must be http(s), reachable, and speak the
  // Trycord API (answers /api/instance with JSON). Never throws — returns
  // { ok, name } or { ok: false, error } for the selector UI.
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
      return { ok: false, error: 'Cannot reach that backend (network error or CORS refusal).' };
    } finally {
      clearTimeout(timer);
    }
  },
};

// The authoritative backend value, as a live accessor. Prefer this over
// TrycordConfig.backendUrl() in new code; both resolve identically.
export function BACKEND_URL() {
  return TrycordConfig.backendUrl();
}

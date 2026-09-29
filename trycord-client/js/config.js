// hardcode a backend origin.

// Production backend. Public configuration — safe to expose, and the
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
      return staticBackend;
    } catch {
      return null;
    }
  },

  async loadRuntimeConfig() {
    if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return null;
    try {
      const base = window.location.origin.replace(/\/+$/, '');
      const res = await fetch(base + '/runtime-config.js', { cache: 'no-store' });
      if (!res.ok) return null;
      const js = await res.text();
      // CSP forbids eval(); the server emits a tiny deterministic snippet:
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

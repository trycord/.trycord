// Trycord client configuration.
// Resolves the backend API origin at runtime with a strict precedence order:
//   1. ?api=<url> query parameter (the desktop exe passes this on launch)
//   2. Saved setting in localStorage (set via the UI, never hardcoded)
//   3. window.TRYCORD_CONFIG.API_URL from /runtime-config.js (server pin)
//   4. The page's own origin when served over http(s)
//   5. http://localhost:9971 for locally launched file:// clients
//
// Kept tiny and dependency-free because it is used by every other module.

const LS_API = 'trycord.accessApi';

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

export const TrycordConfig = {
  LS_API,

  apiUrl() {
    try {
      const fromQuery = new URLSearchParams(window.location.search).get('api');
      if (fromQuery) {
        const v = plausibleUrl(fromQuery);
        if (v) return v;
      }
    } catch { /* ignore */ }

    const saved = plausibleUrl(localStorage.getItem(LS_API));
    if (saved) return saved;

    const pinned = plausibleUrl(readRuntimeConfig().API_URL);
    if (pinned) return pinned;

    if (window.location.protocol === 'file:' || window.location.protocol === 'about:') {
      return 'http://localhost:9971';
    }
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      return window.location.origin.replace(/\/+$/, '');
    }
    return 'http://localhost:9971';
  },

  // Fetch the server-provided /runtime-config.js when served over http(s).
  // Harmless no-op when it fails (offline, file://, server pinned elsewhere).
  async loadRuntimeConfig() {
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
    if (v) localStorage.setItem(LS_API, v);
    else localStorage.removeItem(LS_API);
    return v;
  },
};
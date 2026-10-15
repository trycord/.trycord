// Which backend the client talks to, and how that answer is reached.
//
// The order is deliberate and lives here so an operator's pin cannot be quietly
// overridden by a hardcoded origin: the address the reader chose in this browser,
// then the build's own backend.json, then the origin that served the page, then
// the hosted default. A ?api= argument is a hint the reader confirms at boot (see
// pendingQueryBackend); it is never an implicit override.

export const DEFAULT_BACKEND_URL = 'https://api.trycord.dev';

const STORAGE_KEY = 'trycord.backendUrl';
const QUERY_KEY = 'api';

let staticBackend = null;
let staticFallbacks = [];
let staticLoaded = false;

function store(action) {
  try { return action(); } catch { return null; }
}

function plausibleUrl(value) {
  if (!value) return null;
  const text = String(value).trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(text) ? text : null;
}

function plausibleList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const url = plausibleUrl(item);
    if (url && out.indexOf(url) === -1) out.push(url);
  }
  return out;
}

export function readStored() {
  return store(() => plausibleUrl(localStorage.getItem(STORAGE_KEY)));
}

export function setApiUrl(url) {
  const value = plausibleUrl(url);
  store(() => {
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  });
  return value;
}

export function resetBackend() {
  store(() => localStorage.removeItem(STORAGE_KEY));
}

// backend.json sits next to index.html, so under the /app mount it is
// /app/backend.json. <base> has already set the document base, so a relative
// fetch resolves against the mount rather than the origin root.
export async function loadStaticConfig() {
  if (staticLoaded) return staticBackend;
  staticLoaded = true;
  if (typeof fetch !== 'function') return null;

  // The build's own hint is bounded: a fetch that never settles would hold the
  // boot sequence open forever, and the backend resolves from the serving origin
  // anyway, so giving up on the hint costs nothing.
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 8000) : null;
  try {
    const res = await fetch('./backend.json', {
      cache: 'no-store',
      signal: controller ? controller.signal : undefined,
    });
    if (!res.ok) return null;
    const json = await res.json();
    staticBackend = plausibleUrl(json && json.backendUrl);
    staticFallbacks = plausibleList(json && json.fallbackUrls);
    return staticBackend;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The backend named by ?api= is a hint, not a decision. It is offered to the
// reader at boot and stored only on their say-so. Applying and persisting it here,
// with no one asked, was the whole of the repointing attack: one click on a link
// and every bearer request from then on went to the attacker's origin.
export function pendingQueryBackend() {
  try {
    const raw = new URLSearchParams(window.location.search).get(QUERY_KEY);
    if (!raw) return null;
    // ?api=local is a shorthand a developer can keep in a bookmark.
    const value = raw === 'local' ? 'http://localhost:9971' : plausibleUrl(raw);
    if (!value || value === readStored()) return null;
    return value;
  } catch { return null; }
}

// Removes ?api= from the address bar whether the hint was accepted or declined, so
// a declined link cannot re-prompt on the next load and the choice is not left in
// the URL for a copy of it to carry on.
export function clearQueryBackend() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(QUERY_KEY)) return;
    url.searchParams.delete(QUERY_KEY);
    window.history.replaceState({}, '', url.toString());
  } catch { /* no location */ }
}

function servingOrigin() {
  try {
    const protocol = String(window.location.protocol || '').toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return plausibleUrl(window.location.origin);
  } catch {
    return null;
  }
}

export function resolveBackend() {
  const stored = readStored();
  if (stored) return { url: stored, source: 'stored' };

  if (staticBackend) return { url: staticBackend, source: 'static' };

  const origin = servingOrigin();
  if (origin) return { url: origin, source: 'origin' };

  return { url: DEFAULT_BACKEND_URL, source: 'default' };
}

export function backendUrl() {
  return resolveBackend().url;
}

export function backendSource() {
  return resolveBackend().source;
}

export function backendFallbacks() {
  return staticFallbacks.slice();
}

// Token auth travels in an Authorization header, so the socket has no way to
// present it during the handshake. The server issues a one-use ticket for
// exactly this and the socket presents that instead.
export function wsUrl(ticket) {
  const base = backendUrl().replace(/^http/i, 'ws');
  return base + '/?ticket=' + encodeURIComponent(ticket);
}

// Never throws: returns { ok, name } or { ok:false, error } with an explanation
// a person can act on. The three failure modes that matter - a wrong address, a
// dead host, and a CORS refusal - look identical inside the browser, so the
// error text names the likely cause rather than the symptom.
export async function testBackend(url, timeoutMs) {
  const value = plausibleUrl(url);
  if (!value) return { ok: false, error: 'Enter a full http(s) address, for example https://api.example.com' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 10000);
  try {
    const res = await fetch(value + '/api/instance', { cache: 'no-store', signal: controller.signal });
    if (!res.ok) {
      return { ok: false, error: 'Something answered HTTP ' + res.status + '. That address is reachable but is not a Trycord backend.' };
    }
    const info = await res.json();
    if (!info || typeof info !== 'object') {
      return { ok: false, error: 'That address did not answer like a Trycord backend.' };
    }
    return { ok: true, name: info.name || info.instanceId || 'Trycord backend' };
  } catch (e) {
    if (e && e.name === 'AbortError') {
      return { ok: false, error: 'The connection timed out. Check the address and your network.' };
    }
    return { ok: false, error: 'Could not reach that address. Check it is correct and online, and that it allows this origin.' };
  }
}

export const TrycordConfig = {
  DEFAULT_BACKEND_URL,
  loadStaticConfig,
  backendUrl,
  backendSource,
  backendFallbacks,
  wsUrl,
  setApiUrl,
  resetBackend,
  resolveBackend,
  pendingQueryBackend,
  clearQueryBackend,
  testBackend,
};

export default TrycordConfig;

// The HTTP client.
//
// One request() and everything goes through it, so auth, error shape, timeouts
// and backend failover are decided once. Failures arrive as an ApiError
// carrying { code, message, status, retryAfter }. Authorization is attached
// from state.js (localStorage token) unless overridden.

import { TrycordConfig } from '../config.js';

const TOKEN_KEY = 'trycord.token';

export class ApiError extends Error {
  constructor(code, message, status, retryAfter, details) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code || 'INTERNAL';
    this.status = status || 500;
    this.retryAfter = retryAfter || 0;
    // Never sensitive: the server decides what goes in here.
    this.details = details || null;
  }
}

const REQUEST_TIMEOUT_MS = 25000;

export function base() {
  return TrycordConfig.backendUrl().replace(/\/+$/, '');
}

// At most one failover per origin per session. Without this a dead backend costs
// a probe on every single request, which turns one outage into a slow client on
// top of the outage.
let failoverTriedFor = null;
let failoverInFlight = null;
let failoverAnnounced = false;

// Listeners live here rather than in realtime.js: the socket layer calls the
// API, so having the API emit into it would be a cycle.
const failoverListeners = new Set();

export function onFailover(fn) {
  if (typeof fn === 'function') failoverListeners.add(fn);
  return () => failoverListeners.delete(fn);
}

// A later outage has to be announceable again after the user switches back.
export function resetFailoverAnnouncement() {
  failoverAnnounced = false;
  failoverTriedFor = null;
}

function notifyFailover() {
  if (failoverAnnounced) return;
  const moved = TrycordConfig.failover();
  if (!moved) return;
  failoverAnnounced = true;
  for (const fn of failoverListeners) {
    try { fn(moved); } catch { /* one listener must not break the request */ }
  }
}

async function maybeFailover() {
  const candidates = TrycordConfig.backendFallbacks();
  if (!candidates.length) return false;

  const from = base();
  if (failoverTriedFor === from) return false;
  failoverTriedFor = from;

  // Concurrent first requests must not each start a probe.
  if (!failoverInFlight) {
    failoverInFlight = TrycordConfig.tryFallbacks().finally(() => { failoverInFlight = null; });
  }
  const moved = await failoverInFlight;
  return !!moved;
}

export function token() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function setToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}

export async function request(method, path, { body, auth = true, raw = false, form = false } = {}) {
  const url = base() + path;
  const headers = {};
  if (auth) {
    const t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
  }
  let payload = body;
  if (body !== undefined && !form) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'omit', signal: ctrl.signal });
  } catch (e) {
    // Transport-level failure only: a 5xx or a 404 is the instance answering, so
    // those never trigger a switch. One attempt per unreachable origin, not one
    // per request, because a dead backend means every subsequent call would pay
    // the same probe.
    if (await maybeFailover()) {
      clearTimeout(timer);
      const retried = await request(method, path, { body, auth, raw, form });
      // Announced only once the retried request has actually succeeded. Firing
      // on the switch itself would show the notice for a backup that then fails
      // too, and would still reject back to the caller.
      notifyFailover();
      return retried;
    }
    if (e && e.name === 'AbortError') throw new ApiError('TIMEOUT', 'the request timed out — the backend may be unreachable', 0);
    throw new ApiError('NETWORK', 'cannot reach the Trycord server', 0);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    // Token missing/bad/revoked: drop it and surface a typed error so the
    if (auth) setToken(null);
    try {
      const e = await res.json().catch(() => null);
      if (e && e.error) throw new ApiError(e.error.code, e.error.message, 401, 0, e.error.details);
    } catch (err) { if (err instanceof ApiError) throw err; }
    throw new ApiError('AUTH_REQUIRED', 'you need to sign in', 401);
  }
  if (!res.ok) {
    let info = null;
    try { info = await res.json(); } catch { /* non-json error */ }
    const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10) || 0;
    if (info && info.error) {
      throw new ApiError(info.error.code, info.error.message, res.status, retryAfter, info.error.details);
    }
    throw new ApiError('HTTP_' + res.status, res.statusText || 'request failed', res.status, retryAfter);
  }
  if (raw) {
    const buffer = await res.arrayBuffer();
    return { buffer, headers: res.headers };
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

// XHR rather than fetch, which cannot report how much of a body has been sent.
// Returns { promise, abort } so a caller can show progress and still let the
// reader change their mind; the rejection on abort is an AbortError, so it must
// not be reported as a failed upload.
export function xhrUpload(path, fd, onProgress) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', base() + path, true);
    xhr.withCredentials = false;
    const t = token();
    if (t) xhr.setRequestHeader('Authorization', 'Bearer ' + t);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      let parsed = null;
      try { parsed = JSON.parse(xhr.responseText); } catch { /* not json */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(parsed);
      reject(new ApiError(
        (parsed && parsed.error && parsed.error.code) || 'UPLOAD_FAILED',
        (parsed && parsed.error && parsed.error.message) || 'Upload failed',
        xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('NETWORK', 'Upload failed', 0));
    xhr.onabort = () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    };
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}

// Two fetchers that take a path rather than naming one. Profile avatars/banners and
// community icons/banners are both "GET this path with the session, get bytes back", so
// they are transport rather than endpoints - which is why they live here, next to the
// request they are built on, and not in the endpoint table.
export const fetchProfileImage = (path) => request('GET', path, { raw: true });

export const fetchAuthedImage = (path) => request('GET', path, { raw: true });


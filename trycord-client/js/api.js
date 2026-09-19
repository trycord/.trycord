/* API layer: centralized backend URL, token storage, typed endpoint helpers.
   Backend resolution (most explicit wins):
     1. ?api= URL parameter (used by the desktop exe's --api-url flag)
     2. saved Server setting on this device (Settings -> Application)
     3. window.TRYCORD_CONFIG.API_URL from config.js (edit without rebuilding)
     4. built-in default (http://localhost:9971, or same-origin when served)
   Errors are { code, message }; thrown Error carries .code for specific UX.
   401 on an authenticated call => session dead => clear + go to login. */
(function () {
  var TOKEN_KEY = 'trycord.token';
  var DEFAULT_API_URL = 'http://localhost:9971';

  // Returns a normalized http(s) base URL, or null if invalid.
  // 'http://host:9971/' and 'http://host:9971' both become 'http://host:9971'.
  // Anything non-http(s) (javascript:, data:, ftp:, bare words) is rejected.
  function normalizeApiUrl(raw) {
    if (!raw) return null;
    var s = String(raw).trim().replace(/\/+$/, '');
    if (!s) return null;
    var u;
    try {
      u = new URL(s);
    } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    var path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
    return u.origin + path;
  }

  function resolveApiBase() {
    var q = null;
    try { q = new URLSearchParams(location.search).get('api'); } catch (e) { /* ignore */ }
    q = normalizeApiUrl(q);
    if (q) return { url: q, source: 'startup argument' };
    var saved = null;
    try { saved = window.TrycordState && window.TrycordState.settings.apiBase; } catch (e) { /* not loaded */ }
    saved = normalizeApiUrl(saved);
    if (saved) return { url: saved, source: 'saved setting' };
    var cfg = null;
    try { cfg = window.TRYCORD_CONFIG && window.TRYCORD_CONFIG.API_URL; } catch (e) { /* no config.js */ }
    cfg = normalizeApiUrl(cfg);
    if (cfg) return { url: cfg, source: 'server config' };
    if (location.protocol === 'file:' || location.port === '5500') {
      return { url: DEFAULT_API_URL, source: 'default' };
    }
    return { url: location.origin.replace(/\/+$/, ''), source: 'default' };
  }

  function baseUrl() {
    return resolveApiBase().url;
  }

  function apiError(data, status) {
    var err = data && data.error;
    var code = (err && err.code) || 'ERROR';
    var message = (err && err.message) || (typeof err === 'string' ? err : 'Request failed (HTTP ' + status + ')');
    var e = new Error(message);
    e.code = code;
    e.status = status;
    return e;
  }

  var API = {
    get token() {
      try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
    },
    set token(t) {
      try {
        if (t) localStorage.setItem(TOKEN_KEY, t);
        else localStorage.removeItem(TOKEN_KEY);
      } catch (e) { /* ignore */ }
    },

    async call(path, opts) {
      opts = opts || {};
      var headers = { 'Content-Type': 'application/json' };
      var authed = !!API.token;
      if (authed) headers.Authorization = 'Bearer ' + API.token;
      var res;
      try {
        res = await fetch(baseUrl() + path, {
          method: opts.method || 'GET',
          headers: headers,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
      } catch (e) {
        Trycord.setOnline(false);
        var net = new Error('Cannot reach the server at ' + baseUrl() + '. Is it running?');
        net.code = 'OFFLINE';
        throw net;
      }
      var text = await res.text();
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
      if (res.status === 401 && authed) {
        API.token = null;
        if (window.TrycordState) TrycordState.user = null;
        Trycord.setOnline(true);
        location.hash = '#/login';
        throw apiError({ error: { code: 'SESSION_REVOKED', message: 'Session expired — please log in again.' } }, 401);
      }
      if (!res.ok) throw apiError(data, res.status);
      Trycord.setOnline(true);
      return data;
    },

    wsUrl() {
      // Derive from the configured backend: http -> ws, https -> wss.
      // No separate WebSocket host is ever hardcoded.
      var wsBase = baseUrl().replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
      return wsBase + '/?token=' + API.token;
    },

    // Centralized backend configuration (single source of truth).
    baseUrl,
    baseSource: () => resolveApiBase().source,
    normalizeUrl: normalizeApiUrl,
    DEFAULT_API_URL,

    // Probe a backend URL (used by the connection UI). Never throws.
    async testConnection(raw) {
      var url = normalizeApiUrl(raw);
      if (!url) {
        return { ok: false, code: 'INVALID_URL', message: 'Use an http(s) URL like http://51.79.44.111:9971' };
      }
      var t0 = Date.now();
      try {
        var ctrl = new AbortController();
        var timer = setTimeout(() => ctrl.abort(), 8000);
        var res;
        try {
          res = await fetch(url + '/api/health', { signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) return { ok: false, code: 'BAD_STATUS', message: 'Server answered HTTP ' + res.status };
        return { ok: true, url, latencyMs: Date.now() - t0 };
      } catch (e) {
        return { ok: false, code: 'UNREACHABLE', message: 'Unable to connect to ' + url };
      }
    },

    // auth
    register: (body) => API.call('/api/auth/register', { method: 'POST', body }),
    login: (body) => API.call('/api/auth/login', { method: 'POST', body }),
    logout: () => API.call('/api/auth/logout', { method: 'POST' }),
    // users
    me: () => API.call('/api/users/me'),
    patchMe: (body) => API.call('/api/users/me', { method: 'PATCH', body }),
    changePassword: (body) => API.call('/api/users/me/password', { method: 'POST', body }),
    // servers
    myServers: () => API.call('/api/servers'),
    createServer: (body) => API.call('/api/servers', { method: 'POST', body }),
    serverDetail: (id) => API.call('/api/servers/' + encodeURIComponent(id)),
    patchServer: (id, body) => API.call('/api/servers/' + encodeURIComponent(id), { method: 'PATCH', body }),
    deleteServer: (id) => API.call('/api/servers/' + encodeURIComponent(id), { method: 'DELETE' }),
    serverMembers: (id) => API.call('/api/servers/' + encodeURIComponent(id) + '/members'),
    leaveServer: (id) => API.call('/api/servers/' + encodeURIComponent(id) + '/leave', { method: 'POST' }),
    kickMember: (id, userId) => API.call('/api/servers/' + encodeURIComponent(id) + '/kick', { method: 'POST', body: { userId } }),
    previewByCode: (code) => API.call('/api/servers/by-code/' + encodeURIComponent(code)),
    joinByCode: (code) => API.call('/api/servers/join/' + encodeURIComponent(code), { method: 'POST' }),
    // roles
    serverPerms: (id) => API.call('/api/servers/' + encodeURIComponent(id) + '/roles/permissions'),
    roles: (id) => API.call('/api/servers/' + encodeURIComponent(id) + '/roles'),
    createRole: (id, body) => API.call('/api/servers/' + encodeURIComponent(id) + '/roles', { method: 'POST', body }),
    patchRole: (id, roleId, body) => API.call('/api/servers/' + encodeURIComponent(id) + '/roles/' + encodeURIComponent(roleId), { method: 'PATCH', body }),
    deleteRole: (id, roleId) => API.call('/api/servers/' + encodeURIComponent(id) + '/roles/' + encodeURIComponent(roleId), { method: 'DELETE' }),
    assignRole: (id, roleId, userId) => API.call('/api/servers/' + encodeURIComponent(id) + '/roles/' + encodeURIComponent(roleId) + '/assign', { method: 'POST', body: { userId } }),
    unassignRole: (id, roleId, userId) => API.call('/api/servers/' + encodeURIComponent(id) + '/roles/' + encodeURIComponent(roleId) + '/assign/' + encodeURIComponent(userId), { method: 'DELETE' }),
    // invites
    invites: (id) => API.call('/api/servers/' + encodeURIComponent(id) + '/invites'),
    createInvite: (id, body) => API.call('/api/servers/' + encodeURIComponent(id) + '/invites', { method: 'POST', body }),
    revokeInvite: (id, inviteId) => API.call('/api/servers/' + encodeURIComponent(id) + '/invites/' + encodeURIComponent(inviteId), { method: 'DELETE' }),
    invitePreview: (code) => API.call('/api/invites/' + encodeURIComponent(code) + '/preview'),
    joinWithInvite: (code) => API.call('/api/invites/' + encodeURIComponent(code) + '/join', { method: 'POST' }),
    // categories + channels + messages
    categories: (sid) => API.call('/api/servers/' + encodeURIComponent(sid) + '/categories'),
    createCategory: (sid, body) => API.call('/api/servers/' + encodeURIComponent(sid) + '/categories', { method: 'POST', body }),
    deleteCategory: (sid, cid) => API.call('/api/servers/' + encodeURIComponent(sid) + '/categories/' + encodeURIComponent(cid), { method: 'DELETE' }),
    channels: (sid) => API.call('/api/servers/' + encodeURIComponent(sid) + '/channels'),
    createChannel: (sid, body) => API.call('/api/servers/' + encodeURIComponent(sid) + '/channels', { method: 'POST', body }),
    deleteChannel: (sid, cid) => API.call('/api/servers/' + encodeURIComponent(sid) + '/channels/' + encodeURIComponent(cid), { method: 'DELETE' }),
    messages: (cid, limit) => API.call('/api/channels/' + encodeURIComponent(cid) + '/messages?limit=' + (limit || 50)),
    postMessage: (cid, content) => API.call('/api/channels/' + encodeURIComponent(cid) + '/messages', { method: 'POST', body: { content } }),
    deleteMessage: (cid, mid) => API.call('/api/channels/' + encodeURIComponent(cid) + '/messages/' + encodeURIComponent(mid), { method: 'DELETE' }),
    // browse + activity (discover is public: no membership required)
    discover: (q, page, limit) => {
      var qs = '?limit=' + (limit || 12) + '&page=' + (page || 1) + (q ? '&q=' + encodeURIComponent(q) : '');
      return API.call('/api/discover/servers' + qs);
    },
    discoverPreview: (id) => API.call('/api/discover/servers/' + encodeURIComponent(id)),
    joinPublic: (id) => API.call('/api/discover/servers/' + encodeURIComponent(id) + '/join', { method: 'POST' }),
    activity: (limit) => API.call('/api/activity?limit=' + (limit || 20)),
    health: () => API.call('/health'),
  };

  window.TrycordApi = API;
})();

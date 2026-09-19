/* API layer: base URL resolution, token storage, typed endpoint helpers.
   Errors are { code, message }; thrown Error carries .code for specific UX.
   401 on an authenticated call => session dead => clear + go to login. */
(function () {
  var TOKEN_KEY = 'trycord.token';

  function baseUrl() {
    try {
      var override = window.TrycordState && TrycordState.settings.apiBase;
      if (override) return String(override).replace(/\/$/, '');
    } catch (e) { /* state not loaded yet */ }
    try {
      var q = new URLSearchParams(location.search).get('api');
      if (q) return q.replace(/\/$/, '');
    } catch (e) { /* ignore */ }
    if (location.protocol === 'file:' || location.port === '5500') return 'http://localhost:3000';
    return location.origin;
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
      return baseUrl().replace(/^http/, 'ws') + '/?token=' + API.token;
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

/* API layer: base URL resolution, token storage, typed endpoint helpers.
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
        throw new Error('Cannot reach the server at ' + baseUrl() + '. Is it running?');
      }
      var text = await res.text();
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
      if (res.status === 401 && authed) {
        API.token = null;
        if (window.TrycordState) TrycordState.user = null;
        Trycord.setOnline(true);
        location.hash = '#/login';
        throw new Error('Session expired — please log in again.');
      }
      if (!res.ok) throw new Error((data && data.error) || ('Request failed (HTTP ' + res.status + ')'));
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
    serverMembers: (id) => API.call('/api/servers/' + encodeURIComponent(id) + '/members'),
    previewByCode: (code) => API.call('/api/servers/by-code/' + encodeURIComponent(code)),
    joinByCode: (code) => API.call('/api/servers/join/' + encodeURIComponent(code), { method: 'POST' }),
    // channels + messages
    channels: (sid) => API.call('/api/servers/' + encodeURIComponent(sid) + '/channels'),
    createChannel: (sid, body) => API.call('/api/servers/' + encodeURIComponent(sid) + '/channels', { method: 'POST', body }),
    deleteChannel: (sid, cid) => API.call('/api/servers/' + encodeURIComponent(sid) + '/channels/' + encodeURIComponent(cid), { method: 'DELETE' }),
    messages: (cid, limit) => API.call('/api/channels/' + encodeURIComponent(cid) + '/messages?limit=' + (limit || 50)),
    postMessage: (cid, content) => API.call('/api/channels/' + encodeURIComponent(cid) + '/messages', { method: 'POST', body: { content } }),
    // browse + activity
    discover: (q) => API.call('/api/discover' + (q ? '?q=' + encodeURIComponent(q) : '')),
    activity: (limit) => API.call('/api/activity?limit=' + (limit || 20)),
    health: () => API.call('/health'),
  };

  window.TrycordApi = API;
})();

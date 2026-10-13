// A small read path for the public pages.
//
// The marketing pages, the demo and the directory read one deliberate surface:
// the public discovery index, one community's preview, and the join endpoint the
// application's own discovery screen already calls. None of it needs the
// application's transport layer, and pulling the client bundle into three static
// pages would ship an SPA to a reader who asked for a page. This wraps fetch with
// the JSON error envelope the API already speaks.
//
// It reads the application's own session token - the same localStorage key the
// client writes - so a reader who is already signed in can join a community from
// the public preview without a second sign-in. It never writes the token, and a
// signed-out reader is simply offered the app.
(function () {
  'use strict';

  var TOKEN_KEY = 'trycord.token';

  function token() {
    try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }

  function apiError(status, code, message) {
    var e = new Error(message || ('HTTP ' + status));
    e.status = status;
    e.code = code;
    return e;
  }

  async function request(path, opts) {
    opts = opts || {};
    var headers = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    var t = token();
    if (t && opts.auth !== false) headers.Authorization = 'Bearer ' + t;

    var res = await fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'same-origin',
    });

    var text = await res.text();
    var data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }

    if (!res.ok) {
      var err = (data && data.error) || {};
      throw apiError(res.status, err.code, err.message);
    }
    return data;
  }

  window.TrycordApi = {
    token: token,
    signedIn: function () { return !!token(); },
    instance: function () { return request('/api/instance', { auth: false }); },
    servers: function (params) {
      var qs = new URLSearchParams();
      Object.keys(params || {}).forEach(function (k) {
        var v = params[k];
        if (v !== undefined && v !== null && v !== '') qs.set(k, v);
      });
      var s = qs.toString();
      return request('/api/discover/servers' + (s ? '?' + s : ''), { auth: false });
    },
    server: function (id) {
      return request('/api/discover/servers/' + encodeURIComponent(id), { auth: false });
    },
    join: function (id) {
      return request('/api/discover/servers/' + encodeURIComponent(id) + '/join', { method: 'POST' });
    },
  };
})();

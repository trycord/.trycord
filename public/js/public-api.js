// A small read path for the public pages.
//
// The marketing pages, the demo and the directory read one deliberate surface:
// the public discovery index, one community's preview, and the join endpoint the
// application's own discovery screen already calls. None of it needs the
// application's transport layer, and pulling the client bundle into three static
// pages would ship an SPA to a reader who asked for a page. This wraps fetch with
// the JSON error envelope the API already speaks.
//
// Where the API lives
//
// A public site and its API are not always the same origin. The marketing site
// is often a static deployment, and the API is a different host that answers
// under its own name. Asking for a relative '/api/...' on the site therefore
// reaches the site, which has no API, and the page answers with a 404 that
// looks like a broken instance.
//
// So the address is resolved the way the application resolves it:
//   1. the page's own answer, when the server served it and said which API
//      this deployment uses;
//   2. backend.json beside the page, for a site deployed as files;
//   3. the origin that served the page, for an instance that serves both.
//
// A reader who is already signed in keeps their session: the token is read
// from the same place the application writes it, under the origin of the
// instance that issued it. It never writes the token, and a signed-out reader
// is simply offered the app.
(function () {
  'use strict';

  var TOKEN_PREFIX = 'trycord.token.';
  var LEGACY_TOKEN_KEY = 'trycord.token';

  function plausibleUrl(value) {
    if (!value) return null;
    var text = String(value).trim().replace(/\/+$/, '');
    return /^https?:\/\//i.test(text) ? text : null;
  }

  // The origin a token is filed under, which is the API's origin.
  function originOf(url) {
    try { return new URL(url).origin; } catch (e) { return String(url || ''); }
  }

  function storedToken(apiOrigin) {
    try {
      var scoped = localStorage.getItem(TOKEN_PREFIX + apiOrigin);
      if (scoped) return scoped;
      // A browser that has not been updated since the token was stored globally.
      return localStorage.getItem(LEGACY_TOKEN_KEY);
    } catch (e) { return null; }
  }

  // The API this page talks to. Resolved once and remembered.
  var basePromise = null;

  function fromMeta() {
    try {
      var meta = document.querySelector('meta[name="trycord-api"]');
      return meta && meta.content ? plausibleUrl(meta.content) : null;
    } catch (e) { return null; }
  }

  function fromFile() {
    if (typeof fetch !== 'function') return Promise.resolve(null);
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 6000) : null;
    return fetch('./backend.json', { cache: 'no-store', signal: controller && controller.signal })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (json) { return json && plausibleUrl(json.backendUrl); })
      .catch(function () { return null; })
      .then(function (value) { if (timer) clearTimeout(timer); return value; });
  }

  function apiBase() {
    if (basePromise) return basePromise;
    var meta = fromMeta();
    if (meta) {
      basePromise = Promise.resolve(meta);
      return basePromise;
    }
    basePromise = fromFile().then(function (url) {
      if (url) return url;
      // The instance serves the site and the API itself.
      return location.origin;
    });
    return basePromise;
  }

  function apiError(status, code, message) {
    var e = new Error(message || ('HTTP ' + status));
    e.status = status;
    e.code = code;
    return e;
  }

  async function request(path, opts) {
    opts = opts || {};
    var base = await apiBase();
    var headers = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    var t = storedToken(originOf(base));
    if (t && opts.auth !== false) headers.Authorization = 'Bearer ' + t;

    var res = await fetch(base + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'omit',
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
    token: function () { return apiBase().then(function (base) { return storedToken(originOf(base)); }); },
    signedIn: function () { return !!localStorage.getItem(TOKEN_PREFIX + location.origin) || !!localStorage.getItem(LEGACY_TOKEN_KEY); },
    apiBase: apiBase,
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

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
// The one answer is used for everything the site asks of the API: the discovery
// calls, the community icons, and the health probes on the status page. A
// relative path is never the answer, because on a split deployment the relative
// path is the site, and the site has no API.
//
// Where the application lives
//
// The application is a separate tree from the website, and a deployment may
// serve it from the origin root or from a mount such as /app. The site's links
// into the application therefore come from the instance's own configuration and
// from a probe, never from a path written into the markup: a link that says
// '/app/' works on one deployment and 404s on the next.
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

  // The origin the page was served from, which is the website's own address and
  // nothing else. It is the one place a relative URL would have landed.
  function siteOrigin() {
    try { return String(location.origin || '').replace(/\/+$/, ''); } catch (e) { return ''; }
  }

  /* ---- the instance's own configuration ----------------------------------
     backend.json sits beside the page and is rewritten by the server that
     served it. It names the API's address, and the mount the application is
     served from. It is read at most once per page, and shared by both
     resolvers below. */
  var configPromise = null;

  function backendJson() {
    if (configPromise) return configPromise;
    if (typeof fetch !== 'function') {
      configPromise = Promise.resolve(null);
      return configPromise;
    }
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 6000) : null;
    configPromise = fetch('./backend.json', { cache: 'no-store', signal: controller && controller.signal })
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; })
      .then(function (json) {
        if (timer) clearTimeout(timer);
        return (json && typeof json === 'object') ? json : null;
      });
    return configPromise;
  }

  /* ---- the API ------------------------------------------------------------
     Resolved once and remembered. The page's own answer wins: when the server
     served this page it said which API this deployment uses, and nothing on
     disk is more authoritative than that. */
  var basePromise = null;

  function fromMeta() {
    try {
      var meta = document.querySelector('meta[name="trycord-api"]');
      return meta && meta.content ? plausibleUrl(meta.content) : null;
    } catch (e) { return null; }
  }

  function apiBase() {
    if (basePromise) return basePromise;
    var meta = fromMeta();
    if (meta) {
      basePromise = Promise.resolve(meta);
      return basePromise;
    }
    basePromise = backendJson().then(function (json) {
      return (json && plausibleUrl(json.backendUrl)) || siteOrigin();
    });
    return basePromise;
  }

  /* ---- the application ----------------------------------------------------
     The application's mount is a deployment fact, so it is read rather than
     assumed. Three answers, in order: the page's own answer if the server
     stated one, the instance's configuration, and a probe of the places the
     application is normally served from. An empty answer means the application
     is served from the origin root. */
  var appPromise = null;

  // Turns a configured mount into an address. An absolute URL is taken as it
  // stands; a path is resolved against the website's own origin, which is the
  // origin the server that wrote the configuration also serves the application
  // from. Anything else is ignored rather than obeyed.
  function normaliseAppBase(value) {
    if (value === undefined || value === null) return null;
    var text = String(value).trim();
    if (!text) return '';
    if (/^https?:\/\//i.test(text)) return text.replace(/\/+$/, '');
    if (text.charAt(0) === '/') return siteOrigin() + text.replace(/\/+$/, '');
    return null;
  }

  function appFromMeta() {
    try {
      var meta = document.querySelector('meta[name="trycord-app"]');
      return meta && meta.content ? normaliseAppBase(meta.content) : null;
    } catch (e) { return null; }
  }

  // A HEAD is enough to ask whether something is served at an address, and it
  // costs a header rather than a page.
  function headOk(url) {
    if (typeof fetch !== 'function') return Promise.resolve(false);
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 5000) : null;
    return fetch(url, { method: 'HEAD', cache: 'no-store', signal: controller && controller.signal })
      .then(function (res) { return !!res && res.ok; })
      .catch(function () { return false; })
      .then(function (ok) { if (timer) clearTimeout(timer); return ok; });
  }

  function probeAppBase() {
    var origin = siteOrigin();
    var candidates = [];
    if (origin) candidates.push(origin + '/app/');
    return apiBase().then(function (base) {
      var api = String(base || '').replace(/\/+$/, '');
      // A site on its own origin, with the application on the API's, is the
      // split deployment: the mount has to be looked for there as well.
      if (api && api !== origin) candidates.push(api + '/app/');
      var chain = Promise.resolve(null);
      candidates.forEach(function (url) {
        chain = chain.then(function (found) {
          if (found) return found;
          return headOk(url).then(function (ok) { return ok ? url.replace(/\/+$/, '') : null; });
        });
      });
      return chain.then(function (found) { return found || ''; });
    });
  }

  function appBase() {
    if (appPromise) return appPromise;
    var meta = appFromMeta();
    if (meta !== null) {
      appPromise = Promise.resolve(meta);
      return appPromise;
    }
    appPromise = backendJson().then(function (json) {
      var configured = json ? normaliseAppBase(json.appUrl) : null;
      if (configured !== null) return configured;
      return probeAppBase();
    });
    return appPromise;
  }

  // The address of a page inside the application. With no path it is the
  // application's own front door: the mounted document when the application
  // has a mount, and its home view when the application is served from the
  // origin root and the website owns that address.
  function appHref(path) {
    var suffix = String(path === undefined || path === null ? '' : path).replace(/^\/+/, '');
    return appBase().then(function (base) {
      if (!suffix) return base ? base + '/' : '/home';
      return base + '/' + suffix;
    });
  }

  // The address of a file the API serves, such as a community icon. The API
  // returns a path, and a path means nothing without the origin it belongs to.
  function assetUrl(path) {
    var value = String(path || '');
    if (!value) return Promise.resolve('');
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return Promise.resolve(value);
    if (value.charAt(0) !== '/') return Promise.resolve(value);
    return apiBase().then(function (base) { return base + value; });
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
    // The session belongs to the instance that issued it, so it is filed under
    // the API's origin and nowhere else. Reading it against the page's origin
    // reported a signed-out reader on a split deployment.
    signedIn: function () { return apiBase().then(function (base) { return !!storedToken(originOf(base)); }); },
    apiBase: apiBase,
    appBase: appBase,
    appHref: appHref,
    assetUrl: assetUrl,
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
    // The instances this one knows about. Public on purpose: it is a listing
    // of public instances and carries nothing private.
    instances: function () {
      return request('/api/discovery/instances', { auth: false });
    },
  };
})();

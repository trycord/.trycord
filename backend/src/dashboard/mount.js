'use strict';

// The dashboard, as the main process sees it.
//
// In bundled mode there is nothing to do here: the client already serves the
// admin console under /admin and this process already serves the admin API
// under /api/admin. That is the deployment as it has always been, and the
// only thing missing was saying so out loud.
//
// In separate mode the console belongs to another process, so this process
// must stop serving the console's document. It answers those addresses with a
// pointer to the dashboard service instead, which is the whole difference
// between the two modes: one process carries the console, or two do.
//
// The guard is installed on the application's own request handler rather than
// as a route, so it runs before every other handler whatever order the
// application was assembled in. A route would have had to be registered
// before the client's own handlers, which is a placement detail the mount
// should not depend on.

const { ADMIN_PATH } = require('./contract');
const { describe, report, currentMode, consoleUrlFromOrigin } = require('./mode');

// A marker so a second mount on the same application is a no-op rather than a
// second guard answering the same requests.
const MOUNTED = Symbol('trycord.dashboard.mounted');

// The console's addresses on this instance, relative to the application's own
// mount. '/admin' and '/admin/anything' are the console; '/api/admin/...' is
// the API and belongs to this process in both modes.
function isConsolePath(path, appMount) {
  const mount = String(appMount || '').replace(/\/+$/, '');
  let rest = String(path || '/');
  if (mount && (rest === mount || rest.startsWith(mount + '/'))) {
    rest = rest.slice(mount.length) || '/';
  }
  return rest === ADMIN_PATH || rest.startsWith(ADMIN_PATH + '/');
}

// The path of a request, before Express has decorated it.
//
// The guard runs before the application's own handler, which is the point of
// it, and Express decorates the request inside that handler. So the path is
// read from the raw URL here rather than from req.path, which does not exist
// yet at this point in the request's life.
function pathnameOf(req) {
  const url = String(req.url || '/');
  const query = url.indexOf('?');
  const clean = query === -1 ? url : url.slice(0, query);
  return clean || '/';
}

// Where the console is served instead, for a path on this instance.
//
// The dashboard URL names the console's own path, so the rest of this
// instance's path is appended to it: '/admin/users' on this instance becomes
// '/admin/users' on the dashboard.
function consoleTarget(dashboardUrl, path, appMount) {
  const mount = String(appMount || '').replace(/\/+$/, '');
  let rest = String(path || '/');
  if (mount && (rest === mount || rest.startsWith(mount + '/'))) {
    rest = rest.slice(mount.length) || '/';
  }
  const tail = rest.slice(ADMIN_PATH.length);
  return dashboardUrl + tail;
}

function refusalPage() {
  return '<!doctype html>\n'
    + '<html lang="en">\n<head>\n  <meta charset="utf-8">\n'
    + '  <meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '  <meta name="robots" content="noindex">\n'
    + '  <title>Admin console</title>\n'
    + '  <style>body{font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:36rem;'
    + 'padding:0 1rem;color:#1a1a1a}@media(prefers-color-scheme:dark){body{color:#ededed}}'
    + 'code{font-family:ui-monospace,monospace}</style>\n'
    + '</head>\n<body>\n'
    + '  <h1>Admin console</h1>\n'
    + '  <p>The admin console is served by the separate dashboard service. This instance '
    + 'does not know its address: set <code>DASHBOARD_URL</code> to it.</p>\n'
    + '</body>\n</html>\n';
}

/**
 * Mount the dashboard on the main application.
 *
 * @param {object} app    the Express application
 * @param {object} [options]
 * @param {string} [options.mode]           the mode in force; the environment decides by default
 * @param {string} [options.appMount]       the prefix the application is served under
 * @param {string} [options.dashboardOrigin] the dashboard service's own origin
 * @param {string} [options.apiUrl]         the API the console talks to
 * @returns {object} what is in force
 */
function mountDashboard(app, options) {
  if (!app || typeof app.handle !== 'function') {
    throw new Error('mountDashboard needs the Express application');
  }
  if (app[MOUNTED]) return app[MOUNTED];

  const opts = options || {};
  const mode = opts.mode || currentMode();
  const apiUrl = opts.apiUrl !== undefined ? opts.apiUrl : '';
  // The console's address, which is the dashboard service's origin and the
  // console's path inside it. The environment names the service's origin, so
  // a deployment that set it does not have to pass it again.
  const dashboardUrl = consoleUrlFromOrigin(opts.dashboardOrigin || process.env.DASHBOARD_URL || '');
  const info = describe({ mode, apiUrl, dashboardUrl });
  const appMount = String(opts.appMount || '').replace(/\/+$/, '');

  if (mode === 'bundled') {
    // The existing deployment: the client serves the console's pages and this
    // process serves the admin API. Nothing is changed, and the operator is
    // told which deployment they are running.
    report({ mode, apiUrl: info.apiUrl, dashboardUrl: info.dashboardUrl });
    app[MOUNTED] = info;
    return info;
  }

  const target = info.dashboardUrl;
  const original = app.handle;
  app.handle = function (req, res, next) {
    const pathname = pathnameOf(req);
    if (!isConsolePath(pathname, appMount)) {
      return original.call(this, req, res, next);
    }
    // The answer is written with the plain response object, because the
    // application has not decorated it yet at this point in the request.
    res.setHeader('Cache-Control', 'no-store');
    if (target) {
      res.writeHead(302, { Location: consoleTarget(target, pathname, appMount) });
      return res.end();
    }
    res.writeHead(404, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
    });
    return res.end(refusalPage());
  };

  report({ mode, apiUrl: info.apiUrl, dashboardUrl: info.dashboardUrl });
  if (target) {
    console.log('[info] the admin console is served by the separate dashboard service at ' + target);
  } else {
    console.warn('[warn] DASHBOARD_URL is not set, so this instance cannot point at the '
      + 'separate dashboard service. The admin console addresses answer with an explanation '
      + 'instead of a redirect.');
  }
  app[MOUNTED] = info;
  return info;
}

module.exports = {
  mountDashboard,
  isConsolePath,
  consoleTarget,
};

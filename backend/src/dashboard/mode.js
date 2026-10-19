'use strict';

// Which dashboard deployment this instance is running.
//
// Two modes, one meaning each:
//
//   bundled  - the admin console is part of the main application. The client
//              serves the console's pages under /admin, the same process
//              serves the admin API under /api/admin, and one deployment
//              carries both.
//
//   separate - the admin console is its own process. That process serves the
//              console's documents and talks to the main API over HTTP using
//              the same session contract the browser uses. The main process
//              keeps the API and stops serving the console's document.
//
// The value is read from the environment rather than from the configuration
// store, and that is deliberate. The store is read after the database is
// connected, so a mode that is only known afterwards cannot stop a
// misconfigured boot; and a wrong value in the environment is an operator
// mistake, which has to be visible at start-up rather than quietly defaulted
// to a mode that happens to work.

const { ADMIN_PATH, ADMIN_API_PATH } = require('./contract');

const MODES = ['bundled', 'separate'];
const DEFAULT_MODE = 'bundled';
const MODE_VARIABLE = 'DASHBOARD_MODE';

// The mode for this process, from the environment.
//
// The value is compared exactly: "bundled" and "separate" are the two words
// the documentation uses, and a half-typed word that was quietly accepted
// would hide a mistake until something behaved differently from what the
// operator asked for. An empty value is not a mistake - it is the unset case,
// and it means the default.
function parseMode(raw) {
  const value = raw === undefined || raw === null ? '' : String(raw).trim();
  if (value === '') return DEFAULT_MODE;
  if (MODES.indexOf(value) !== -1) return value;
  throw new Error(
    'Invalid ' + MODE_VARIABLE + ' value "' + String(raw) + '". '
    + 'Accepted values: ' + MODES.join(', ') + '. '
    + 'Set ' + MODE_VARIABLE + '=' + MODES[0] + ' to serve the admin console from the main '
    + 'process, or ' + MODE_VARIABLE + '=' + MODES[1] + ' to serve it from a separate '
    + 'dashboard service.'
  );
}

// The mode an environment describes.
function resolveMode(env) {
  const source = env || process.env;
  return parseMode(source[MODE_VARIABLE]);
}

// The mode of the running process, re-read so a caller that changes the
// environment is never answered from a stale value.
//
// An environment that cannot be used throws here, and therefore wherever the
// mode is read: the boot of the main process, and the start of the dashboard
// service. Both read it before they serve anything, so a wrong value stops
// the deployment rather than quietly selecting a mode nobody asked for.
function currentMode() {
  return resolveMode(process.env);
}

// An http(s) origin, or '' when the value is not one. Used for every address
// the diagnostics report, so a typo cannot be printed as if it were an
// address a browser could reach.
function originOf(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

function apiUrlFromEnv(env) {
  return originOf(env.DASHBOARD_API_URL || env.TRYCORD_API_URL || env.API_URL);
}

// Where the console is reached, per mode.
//
// In bundled mode that is this instance, under the mount the client is served
// from. In separate mode it is the dashboard service's own address, which the
// deployment has to name: the main process has no way to guess it.
function dashboardUrlFromEnv(env, mode) {
  if (mode === 'separate') {
    return consoleUrlFromOrigin(originOf(env.DASHBOARD_URL));
  }
  const base = originOf(env.TRYCORD_PUBLIC_URL);
  if (!base) return '';
  const mount = String(env.TRYCORD_APP_MOUNT || '').trim().replace(/\/+$/, '');
  return base + mount + ADMIN_PATH;
}

// The console's address, from the dashboard service's own origin.
//
// The service is reached at the root of its origin and the console lives
// under /admin inside it, so the console's address is the origin and that
// path. One address to configure, and no way to point the main instance at
// the service's front door by mistake.
function consoleUrlFromOrigin(origin) {
  const base = originOf(origin);
  return base ? base + ADMIN_PATH : '';
}

// What is in force, for diagnostics.
//
// The facts are passed in rather than read here, so the same description can
// be produced by the main process and by the dashboard service, each with
// what it actually knows.
function describe(facts) {
  const f = facts || {};
  const mode = f.mode || currentMode();
  const apiUrl = f.apiUrl !== undefined ? f.apiUrl : apiUrlFromEnv(process.env);
  const dashboardUrl = f.dashboardUrl !== undefined
    ? f.dashboardUrl
    : dashboardUrlFromEnv(process.env, mode);
  return {
    mode,
    // Which process serves the console's documents.
    servedBy: mode === 'separate' ? 'separate-service' : 'main-process',
    dashboardUrl,
    apiUrl,
    dashboardPath: ADMIN_PATH,
    adminApiPath: ADMIN_API_PATH,
  };
}

// The one line an operator reads at boot to know which deployment is running.
function describeLine(info) {
  const i = info || describe();
  if (i.mode === 'separate') {
    return 'dashboard mode: separate (the admin console is served by the separate dashboard'
      + ' service' + (i.dashboardUrl ? ' at ' + i.dashboardUrl : '') + ')';
  }
  return 'dashboard mode: bundled (the admin console is served by the main process at '
    + i.dashboardPath + ')';
}

// Print the mode in force. Called once at boot, by whichever process owns the
// console.
function report(facts) {
  const info = describe(facts);
  console.log('[info] ' + describeLine(info));
  if (info.mode === 'separate' && info.apiUrl) {
    console.log('[info] dashboard talks to the API at ' + info.apiUrl);
  }
  return info;
}

module.exports = {
  MODES,
  DEFAULT_MODE,
  MODE_VARIABLE,
  // The mode this process is running in. Read from the environment on every
  // access, so it is never a stale answer.
  get mode() { return currentMode(); },
  parseMode,
  resolveMode,
  currentMode,
  describe,
  describeLine,
  report,
  originOf,
  consoleUrlFromOrigin,
};

'use strict';

// The contract between the dashboard and the API.
//
// Two parties, one document.
//
// The dashboard is a presentation surface. It renders the administrative
// screens and it holds no state of its own: no accounts, no sessions, no
// moderation decisions, no data. The API is the only authority. It owns the
// accounts, the sessions and the data every screen shows, and it decides
// every question the console asks.
//
// This file is that contract, written down. The separate dashboard service
// makes its own calls from the definitions here, and the client
// (frontend/packages/api.js) makes the console's calls with the same scheme
// and the same paths, so the two cannot drift apart without this file being
// wrong.
//
// Nothing here decides anything at runtime. It is the description both sides
// are written against.

const CONTRACT_VERSION = 1;

// Where the admin console lives inside the client, and where the API keeps
// the endpoints behind it. Both are properties of the client tree, not of a
// deployment, so they are written down once here.
const ADMIN_PATH = '/admin';
const ADMIN_API_PATH = '/api/admin';

// The documents the console is made of.
//
// The console itself, and the sign-in screens a reader needs: a session is
// kept per origin, so an operator signing in on the dashboard's own origin
// has to be able to sign in there.
const DOCUMENTS = {
  console: ADMIN_PATH,
  signIn: [
    '/login', '/register', '/forgot', '/reset-password', '/verify-email', '/two-step',
  ],
};

// How a session is presented.
//
// A session is a bearer token, exactly as the browser presents it. The
// dashboard does not have a session of its own, does not mint one, and does
// not keep one: it forwards the caller's token to the API and reports what
// the API said.
const AUTH = {
  scheme: 'bearer',
  header: 'authorization',
  format: 'Bearer <token>',
  issuedBy: 'POST /api/auth/login or POST /api/auth/register on the API; the answer carries .token',
  storedBy: 'the browser, in localStorage, under the API origin (frontend/packages/api.js)',
  // The one rule that keeps the dashboard a presentation surface: a password
  // is exchanged with the API and with nothing else. The dashboard never
  // sees one, so it cannot leak one and cannot become a way in.
  passwords: 'never handled by the dashboard; the browser posts them to the API directly',
};

// The headers the dashboard sends to the API.
const HEADERS = {
  accept: 'application/json',
  contentType: 'application/json',
  authorization: 'Bearer <token>',
};

// The endpoints.
//
// `auth: false` means no session is presented. `admin: true` means the API
// refuses the call unless the session belongs to a platform administrator -
// the console shows the refusal, it does not decide who is an administrator.
const ENDPOINTS = {
  // --- what the dashboard service itself calls -----------------------------
  health: {
    method: 'GET',
    path: '/api/health',
    auth: false,
    purpose: 'the API\'s own health, including its database. The dashboard reports it separately from its own.',
  },
  instance: {
    method: 'GET',
    path: '/api/instance',
    auth: false,
    purpose: 'public instance metadata: the name, the version, the registration policy.',
  },
  session: {
    method: 'GET',
    path: '/api/users/me',
    auth: true,
    purpose: 'the session check. The answer carries the account and whether it is a platform administrator.',
  },

  // --- what the console calls, from the browser ----------------------------
  login: {
    method: 'POST',
    path: '/api/auth/login',
    auth: false,
    purpose: 'exchange credentials for a session token. The browser calls the API directly.',
  },
  register: {
    method: 'POST',
    path: '/api/auth/register',
    auth: false,
    purpose: 'create an account. The browser calls the API directly.',
  },
  logout: {
    method: 'POST',
    path: '/api/auth/logout',
    auth: true,
    purpose: 'end the session on the server, not only in the interface.',
  },
  profile: {
    method: 'GET',
    path: '/api/users/me',
    auth: true,
    purpose: 'the signed-in account.',
  },
  wsTicket: {
    method: 'POST',
    path: '/api/auth/ws/ticket',
    auth: true,
    purpose: 'a one-use ticket for the realtime gateway. The browser presents it to the API\'s own gateway.',
  },

  // --- the administrative surface ------------------------------------------
  // Every one of these is behind the admin guard: a session that is not a
  // platform administrator is refused by the API, and the console shows the
  // refusal.
  admin: {
    overview: { method: 'GET', path: '/api/admin/overview', auth: true, admin: true, purpose: 'counts, open reports and appeals, recent audit entries.' },
    users: { method: 'GET', path: '/api/admin/users', auth: true, admin: true, purpose: 'the people on this instance, searchable.' },
    userActions: { method: 'GET', path: '/api/admin/users/:id/actions', auth: true, admin: true, purpose: 'the moderation history of one account.' },
    approveUser: { method: 'POST', path: '/api/users/:id/approve', auth: true, admin: true, purpose: 'let a waiting account in.' },
    enforceUser: { method: 'POST', path: '/api/admin/users/:id/enforce', auth: true, admin: true, purpose: 'apply a moderation action. The server invalidates the sessions and cuts the live sockets.' },
    liftUser: { method: 'POST', path: '/api/admin/users/:id/lift', auth: true, admin: true, purpose: 'lift a moderation action.' },
    approvals: { method: 'GET', path: '/api/admin/approvals', auth: true, admin: true, purpose: 'the accounts waiting to be let in.' },
    servers: { method: 'GET', path: '/api/admin/servers', auth: true, admin: true, purpose: 'every community on this instance.' },
    suspendServer: { method: 'POST', path: '/api/admin/servers/:id/suspend', auth: true, admin: true, purpose: 'suspend a community.' },
    liftServer: { method: 'POST', path: '/api/admin/servers/:id/lift', auth: true, admin: true, purpose: 'lift a community\'s suspension.' },
    reports: { method: 'GET', path: '/api/admin/reports', auth: true, admin: true, purpose: 'the reports raised by members.' },
    report: { method: 'GET', path: '/api/admin/reports/:id', auth: true, admin: true, purpose: 'one report, in full.' },
    updateReport: { method: 'PATCH', path: '/api/admin/reports/:id', auth: true, admin: true, purpose: 'move a report along.' },
    appeals: { method: 'GET', path: '/api/admin/appeals', auth: true, admin: true, purpose: 'the requests to reconsider an enforcement.' },
    decideAppeal: { method: 'PATCH', path: '/api/admin/appeals/:id', auth: true, admin: true, purpose: 'answer an appeal.' },
    audit: { method: 'GET', path: '/api/admin/audit', auth: true, admin: true, purpose: 'the administrative actions, most recent first.' },
    gdprRequests: { method: 'GET', path: '/api/admin/gdpr/requests', auth: true, admin: true, purpose: 'the erasure and access requests.' },
    reviewGdprRequest: { method: 'POST', path: '/api/admin/gdpr/requests/:id/review', auth: true, admin: true, purpose: 'decide on a data request.' },
    processGdprRequest: { method: 'POST', path: '/api/admin/gdpr/requests/:id/process', auth: true, admin: true, purpose: 'carry out a data request.' },
    announcements: { method: 'GET', path: '/api/admin/announcements', auth: true, admin: true, purpose: 'the banners shown to everyone.' },
    settings: { method: 'GET', path: '/api/admin/settings', auth: true, admin: true, purpose: 'the instance settings and their current values.' },
    updateSettings: { method: 'PUT', path: '/api/admin/settings', auth: true, admin: true, purpose: 'change the instance settings.' },
    resetSetting: { method: 'DELETE', path: '/api/admin/settings/:key', auth: true, admin: true, purpose: 'put one setting back to its default.' },
    settingsStatus: { method: 'GET', path: '/api/admin/settings/status', auth: true, admin: true, purpose: 'which settings need a restart.' },
    pages: { method: 'GET', path: '/api/admin/pages', auth: true, admin: true, purpose: 'the public site pages this instance serves.' },
    page: { method: 'GET', path: '/api/admin/pages/:route', auth: true, admin: true, purpose: 'one page, with its draft and its published revision.' },
    savePageDraft: { method: 'PUT', path: '/api/admin/pages/:route', auth: true, admin: true, purpose: 'save a draft.' },
    publishPage: { method: 'POST', path: '/api/admin/pages/:route/publish', auth: true, admin: true, purpose: 'publish a page.' },
    unpublishPage: { method: 'POST', path: '/api/admin/pages/:route/unpublish', auth: true, admin: true, purpose: 'take a page down.' },
    pageRevisions: { method: 'GET', path: '/api/admin/pages/:route/revisions', auth: true, admin: true, purpose: 'the revision history of a page.' },
    restorePageRevision: { method: 'POST', path: '/api/admin/pages/:route/revisions/:revision/restore', auth: true, admin: true, purpose: 'put an earlier revision back.' },
    databaseConfig: { method: 'GET', path: '/api/admin/database', auth: true, admin: true, purpose: 'where the instance keeps its data.' },
    testDatabaseConfig: { method: 'POST', path: '/api/admin/database/test', auth: true, admin: true, purpose: 'try a database configuration without applying it.' },
    saveDatabaseConfig: { method: 'PUT', path: '/api/admin/database', auth: true, admin: true, purpose: 'save a database configuration.' },
    clearDatabaseConfig: { method: 'DELETE', path: '/api/admin/database', auth: true, admin: true, purpose: 'drop the saved database configuration.' },
    rollbackDatabaseConfig: { method: 'POST', path: '/api/admin/database/rollback', auth: true, admin: true, purpose: 'go back to the previous database configuration.' },
    applyDatabaseConfig: { method: 'POST', path: '/api/admin/database/apply', auth: true, admin: true, purpose: 'apply the saved database configuration.' },
    backups: { method: 'GET', path: '/api/admin/database/backups', auth: true, admin: true, purpose: 'the backups this instance has taken.' },
    takeBackup: { method: 'POST', path: '/api/admin/database/backup', auth: true, admin: true, purpose: 'take a backup now.' },
    diagnostics: { method: 'GET', path: '/api/admin/diagnostics', auth: true, admin: true, purpose: 'what each subsystem of the instance is doing.' },
    mail: { method: 'GET', path: '/api/admin/mail', auth: true, admin: true, purpose: 'the mail configuration and the last deliveries.' },
    mailValidate: { method: 'POST', path: '/api/admin/mail/validate', auth: true, admin: true, purpose: 'check the mail configuration.' },
    mailTestSend: { method: 'POST', path: '/api/admin/mail/test', auth: true, admin: true, purpose: 'send a test message.' },
    continuumInstances: { method: 'GET', path: '/api/continuum/instances', auth: true, admin: true, purpose: 'the instances this one federates with.' },
    continuumAddInstance: { method: 'POST', path: '/api/continuum/instances', auth: true, admin: true, purpose: 'federate with an instance.' },
    continuumTrust: { method: 'PATCH', path: '/api/continuum/instances/:id/trust', auth: true, admin: true, purpose: 'set how far an instance is trusted.' },
    continuumEvents: { method: 'GET', path: '/api/continuum/events', auth: true, admin: true, purpose: 'the federation events this instance has sent.' },
    continuumInbox: { method: 'GET', path: '/api/continuum/inbox', auth: true, admin: true, purpose: 'the federation events this instance has received.' },
  },
};

// How the console finds the API.
//
// The client resolves its backend in a fixed order (frontend/packages/config.js):
//
//   1. the address this reader chose in this browser
//   2. backend.json, next to the document
//   3. the origin that served the page
//   4. the hosted default
//
// The second one is what the separate dashboard service uses. It serves a
// backend.json naming the main API, so a console served by the dashboard
// talks to the main instance rather than to itself.
const CLIENT = {
  configFile: '/backend.json',
  configShape: { backendUrl: 'the origin of the main API' },
  resolutionOrder: [
    'the address the reader chose in this browser',
    'backend.json, next to the document',
    'the origin that served the page',
    'the hosted default',
  ],
  note: 'the dashboard service serves backend.json itself. It never serves the copy that '
    + 'ships in the client tree, which names the hosted network.',
};

// What the API answers, and what the dashboard does with it.
//
// The API's error envelope is the same everywhere: { error: { code, message } }.
// The dashboard passes it through rather than replacing it, because the code
// is what tells an operator what actually happened.
const FAILURES = {
  apiDown: {
    status: 502,
    code: 'API_UNREACHABLE',
    meaning: 'the main API did not answer: it is down, or the address is wrong, or the network between them is broken.',
    dashboard: 'the dashboard says so and keeps serving the console\'s own pages. It does not pretend the API answered.',
  },
  sessionRefused: {
    status: 401,
    code: 'SESSION_REFUSED',
    meaning: 'the API rejected the session: it expired, it was revoked, or the account is gone.',
    dashboard: 'the console signs the reader out, exactly as it would against the main instance.',
  },
  notAdmin: {
    status: 403,
    code: 'PERMISSION_DENIED',
    meaning: 'the session is valid but the account is not a platform administrator.',
    dashboard: 'the console shows that the account may not administer this instance.',
  },
  originRefused: {
    status: 403,
    code: 'ORIGIN_NOT_ALLOWED',
    meaning: 'the request came from an origin the dashboard does not serve.',
    dashboard: 'the request is refused before it reaches the API.',
  },
};

// The origin policy, which has two halves and both have to hold.
//
// The dashboard's own list (DASHBOARD_ORIGIN) says who may load the console.
// The API's list (CLIENT_ORIGIN) says whose browser may call the API. A
// console at one origin talking to an API at another needs both to name the
// other, and a deployment that forgets one half fails in the browser with a
// CORS error that looks like a broken network.
const ORIGIN = {
  dashboardSide: {
    variable: 'DASHBOARD_ORIGIN',
    rule: 'the origins allowed to load the dashboard, comma separated. There is no default and no wildcard: a dashboard that serves administration pages must not be loadable from anywhere.',
    refusal: 'a request carrying an Origin outside the list is refused with 403 before it reaches anything.',
  },
  apiSide: {
    variable: 'CLIENT_ORIGIN',
    rule: 'the main instance must list the dashboard\'s own origin, or the browser refuses every answer the API gives the console.',
  },
  framing: 'the console is never framed: X-Frame-Options: DENY and frame-ancestors \'none\'.',
};

module.exports = {
  CONTRACT_VERSION,
  ADMIN_PATH,
  ADMIN_API_PATH,
  DOCUMENTS,
  AUTH,
  HEADERS,
  ENDPOINTS,
  CLIENT,
  FAILURES,
  ORIGIN,
};

'use strict';

// Which part of a split deployment this process is.
//
// Three roles, one meaning each:
//
//   unified  - one server does all of it: the API, the WebSocket gateway, the
//              background jobs, the web client, and the public website. This
//              is how an instance has always run, and it stays the default
//              when the variable is unset.
//
//   backend  - the API server of a split deployment. It keeps the API, the
//              gateway and the jobs, and serves no client document and no
//              website. Browsers never open this origin; the frontend server
//              does, and it needs its origin in CLIENT_ORIGIN to be answered.
//
//   frontend - the client server of a split deployment. It serves the web
//              client and the public website and nothing else: no database,
//              no API, no gateway, no jobs. It tells the browser where the
//              API lives (TRYCORD_API_URL), which makes the split possible
//              with no rebuild of the client.
//
// The value is read from the environment rather than from the configuration
// store, and that is deliberate: the frontend server has no database to read
// a store from, so a role cannot live there, and a role is a deployment fact
// that the two servers of a split must be able to state independently. This
// is the same reasoning the dashboard's DASHBOARD_MODE follows.
//
// One nuance the three-role shape forces: the API process never runs as the
// frontend. A process that has a database attached and is being asked to
// serve only static files is almost always the wrong entry point for what
// the operator wants - the frontend server is npm run start:frontend - so
// that combination is refused with the suggestion, not degraded into
// something that half works.

const ROLES = ['unified', 'backend', 'frontend'];
const DEFAULT_ROLE = 'unified';
const ROLE_VARIABLE = 'TRYCORD_DEPLOYMENT_ROLE';

// The role an environment describes. An empty value is not a mistake - it is
// the unset case, and it means the default. Anything else must be one of the
// three words exactly, because a half-typed role that was quietly accepted
// would hide the mistake until a server behaved differently from what the
// operator asked for.
function parseRole(raw) {
  const value = raw === undefined || raw === null ? '' : String(raw).trim().toLowerCase();
  if (value === '') return DEFAULT_ROLE;
  if (ROLES.indexOf(value) !== -1) return value;
  throw new Error(
    'Invalid ' + ROLE_VARIABLE + ' value "' + String(raw) + '". '
    + 'Accepted values: ' + ROLES.join(', ') + '. '
    + 'Leave it unset (or set ' + ROLE_VARIABLE + '=unified) for one server that does '
    + 'everything, ' + ROLE_VARIABLE + '=backend for the API server of a split '
    + 'deployment, or ' + ROLE_VARIABLE + '=frontend for the client server - which '
    + 'is its own process, started with "npm run start:frontend".'
  );
}

// The role of the API process. It can be unified or backend here; the
// frontend is refused with where to go instead, because a role that names a
// process that cannot carry it has to stop the boot rather than be
// discovered on the first request.
function parseBackendRole(raw) {
  const role = parseRole(raw);
  if (role === 'frontend') {
    throw new Error(
      ROLE_VARIABLE + '=frontend does not run on the API process. The frontend role '
      + 'has no database, no API and no gateway; it serves the web client and the '
      + 'public site and talks to the API server over the network. Start it with '
      + '"npm run start:frontend", or leave ' + ROLE_VARIABLE + ' unset here.'
    );
  }
  return role;
}

// The role the running API process is in, re-read so a caller that changes
// the environment is never answered from a stale value.
function currentBackendRole() {
  return parseBackendRole(process.env[ROLE_VARIABLE]);
}

// The role the frontend process is in. The frontend entry point is defined
// by being the frontend, so the variable is only a cross-check here: unset
// is fine, 'frontend' is fine, and anything else is an operator who pointed
// the document at the wrong process.
function currentFrontendRole() {
  const value = process.env[ROLE_VARIABLE] === undefined ? '' : String(process.env[ROLE_VARIABLE]).trim().toLowerCase();
  if (value === '' || value === 'frontend') return 'frontend';
  throw new Error(
    'Invalid ' + ROLE_VARIABLE + ' value "' + String(process.env[ROLE_VARIABLE]) + '" on the '
    + 'frontend server. This process serves only the web client and the public site, '
    + 'which is the frontend role. Either unset ' + ROLE_VARIABLE + ' here, or set it to '
    + 'frontend. The API server of a split deployment is "npm start" with '
    + ROLE_VARIABLE + '=backend; one server that does everything is "npm start" with '
    + 'the variable unset.'
  );
}

module.exports = {
  ROLE_VARIABLE,
  ROLES,
  DEFAULT_ROLE,
  parseRole,
  parseBackendRole,
  currentBackendRole,
  currentFrontendRole,
};

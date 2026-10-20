// The parity hole.
//
// The audit that missed the incomplete settings compared the backend's
// routes with the client's API methods and found them equal. A method nobody
// calls looks exactly like a method somebody calls, so that check could not
// see the difference between a route the console offers and a route the
// server only offers to itself.
//
// This check goes one level deeper. It reads the routes the server really
// has, and it asks the question that was missed: is each one of them
// reachable from the community settings console?
//
// A route is reachable when the console's catalogue names it, when the call
// that performs it exists, and when the console's own source - the studio
// and the pages it delegates to - refers to that call. So a route added to
// the server and not to the console fails here, and so does a route whose
// call was never wired up.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMMUNITY_ROUTES, COMMUNITY_SECTIONS } from '../../packages/communitySettings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', '..');
const BACKEND = path.join(CLIENT, '..', 'backend');

// The community routers the server mounts, and where they are mounted.
//
// The check reads the server's own mounts and refuses to run against a
// server that has gained a community router it does not know about: a route
// the check cannot see is a route the check cannot hold anybody to.
const MOUNTS = [
  { file: 'servers', mount: '/api/servers', router: 'router' },
  { file: 'channels', mount: '/api/servers/:serverId/channels', router: 'router' },
  { file: 'categories', mount: '/api/servers/:serverId/categories', router: 'router' },
  { file: 'roles', mount: '/api/servers/:serverId/roles', router: 'router' },
  { file: 'invites', mount: '/api/servers/:serverId/invites', router: 'managed' },
  { file: 'integrations', mount: '/api/servers/:serverId', router: 'router' },
];

// The community routers that are not about configuring a community.
//
// The workspace is the collaboration surface, and the community memory is a
// feature of its own. Both are mounted under a community, and neither is a
// setting of one, so they are not this check's business.
const OTHER_FEATURES = ['workspace', 'communityMemory'];

// The routes that are not about configuring a community.
//
// Each one is here with the reason it is not: they are the community's
// lifecycle, or its content, and each has a page of its own.
const NOT_CONFIGURATION = [
  { method: 'GET', path: '/api/servers', why: 'the list of the reader\'s communities' },
  { method: 'POST', path: '/api/servers', why: 'a community is created, not configured' },
  { method: 'GET', path: '/api/servers/by-code/:code', why: 'the preview before joining' },
  { method: 'POST', path: '/api/servers/join/:code', why: 'the legacy permanent-code join' },
  { method: 'GET', path: '/api/servers/:id', why: 'the community itself' },
  { method: 'GET', path: '/api/servers/media/:id', why: 'the bytes of the community icon' },
  { method: 'POST', path: '/api/servers/:id/leave', why: 'a member leaves' },
  { method: 'GET', path: '/api/servers/:id/export', why: 'the operator\'s copy of the community' },
  { method: 'GET', path: '/api/servers/:serverId/channels/:channelId/pins', why: 'pins are content' },
  { method: 'POST', path: '/api/servers/:serverId/channels/:channelId/pins', why: 'pins are content' },
  { method: 'DELETE', path: '/api/servers/:serverId/channels/:channelId/pins/:messageId', why: 'pins are content' },
];

// The address of a route, with the names of its parameters taken out. Two
// routes are the same route whatever the parameters are called.
function shape(address) {
  return String(address).replace(/:[A-Za-z_]+/g, ':');
}

// The routes a community router declares.
function routesOf(file, router) {
  const source = fs.readFileSync(path.join(BACKEND, 'src', 'routes', file + '.js'), 'utf8');
  const found = [];
  const re = new RegExp('\\b' + router + '\\.(get|post|patch|put|delete)\\(\\s*\'([^\']*)\'', 'g');
  let match;
  while ((match = re.exec(source)) !== null) {
    found.push({ method: match[1].toUpperCase(), path: match[2] });
  }
  return found;
}

// The community routers the server mounts, read from the server itself.
function serverMounts() {
  const source = fs.readFileSync(path.join(BACKEND, 'src', 'server.js'), 'utf8');
  const found = [];
  const re = /app\.use\('(\/api\/servers[^']*)',\s*([^)]+)\);/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const target = match[2];
    const file = /require\('\.\/routes\/([a-zA-Z]+)'\)/.exec(target);
    const router = /([a-zA-Z]+)\.([a-zA-Z]+)$/.exec(target);
    found.push({
      mount: match[1],
      file: file ? file[1] : (router ? router[1] : null),
      router: router ? router[2] : 'router',
    });
  }
  return found;
}

// The console's own source: the studio, the pages it delegates to, and the
// shared rules both clients draw from.
function consoleSources() {
  const files = [
    path.join(CLIENT, 'js', 'features', 'communitySettings.js'),
    path.join(CLIENT, 'js', 'features', 'community.js'),
    path.join(CLIENT, 'js', 'community', 'manage.js'),
    path.join(CLIENT, 'js', 'ui', 'members.js'),
    path.join(CLIENT, 'mobile', 'js', 'views', 'communitySettings.js'),
    path.join(CLIENT, 'mobile', 'js', 'views', 'community.js'),
    path.join(CLIENT, 'mobile', 'js', 'manage.js'),
    path.join(CLIENT, 'packages', 'communitySettings.js'),
    path.join(CLIENT, 'packages', 'store.js'),
    path.join(CLIENT, 'packages', 'api.js'),
  ];
  const directory = path.join(CLIENT, 'js', 'features', 'communitySettings');
  if (fs.existsSync(directory)) {
    for (const name of fs.readdirSync(directory)) {
      if (name.endsWith('.js')) files.push(path.join(directory, name));
    }
  }
  return files;
}

test('the community settings console reaches every route that configures a community', async (t) => {
  await t.test('the server mounts no community router the check does not know about', () => {
    const mounted = serverMounts()
      .filter((entry) => entry.file && !OTHER_FEATURES.includes(entry.file))
      .map((entry) => entry.file);
    const known = MOUNTS.map((entry) => entry.file);
    const missing = mounted.filter((file) => !known.includes(file));
    assert.deepEqual(missing, [],
      'the server mounts community routers this check does not read:\n' + missing.join('\n'));
  });

  await t.test('every route that configures a community is in the catalogue', () => {
    const missing = [];
    for (const mount of MOUNTS) {
      for (const route of routesOf(mount.file, mount.router)) {
        const address = route.path === '/'
          ? mount.mount
          : mount.mount + route.path;
        // The community's icon and banner are built in a loop, so the address
        // is assembled at boot. The two of them are named here.
        if (route.path.indexOf("' + ") !== -1) {
          for (const kind of ['icon', 'banner']) {
            const full = mount.mount + '/:id/' + kind;
            if (!inCatalogue(route.method, full) && !isExcluded(route.method, full)) {
              missing.push(route.method + ' ' + full);
            }
          }
          continue;
        }
        if (!inCatalogue(route.method, address) && !isExcluded(route.method, address)) {
          missing.push(route.method + ' ' + address);
        }
      }
    }
    assert.deepEqual(missing, [],
      'routes the server has and the console does not reach:\n' + missing.join('\n'));
  });

  await t.test('every route in the catalogue is a route the server has', () => {
    const server = new Set();
    for (const mount of MOUNTS) {
      for (const route of routesOf(mount.file, mount.router)) {
        const address = route.path === '/'
          ? mount.mount
          : mount.mount + route.path;
        if (route.path.indexOf("' + ") !== -1) {
          for (const kind of ['icon', 'banner']) {
            server.add(route.method + ' ' + shape(mount.mount + '/:id/' + kind));
          }
          continue;
        }
        server.add(route.method + ' ' + shape(address));
      }
    }
    const unknown = COMMUNITY_ROUTES
      .filter((route) => !server.has(route.method + ' ' + shape(route.path)))
      .map((route) => route.method + ' ' + route.path);
    assert.deepEqual(unknown, [],
      'routes the catalogue names and the server does not have:\n' + unknown.join('\n'));
  });

  await t.test('every route in the catalogue has a call that exists', () => {
    const api = fs.readFileSync(path.join(CLIENT, 'packages', 'api.js'), 'utf8');
    const shared = fs.readFileSync(path.join(CLIENT, 'packages', 'communitySettings.js'), 'utf8');
    const missing = COMMUNITY_ROUTES.filter((route) => {
      const inApi = new RegExp('(^|[\\s,{])' + route.call + '\\s*:').test(api);
      const inShared = new RegExp('(^|[\\s,{])' + route.call + '\\s*:').test(shared);
      return !inApi && !inShared;
    }).map((route) => route.call + ' (' + route.method + ' ' + route.path + ')');
    assert.deepEqual(missing, [],
      'routes whose call does not exist:\n' + missing.join('\n'));
  });

  await t.test('every call in the catalogue is used by the console', () => {
    const source = consoleSources().map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    const unused = COMMUNITY_ROUTES
      .filter((route) => source.indexOf(route.call) === -1)
      .map((route) => route.call + ' (' + route.method + ' ' + route.path + ')');
    assert.deepEqual(unused, [],
      'routes the console never reaches:\n' + unused.join('\n'));
  });

  await t.test('every route in the catalogue is offered by a section', () => {
    const sections = new Set(COMMUNITY_SECTIONS.map((section) => section.id));
    const homeless = COMMUNITY_ROUTES
      .filter((route) => !route.surfaces.length)
      .map((route) => route.method + ' ' + route.path);
    assert.deepEqual(homeless, [], 'routes with no surface:\n' + homeless.join('\n'));
    const unknown = COMMUNITY_ROUTES
      .filter((route) => route.surfaces.some((surface) => !sections.has(surface)))
      .map((route) => route.method + ' ' + route.path);
    assert.deepEqual(unknown, [],
      'routes offered by a section that does not exist:\n' + unknown.join('\n'));
  });

  await t.test('the exclusions are the ones the check says they are', () => {
    // An exclusion that names a route the server does not have is a stale
    // excuse, and a stale excuse is how a route stops being checked.
    const server = new Set();
    for (const mount of MOUNTS) {
      for (const route of routesOf(mount.file, mount.router)) {
        const address = route.path === '/'
          ? mount.mount
          : mount.mount + route.path;
        server.add(route.method + ' ' + shape(address));
      }
    }
    const stale = NOT_CONFIGURATION
      .filter((route) => !server.has(route.method + ' ' + shape(route.path)))
      .map((route) => route.method + ' ' + route.path);
    assert.deepEqual(stale, [],
      'exclusions for routes the server does not have:\n' + stale.join('\n'));
  });
});

function inCatalogue(method, address) {
  return COMMUNITY_ROUTES.some((route) => route.method === method && shape(route.path) === shape(address));
}

function isExcluded(method, address) {
  return NOT_CONFIGURATION.some((route) => route.method === method && shape(route.path) === shape(address));
}

// The harness the extension and workflow tests share.
//
// An instance of its own, with the extension router mounted, plus the two
// accounts the tests need: an administrator and an ordinary member.
//
// The router is mounted on an app of its own rather than on the running
// instance. The instance answers every unmatched /api path with a JSON 404
// before a router added after the boot could ever see the request, so a
// router mounted after the fact would never be reached. The app here is
// mounted exactly the way the instance mounts it - the same module, the same
// path - and it talks to the same database.
//
// The tables are applied from the same module the schema uses, so the DDL
// that is tested is the DDL that ships.

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { startInstance, apiClient, registerUser } = require('../helpers/instance');

const ROOT = path.join(__dirname, '..', '..');

function src(...parts) {
  return path.join(ROOT, 'src', ...parts);
}

/** Apply the extension tables to the running instance's database. */
async function applyExtensionSchema(db) {
  const engine = db.dialect === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : '';
  const ddl = require(src('db', 'tables', 'extensions'))(engine);
  for (const statement of ddl) await db.exec(statement);
}

/**
 * Start an instance and mount the extension router.
 *
 * @param {object} [options] passed to startInstance
 * @returns {Promise<object>} { instance, db, admin, member, ext, close }
 */
async function start(options = {}) {
  const env = Object.assign({ ADMIN_USERNAMES: 'root' }, options.env || {});
  const instance = await startInstance(Object.assign({}, options, { env }));

  // Required after the instance has booted: booting clears the module cache
  // for src/, so anything required before this would be a second copy of the
  // database facade with no connection.
  const db = require(src('db'));
  await applyExtensionSchema(db);

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/extensions', require(src('routes', 'extensions')));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const extUrl = 'http://127.0.0.1:' + server.address().port;

  const admin = await registerUser(instance, 'root');
  const member = await registerUser(instance, 'member');
  const stranger = await registerUser(instance, 'stranger');

  return {
    instance,
    db,
    admin,
    member,
    stranger,
    // The core API, on the instance itself.
    api: (token) => apiClient(instance.baseUrl, token),
    // The extension API, on the app the router is mounted on.
    ext: {
      admin: apiClient(extUrl, admin.token),
      member: apiClient(extUrl, member.token),
      stranger: apiClient(extUrl, stranger.token),
      url: extUrl,
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await instance.stop();
    },
  };
}

/**
 * Write a registry directory.
 *
 * The mirror mode of the registry reads a directory: either one registry.json
 * holding a list, or one file per package.
 */
function writeRegistry(dir, packages) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify(packages, null, 2));
  return dir;
}

/** Point the instance at a registry directory and return the policy. */
async function useMirror(client, dir, extra) {
  const res = await client.put('/api/extensions/policy', Object.assign({
    registryMode: 'mirror',
    registryUrl: dir,
  }, extra || {}));
  if (!res.ok) throw new Error('could not point the instance at the mirror: ' + JSON.stringify(res.data));
  return res.data.policy;
}

/** The messages in a channel, oldest first. */
async function messagesIn(db, channelId) {
  return db.all(
    'SELECT id, author_id, content FROM messages WHERE channel_id = ? ORDER BY seq ASC',
    [channelId]
  );
}

/** A community with one channel, owned by the caller. */
async function community(api, name) {
  const res = await api.post('/api/servers', { name: name || 'Test community' });
  if (!res.ok) throw new Error('could not create a community: ' + JSON.stringify(res.data));
  return res.data;
}

module.exports = { start, writeRegistry, useMirror, messagesIn, community, src };

// A workspace instance to measure.
//
// The instance is a real one: the shared helper boots it on a temporary
// SQLite database and a free port, with its own signing secret. The
// workspace router is mounted on a small application of its own, at the same
// paths the server uses, next to the community routers it composes with - so
// the URLs under test are the real ones, and creating a community, a role, a
// channel or a message in a test goes through the same code it goes through
// in production.
//
// The workspace tables are applied to the instance's database directly. The
// schema module does not know about them yet: it is the deployment's job to
// register them, and until it does the tables have to exist for the routes
// to work at all.

'use strict';

const express = require('express');
const { startInstance, apiClient, registerUser } = require('../helpers/instance');

/**
 * Start an instance with the workspace mounted.
 *
 * @param {object}  [options] passed to the shared helper
 * @returns {Promise<object>} the running workspace
 */
async function startWorkspace(options = {}) {
  const instance = await startInstance(Object.assign({ client: false, publicSite: false }, options));

  // Required after the instance has started. The shared helper clears the
  // module cache so that the database connection it opened is the one these
  // modules talk to; requiring them earlier would bind them to a different
  // connection.
  const db = require('../../src/db');
  const tables = require('../../src/db/tables/workspace');
  const workspaceRouter = require('../../src/routes/workspace');
  const auth = require('../../src/routes/auth');
  const servers = require('../../src/routes/servers');
  const channels = require('../../src/routes/channels');
  const roles = require('../../src/routes/roles');
  const invites = require('../../src/routes/invites');
  const messages = require('../../src/routes/messages');

  const engine = db.dialect === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : '';
  for (const ddl of tables(engine)) {
    await db.exec(ddl);
  }

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', auth);
  app.use('/api/servers', servers);
  app.use('/api/servers/:serverId/channels', channels);
  app.use('/api/servers/:serverId/roles', roles);
  app.use('/api/servers/:serverId/invites', invites.managed);
  app.use('/api/invites', invites.byCode);
  app.use('/api/channels/:channelId/messages', messages);
  // The workspace router, at the path the server mounts it at.
  app.use('/api/servers/:serverId', workspaceRouter);

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });

  return {
    instance,
    db,
    baseUrl: 'http://127.0.0.1:' + server.address().port,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await instance.stop();
    },
  };
}

/** Create a community owned by the given client, and return its id. */
async function createCommunity(ws, owner, name = 'Workspace') {
  const res = await owner.post('/api/servers', { name, description: 'A community to work in' });
  if (!res.ok) {
    throw new Error('could not create the community: ' + res.status + ' ' + JSON.stringify(res.data));
  }
  return res.data.serverId;
}

/** Add a member to a community with an invite, and return their client. */
async function addMember(ws, owner, serverId, username) {
  const invite = await owner.post(`/api/servers/${serverId}/invites`, {});
  if (!invite.ok) {
    throw new Error('could not create an invite: ' + invite.status + ' ' + JSON.stringify(invite.data));
  }
  const member = await registerUser(ws, username);
  const joined = await member.post(`/api/invites/${invite.data.code}/join`, {});
  if (!joined.ok) {
    throw new Error('could not join the community: ' + joined.status + ' ' + JSON.stringify(joined.data));
  }
  return member;
}

/** Create a role in a community. */
async function createRole(owner, serverId, name, permissions = []) {
  const role = await owner.post(`/api/servers/${serverId}/roles`, { name, permissions });
  if (!role.ok) {
    throw new Error('could not create the role: ' + role.status + ' ' + JSON.stringify(role.data));
  }
  return role.data;
}

/** Give a role to a member. */
async function assignRole(owner, serverId, roleId, userId) {
  const assigned = await owner.post(`/api/servers/${serverId}/roles/${roleId}/assign`, { userId });
  if (!assigned.ok) {
    throw new Error('could not assign the role: ' + assigned.status + ' ' + JSON.stringify(assigned.data));
  }
  return assigned.data;
}

/** The channels of a community, as the API answers them. */
async function channelsOf(owner, serverId) {
  const res = await owner.get(`/api/servers/${serverId}/channels`);
  if (!res.ok) throw new Error('could not read the channels: ' + res.status);
  return res.data.channels;
}

/** Post a message in a channel. */
async function postMessage(owner, channelId, content) {
  const res = await owner.post(`/api/channels/${channelId}/messages`, { content });
  if (!res.ok) {
    throw new Error('could not post the message: ' + res.status + ' ' + JSON.stringify(res.data));
  }
  return res.data;
}

module.exports = {
  startWorkspace, createCommunity, addMember, createRole, assignRole, channelsOf, postMessage,
  apiClient, registerUser,
};

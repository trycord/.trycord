// A running instance with the routers under test mounted on it.
//
// The coordinator mounts the new routers in server.js. A test cannot wait
// for that, and it should not have to: the routers are the same objects
// either way. The application below is built the way the server builds one -
// the same paths, the same routers, the same database behind them - so the
// URLs under test are the real ones.
//
// The community routers are mounted alongside, because creating a community,
// inviting a member and posting a message is how a test gets to the state it
// wants to measure.

'use strict';

const express = require('express');
const { startInstance, apiClient, registerUser } = require('../helpers/instance');

// The paths the server uses, and the routers behind them.
const MOUNTS = [
  ['/api/auth', 'auth'],
  ['/api/servers', 'servers'],
  ['/api/servers/:serverId/channels', 'channels'],
  ['/api/servers/:serverId/categories', 'categories'],
  ['/api/servers/:serverId/roles', 'roles'],
  ['/api/servers/:serverId/invites', 'invites.managed'],
  ['/api/channels/:channelId/messages', 'messages'],
  ['/api/invites', 'invites.byCode'],
  ['/api/search', 'search'],
  ['/api/personal', 'personal'],
  ['/api/localisation', 'localisation'],
  ['/api/themes', 'themes'],
  ['/api/incidents', 'incidents'],
  ['/api/federation-reports', 'federation-reports'],
];

/**
 * Start an instance with the routers mounted.
 *
 * @param {object} [options] passed to the shared helper
 * @returns {Promise<object>} the running instance
 */
async function startRouted(options = {}) {
  const instance = await startInstance(Object.assign({ client: false, publicSite: false }, options));

  // Required after the instance has started: the shared helper clears the
  // module cache so that the database connection it opened is the one these
  // modules talk to.
  const db = require('../../src/db');
  const invites = require('../../src/routes/invites');

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  for (const [path, name] of MOUNTS) {
    const router = name === 'invites.managed' ? invites.managed
      : name === 'invites.byCode' ? invites.byCode
        : require('../../src/routes/' + name);
    app.use(path, router);
  }

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

/** Make an account a platform administrator. */
async function makeAdmin(ws, userId) {
  await ws.db.run(
    'INSERT INTO admins (user_id, created_at) VALUES (?, ?)',
    [userId, new Date().toISOString()]
  );
}

/** Create a community owned by the given client. */
async function createCommunity(ws, owner, name) {
  const res = await owner.post('/api/servers', { name, description: 'A community to measure' });
  if (!res.ok) {
    throw new Error('could not create the community: ' + res.status + ' ' + JSON.stringify(res.data));
  }
  return { serverId: res.data.serverId, channelId: res.data.channelId };
}

/** Add a member to a community with an invite. */
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

/** Create a channel in a community. */
async function createChannel(owner, serverId, name) {
  const res = await owner.post(`/api/servers/${serverId}/channels`, { name });
  if (!res.ok) {
    throw new Error('could not create the channel: ' + res.status + ' ' + JSON.stringify(res.data));
  }
  return res.data;
}

/** Post a message in a channel. */
async function postMessage(owner, channelId, content) {
  const res = await owner.post(`/api/channels/${channelId}/messages`, { content });
  if (!res.ok) {
    throw new Error('could not post the message: ' + res.status + ' ' + JSON.stringify(res.data));
  }
  return res.data;
}

/** Give a role to a member. */
async function assignRole(owner, serverId, roleId, userId) {
  const res = await owner.post(`/api/servers/${serverId}/roles/${roleId}/assign`, { userId });
  if (!res.ok) {
    throw new Error('could not assign the role: ' + res.status + ' ' + JSON.stringify(res.data));
  }
  return res.data;
}

/** Create a role in a community. */
async function createRole(owner, serverId, name, permissions) {
  const res = await owner.post(`/api/servers/${serverId}/roles`, { name, permissions });
  if (!res.ok) {
    throw new Error('could not create the role: ' + res.status + ' ' + JSON.stringify(res.data));
  }
  return res.data;
}

module.exports = {
  startRouted, makeAdmin, createCommunity, addMember, createChannel, postMessage,
  createRole, assignRole, apiClient, registerUser,
};

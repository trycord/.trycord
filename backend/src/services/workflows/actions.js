// The action catalogue.
//
// What an extension or a workflow is allowed to do. Every action names the
// capability it needs, and the engine checks that capability against the
// grant set before the action runs - not before the workflow was saved, so a
// grant that is taken back stops the action on the next call.
//
// The catalogue is closed. An action that is not in it cannot be run, and a
// step that names an action that is not in it is refused when the workflow
// is saved rather than failing halfway through a run.
//
// An action receives its parameters already resolved (the placeholders in
// them have been substituted) and a context that carries the grant set, the
// call budget, the run key and the owner. An action returns a small JSON
// value, which becomes the step's output and is available to later steps.

const db = require('../../db');
const { now, uuid } = require('../../util');
const extensionStore = require('../extensions/store');
// The refusal to write in the clear into an encrypted conversation. It is the
// bots service's, because the bots service posts into the same table and has
// the same problem, and two copies of the rule would eventually disagree.
const { refuseIfEncrypted } = require('../bots');

// The other services are required where they are used rather than at the top.
// The action catalogue is loaded by the engine, which is loaded by the
// routes, and a module that pulls the whole service tree in at require time
// makes the catalogue's load order everybody else's problem.

const MAX_MESSAGE = 2000;
const MAX_HISTORY = 50;

function actionError(message) {
  const e = new Error(message);
  e.code = 'ACTION_FAILED';
  return e;
}

function requiredString(params, name, max) {
  const value = params[name];
  if (value === undefined || value === null || value === '') {
    throw actionError('this action needs a ' + name);
  }
  const text = String(value);
  if (text.length > max) throw actionError('the ' + name + ' is longer than ' + max + ' characters');
  return text;
}

// ---- message posting ------------------------------------------------------

// The next position in a channel. The unique index on (channel_id, seq) is
// the authority: two writers that pick the same value are resolved by the
// retry in insertMessage below.
async function nextSeq(channelId) {
  const row = await db.get('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE channel_id = ?', [channelId]);
  return (row ? Number(row.m) : 0) + 1;
}

/**
 * Write one message.
 *
 * The nonce is the run key and the step index, so a run that is retried
 * resolves to the message the first attempt wrote instead of posting a
 * second time. The unique index on (channel_id, client_nonce) is what makes
 * that true rather than merely likely.
 *
 * A workflow writes **in the clear**, and it cannot write into a conversation
 * that is encrypted. The workflow holds no conversation key and cannot
 * produce an envelope, so a plaintext message there would be the one message
 * the members cannot read — and the server, which the conversation was closed
 * to, could read it. The run is recorded as failed with the reason, which is
 * the honest outcome.
 */
async function insertMessage({ channel, authorId, content, nonce }) {
  await refuseIfEncrypted(channel.id);  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await nextSeq(channel.id);
    const id = uuid();
    try {
      await db.run(
        'INSERT INTO messages (id, channel_id, author_id, content, created_at, seq, client_nonce) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, channel.id, authorId, content, now(), seq, nonce]
      );
      return { id, seq, deduped: false };
    } catch (e) {
      const duplicate = /unique/i.test(String((e && e.message) || e)) || (e && e.code === 'SQLITE_CONSTRAINT');
      if (!duplicate || attempt === 4) throw e;
      if (nonce) {
        const again = await db.get(
          'SELECT id, seq FROM messages WHERE channel_id = ? AND client_nonce = ?',
          [channel.id, nonce]
        );
        if (again) return { id: again.id, seq: again.seq, deduped: true };
      }
    }
  }
  throw actionError('could not assign a position to the message');
}

async function resolveChannel(params) {
  if (params.channelId) {
    const channel = await db.get('SELECT * FROM channels WHERE id = ?', [String(params.channelId)]);
    if (!channel) throw actionError('the channel ' + params.channelId + ' does not exist');
    return channel;
  }
  if (params.serverId) {
    const channel = await db.get(
      'SELECT * FROM channels WHERE server_id = ? ORDER BY position ASC, id ASC LIMIT 1',
      [String(params.serverId)]
    );
    if (!channel) throw actionError('that community has no channel to post in');
    return channel;
  }
  throw actionError('this action needs a channel or a community');
}

// The workflow acts as its owner, and the owner has to have a standing in the
// community it acts on. An account that is not a member of the community is
// refused, and so is one that is not a platform administrator: a workflow is
// not a way around either.
async function assertMemberOfCommunity(ctx, serverId) {
  const member = await db.get(
    'SELECT 1 FROM server_members WHERE user_id = ? AND server_id = ?',
    [ctx.ownerId, serverId]
  );
  if (member) return;
  const enforcement = require('../enforcement');
  if (await enforcement.isPlatformAdmin(ctx.ownerId)) return;
  throw actionError('the workflow owner is not a member of that community');
}

async function assertMayPost(ctx, channel) {
  await assertMemberOfCommunity(ctx, channel.server_id);
}

// The owner has to be allowed to administer roles in the community before a
// workflow may hand one out. The capability says "manage membership"; it does
// not say "become the owner of the community".
async function assertMayAdministerRoles(ctx, serverId) {
  await assertMemberOfCommunity(ctx, serverId);
  const permissions = require('../permissions');
  const allowed = await permissions.hasPermission(ctx.ownerId, serverId, 'MANAGE_ROLES');
  if (!allowed) {
    throw actionError('the workflow owner may not administer roles in that community');
  }
}

// The owner may only hand out authority they hold.
//
// This is the rule the interactive role routes already apply: a moderator
// with a narrow grant who creates a role carrying MANAGE_SERVER - or the
// literal '*' - promotes themselves in one step. The owner of the community
// holds '*' and is unrestricted; everybody else may only build from what they
// already have.
async function assertDelegable(ctx, serverId, raw) {
  const permissions = require('../permissions');
  const held = await permissions.effectivePermissions(ctx.ownerId, serverId);
  if (held.has('*')) return;
  let granted = [];
  try { granted = JSON.parse(raw || '[]'); } catch { granted = []; }
  const forbidden = granted.filter((p) => p === '*' || !held.has(p));
  if (forbidden.length) {
    throw actionError(
      'the workflow owner may not grant permissions they do not hold: ' + forbidden.join(', ')
    );
  }
}

// ---- the actions ----------------------------------------------------------

const ACTIONS = {
  'message.post': {
    capability: 'messages.write',
    description: 'Post a message in a channel.',
    async run(params, ctx) {
      const channel = await resolveChannel(params);
      const content = requiredString(params, 'content', MAX_MESSAGE);
      await assertMayPost(ctx, channel);
      const written = await insertMessage({
        channel,
        authorId: ctx.ownerId,
        content,
        nonce: ctx.runKey + ':' + ctx.stepIndex,
      });
      require('../events').emitChannel(channel.server_id, channel.id, {
        type: 'message',
        id: written.id,
        channel_id: channel.id,
        server_id: channel.server_id,
        author_id: ctx.ownerId,
        content,
        created_at: now(),
        seq: written.seq,
        attachments: [],
        reactions: [],
        pinned: false,
        reply_count: 0,
        thread_root_id: null,
        embeds: [],
        bot: { applicationId: ctx.workflowId, name: ctx.workflowName || 'workflow', kind: 'workflow' },
      });
      // The event that lets another workflow react to this one. It carries
      // the origin marker, so the workflow that produced it is not woken by
      // its own output.
      ctx.publish('message.created', {
        serverId: channel.server_id,
        channelId: channel.id,
        messageId: written.id,
        authorId: ctx.ownerId,
        content,
      });
      return { messageId: written.id, channelId: channel.id, seq: written.seq, deduped: written.deduped };
    },
  },

  'channel.history': {
    capability: 'messages.read',
    description: 'Read the most recent messages in a channel.',
    async run(params, ctx) {
      const channel = await resolveChannel(params);
      await assertMemberOfCommunity(ctx, channel.server_id);
      const limit = Math.min(Math.max(Number(params.limit) || 10, 1), MAX_HISTORY);
      const rows = await db.all(
        'SELECT id, author_id, content, created_at FROM messages WHERE channel_id = ? ORDER BY seq DESC LIMIT ' + limit,
        [channel.id]
      );
      return {
        channelId: channel.id,
        messages: rows.map((r) => ({
          id: r.id, authorId: r.author_id, content: r.content, createdAt: r.created_at,
        })),
      };
    },
  },

  'reaction.add': {
    capability: 'messages.write',
    description: 'Add a reaction to a message.',
    async run(params, ctx) {
      const messageId = requiredString(params, 'messageId', 64);
      const emoji = requiredString(params, 'emoji', 32);
      const message = await db.get('SELECT id, channel_id FROM messages WHERE id = ?', [messageId]);
      if (!message) throw actionError('that message does not exist');
      const channel = await db.get('SELECT * FROM channels WHERE id = ?', [message.channel_id]);
      await assertMayPost(ctx, channel);
      await require('../reactions').add(ctx.ownerId, messageId, emoji);
      return { messageId, emoji };
    },
  },

  'member.count': {
    capability: 'members.read',
    description: 'Count the members of a community.',
    async run(params, ctx) {
      const serverId = requiredString(params, 'serverId', 64);
      await assertMemberOfCommunity(ctx, serverId);
      const row = await db.get('SELECT COUNT(*) AS n FROM server_members WHERE server_id = ?', [serverId]);
      return { serverId, count: row ? Number(row.n) : 0 };
    },
  },

  'member.role.add': {
    capability: 'members.write',
    description: 'Give a member a role.',
    async run(params, ctx) {
      const serverId = requiredString(params, 'serverId', 64);
      const userId = requiredString(params, 'userId', 64);
      const roleId = requiredString(params, 'roleId', 64);
      // Handing out a role is handing out authority, so the owner has to be
      // allowed to do it there, and may only hand out what they hold. The
      // capability alone does not say either: it says the workflow may manage
      // membership, not that it may make anybody an administrator.
      await assertMayAdministerRoles(ctx, serverId);
      const member = await db.get(
        'SELECT 1 FROM server_members WHERE user_id = ? AND server_id = ?',
        [userId, serverId]
      );
      if (!member) throw actionError('that person is not a member of the community');
      const role = await db.get(
        'SELECT id, permissions FROM roles WHERE id = ? AND server_id = ?', [roleId, serverId]
      );
      if (!role) throw actionError('that role does not exist in the community');
      await assertDelegable(ctx, serverId, role.permissions);
      await db.run(
        'INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)',
        [serverId, userId, roleId]
      ).catch((e) => {
        // The primary key makes a repeated grant a no-op rather than an error.
        if (!/unique/i.test(String((e && e.message) || e))) throw e;
      });
      return { serverId, userId, roleId };
    },
  },

  'webhook.notify': {
    capability: 'webhooks.manage',
    description: 'Deliver an event to the outgoing webhooks of a community.',
    async run(params, ctx) {
      const serverId = requiredString(params, 'serverId', 64);
      const eventType = requiredString(params, 'eventType', 64);
      const payload = params.payload && typeof params.payload === 'object' ? params.payload : {};
      await assertMemberOfCommunity(ctx, serverId);
      const deliveries = await require('../webhooks').emit(serverId, eventType, payload);
      return { serverId, eventType, deliveries: deliveries.length };
    },
  },

  'instance.stats': {
    capability: 'admin.read',
    description: 'Read how many accounts, communities and messages this instance holds.',
    async run(params, ctx) {
      const users = await db.get('SELECT COUNT(*) AS n FROM users');
      const servers = await db.get('SELECT COUNT(*) AS n FROM servers');
      const messages = await db.get('SELECT COUNT(*) AS n FROM messages');
      return {
        users: users ? Number(users.n) : 0,
        servers: servers ? Number(servers.n) : 0,
        messages: messages ? Number(messages.n) : 0,
      };
    },
  },

  'workflow.run': {
    capability: 'workflows.run',
    description: 'Start another workflow as a child run.',
    async run(params, ctx) {
      const workflowId = requiredString(params, 'workflowId', 64);
      const child = await ctx.startChild(workflowId, params.payload || {});
      return { workflowId, runId: child.runId, status: child.status };
    },
  },

  'storage.put': {
    capability: 'storage.write',
    description: "Store a value in the extension's own storage.",
    async run(params, ctx) {
      if (!ctx.extensionId) throw actionError('this action needs an extension to store things for');
      const key = requiredString(params, 'key', 128);
      const value = params.value === undefined || params.value === null ? '' : String(params.value);
      if (value.length > 20000) throw actionError('the value is longer than 20000 characters');
      await extensionStore.putStorage(ctx.extensionId, key, value);
      return { key, stored: value.length };
    },
  },

  'federation.status': {
    capability: 'federation.read',
    description: 'Read whether federation is enabled and how many peers are known.',
    async run(params, ctx) {
      const continuum = require('../continuum');
      const enabled = continuum.enabled();
      let peers = 0;
      try {
        peers = (await continuum.listInstances()).length;
      } catch (e) {
        // Federation tables may not exist on an instance that never enabled
        // it. The status is still worth reporting.
        peers = 0;
      }
      return { enabled, peers };
    },
  },

  'log': {
    capability: null,
    description: 'Write a line into the run history. Needs no capability.',
    async run(params, ctx) {
      const message = params.message === undefined || params.message === null ? '' : String(params.message);
      if (message.length > 2000) throw actionError('the message is longer than 2000 characters');
      return { message };
    },
  },
};

/**
 * Run one action.
 *
 * The capability check lives here rather than in the caller, so that every
 * route into an action - a workflow step, a sandboxed extension - is checked
 * the same way. `dryRun` stops the action before it does anything.
 */
async function execute(name, params, ctx) {
  const action = ACTIONS[name];
  if (!action) throw actionError('there is no action called "' + name + '"');
  if (action.capability) {
    // The grant check is the engine's, because the engine knows the holder.
    // It is asserted here so that no caller can forget it.
    if (!ctx.grants || !ctx.grants.has(action.capability)) {
      const e = new Error(
        (ctx.holderName ? ctx.holderName + ' ' : '') +
        'has not been granted the capability "' + action.capability + '"'
      );
      e.code = 'PERMISSION_DENIED';
      e.capability = action.capability;
      throw e;
    }
  }
  if (ctx.dryRun) {
    return { dryRun: true, action: name, capability: action.capability, description: action.description };
  }
  ctx.budget.consume();
  return action.run(params || {}, ctx);
}

function catalogue() {
  return Object.entries(ACTIONS).map(([id, a]) => ({
    id,
    capability: a.capability,
    description: a.description,
  }));
}

function isKnown(name) {
  return Object.prototype.hasOwnProperty.call(ACTIONS, name);
}

module.exports = { ACTIONS, execute, catalogue, isKnown, actionError };

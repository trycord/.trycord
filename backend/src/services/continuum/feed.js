// The change feed.
//
// The relay publishes from this instance's own state rather than from a hook
// in every write path. A hook in every write path is a promise that every
// write path remembers to keep it, and one that forgets does it silently:
// the message is posted, and the peer never hears about it.
//
// So the relay reconciles instead. It keeps a ledger of what it has already
// federated, and each pass compares that ledger against the local tables:
//
//   - rows the ledger does not know about are new: publish them
//   - rows whose state has changed are updates: publish the change
//   - rows that are gone are deletions: publish the deletion
//
// The pass is bounded, so a large instance is worked through gradually
// rather than all at once, and it is driven by a durable job, so it survives
// a restart.

const db = require('../../db');
const { now } = require('../../util');
const ledger = require('./ledger');
const relay = require('./relay');

// How many rows one pass looks at per source kind.
const BATCH = 200;

async function feedCursor(name) {
  const row = await db.get('SELECT cursor FROM continuum_feed_state WHERE name = ?', [name]);
  return row ? String(row.cursor || '') : '';
}

async function setFeedCursor(name, cursor) {
  await db.upsert(
    'continuum_feed_state',
    ['name', 'cursor', 'updated_at'],
    [name, String(cursor || ''), now()],
    ['name'],
    { cursor: db.newRef('cursor'), updated_at: db.newRef('updated_at') }
  );
}

// Publish one thing, and record it as withheld when the rules say it may not
// leave. A withheld row stays withheld: what was not federable when it was
// written is not federated later.
async function publishOrWithhold(publish, kind, input, opts) {
  const result = await publish(kind, input, opts);
  if (result && result.ok) return result;
  if (result && result.withhold && result.source) {
    await ledger.markWithheld(result.source.kind, result.source.id, result.source.fingerprint);
  }
  return result;
}

// ---- new rows -------------------------------------------------------------

async function scanCommunities(publish) {
  const rows = await db.all(
    'SELECT s.id FROM servers s WHERE s.is_public = 1 '
    + 'AND NOT EXISTS (SELECT 1 FROM continuum_publications p WHERE p.source_kind = ? AND p.source_id = s.id) '
    + 'ORDER BY s.created_at ASC, s.id ASC LIMIT ' + BATCH,
    ['community']
  );
  for (const row of rows) {
    await publishOrWithhold(publish, 'community.published', { serverId: row.id });
  }
}

async function scanChannels(publish) {
  const rows = await db.all(
    'SELECT c.id, c.server_id FROM channels c JOIN servers s ON s.id = c.server_id '
    + 'WHERE s.is_public = 1 '
    + 'AND NOT EXISTS (SELECT 1 FROM continuum_publications p WHERE p.source_kind = ? AND p.source_id = c.id) '
    + 'ORDER BY c.position ASC, c.id ASC LIMIT ' + BATCH,
    ['channel']
  );
  for (const row of rows) {
    await publishOrWithhold(publish, 'channel.published', {
      serverId: row.server_id,
      channelId: row.id,
    });
  }
}

async function scanMessages(publish) {
  const rows = await db.all(
    'SELECT m.id, m.channel_id, c.server_id FROM messages m '
    + 'JOIN channels c ON c.id = m.channel_id JOIN servers s ON s.id = c.server_id '
    + 'WHERE s.is_public = 1 '
    + 'AND NOT EXISTS (SELECT 1 FROM continuum_publications p WHERE p.source_kind = ? AND p.source_id = m.id) '
    + 'ORDER BY m.created_at ASC, m.id ASC LIMIT ' + BATCH,
    ['message']
  );
  for (const row of rows) {
    await publishOrWithhold(publish, 'message.posted', {
      serverId: row.server_id,
      channelId: row.channel_id,
      messageId: row.id,
    });
  }
}

async function scanReactions(publish) {
  // The ledger keys a reaction by (message, user, emoji), which SQL cannot
  // express as a join, so the candidates are filtered here rather than in the
  // query.
  const rows = await db.all(
    'SELECT r.message_id, r.user_id, r.emoji, m.channel_id, c.server_id FROM reactions r '
    + 'JOIN messages m ON m.id = r.message_id '
    + 'JOIN channels c ON c.id = m.channel_id JOIN servers s ON s.id = c.server_id '
    + 'WHERE s.is_public = 1 '
    + 'ORDER BY r.created_at ASC LIMIT ' + BATCH
  );
  const candidates = [];
  for (const row of rows) {
    const key = relay.reactionKey(row.message_id, row.user_id, row.emoji);
    const known = await ledger.find('reaction', key);
    if (!known) candidates.push(row);
    if (candidates.length >= BATCH) break;
  }
  for (const row of candidates) {
    await publishOrWithhold(publish, 'reaction.added', {
      serverId: row.server_id,
      channelId: row.channel_id,
      messageId: row.message_id,
      userId: row.user_id,
      emoji: row.emoji,
    });
  }
}

// ---- changes and deletions ------------------------------------------------

// The kind an event carries when the row it is about has changed.
const UPDATE_KIND = {
  community: 'community.updated',
  channel: 'channel.updated',
  message: 'message.edited',
};

// The kind an event carries when the row it is about is gone. A community
// and a channel have no deletion event in the vocabulary, so their rows are
// only retired in the ledger.
const DELETE_KIND = {
  message: 'message.deleted',
  reaction: 'reaction.removed',
};

// Walk the ledger and look at what it says against what is there now.
async function sweepSource(publish, sourceKind) {
  const after = await feedCursor('sweep:' + sourceKind);
  const rows = await ledger.listForSweep(sourceKind, { after, limit: BATCH });
  if (!rows.length) return;

  for (const row of rows) {
    const local = await relay.readSource(sourceKind, row.source_id);
    if (!local) {
      // The row is gone. A deletion is relayed for the things the vocabulary
      // has a deletion for, so the remote copy does not outlive the original.
      const kind = DELETE_KIND[sourceKind];
      if (kind) {
        const input = relay.deletionInput(sourceKind, row.source_id, ledger.contextOf(row));
        if (input) await publishOrWithhold(publish, kind, input);
      }
      await ledger.markDeleted(sourceKind, row.source_id);
      continue;
    }
    const fingerprint = relay.sourceFingerprint(sourceKind, local);
    if (fingerprint === row.fingerprint) continue;

    // The state changed. Whether the change may leave is decided by the
    // rules again, not by the fact that it changed: a community that has
    // been made private relays nothing more.
    const kind = UPDATE_KIND[sourceKind];
    if (!kind) continue;
    const input = await relay.updateInput(sourceKind, local);
    if (!input) continue;
    await publishOrWithhold(publish, kind, input);
  }

  const last = rows[rows.length - 1];
  await setFeedCursor('sweep:' + sourceKind, last.published_at + '|' + last.source_id);
}

// One pass of the feed.
async function run(publish) {
  await scanCommunities(publish);
  await scanChannels(publish);
  await scanMessages(publish);
  await scanReactions(publish);
  await sweepSource(publish, 'community');
  await sweepSource(publish, 'channel');
  await sweepSource(publish, 'message');
  await sweepSource(publish, 'reaction');
}

// The rules a community has to pass to be listed in the discovery document.
module.exports = {
  BATCH,
  run,
  feedCursor,
  setFeedCursor,
};

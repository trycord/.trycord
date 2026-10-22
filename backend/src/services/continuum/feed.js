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
//
// Two things bound what the feed does:
//
//   The ledger is the record. A row that is in it has been published, and a
//   second pass over the same row publishes nothing.
//
//   A change is published once it has settled. The feed publishes the state
//   a row is in, not every state it was in, so a message that is edited
//   twice in a moment is one change and not two. Waiting for the words to
//   stop costs one interval; the bound is therefore two intervals, and that
//   is the bound the operator is shown.

const db = require('../../db');
const { now } = require('../../util');
const ledger = require('./ledger');
const relay = require('./relay');
const store = require('./store');

// How many rows one pass looks at per source kind.
const BATCH = 200;

// The row of the feed's own state that says when it last ran.
const STATUS_ROW = 'status';

// How often the feed reconciles the local state against the ledger.
function intervalMs() {
  const value = Number(process.env.CONTINUUM_FEED_INTERVAL_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 2000;
}

// How long a change has to have settled before it is published.
//
// A message that was edited a moment ago may be edited again, and publishing
// it now would publish a state that is not the state it ends in. So the feed
// waits until the words have been still for one interval. The cost is one
// interval of delay on a change; the bound on a change being noticed is
// therefore two intervals.
function quietMs() {
  return intervalMs();
}

async function feedCursor(name) {
  // `cursor` is a reserved word in MySQL and MariaDB, so it is quoted.
  const row = await db.get('SELECT `cursor` FROM continuum_feed_state WHERE name = ?', [name]);
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

// ---- new rows -------------------------------------------------------------

async function scanCommunities(publish) {
  const rows = await db.all(
    'SELECT s.id FROM servers s WHERE s.is_public = 1 '
    + 'AND NOT EXISTS (SELECT 1 FROM continuum_publications p WHERE p.source_kind = ? AND p.source_id = s.id) '
    + 'ORDER BY s.created_at ASC, s.id ASC LIMIT ' + BATCH,
    ['community']
  );
  for (const row of rows) {
    await publish('community.published', { serverId: row.id });
  }
  return rows.length >= BATCH;
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
    await publish('channel.published', {
      serverId: row.server_id,
      channelId: row.id,
    });
  }
  return rows.length >= BATCH;
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
    await publish('message.posted', {
      serverId: row.server_id,
      channelId: row.channel_id,
      messageId: row.id,
    });
  }
  return rows.length >= BATCH;
}

// The ledger keys a reaction by (message, user, emoji), which is a string the
// database has to build. The two engines spell that differently, so the
// expression is chosen by the dialect rather than attempted and caught.
function reactionKeyExpression(alias) {
  if (db.dialect === 'mysql') {
    return `CONCAT(${alias}.message_id, '|', ${alias}.user_id, '|', ${alias}.emoji)`;
  }
  return `${alias}.message_id || '|' || ${alias}.user_id || '|' || ${alias}.emoji`;
}

async function scanReactions(publish) {
  const rows = await db.all(
    'SELECT r.message_id, r.user_id, r.emoji, m.channel_id, c.server_id FROM reactions r '
    + 'JOIN messages m ON m.id = r.message_id '
    + 'JOIN channels c ON c.id = m.channel_id JOIN servers s ON s.id = c.server_id '
    + 'WHERE s.is_public = 1 '
    + 'AND NOT EXISTS (SELECT 1 FROM continuum_publications p WHERE p.source_kind = ? '
    + 'AND p.source_id = ' + reactionKeyExpression('r') + ') '
    + 'ORDER BY r.created_at ASC LIMIT ' + BATCH,
    ['reaction']
  );
  for (const row of rows) {
    await publish('reaction.added', {
      serverId: row.server_id,
      channelId: row.channel_id,
      messageId: row.message_id,
      userId: row.user_id,
      emoji: row.emoji,
    });
  }
  return rows.length >= BATCH;
}

// A message written here for a community that lives on another instance.
//
// It is published as soon as it is written - the writer is waiting for it -
// and this scan is the safety net for one whose publication did not happen:
// the ledger says what was published, and a row the ledger does not know
// about has not been published.
async function scanOutgoing(publish) {
  const rows = await db.all(
    'SELECT o.id FROM continuum_relay_outgoing o '
    + 'WHERE NOT EXISTS (SELECT 1 FROM continuum_publications p WHERE p.source_kind = ? AND p.source_id = o.id) '
    + 'ORDER BY o.created_at ASC, o.id ASC LIMIT ' + BATCH,
    ['outgoing']
  );
  for (const row of rows) {
    const outgoing = await store.findOutgoing(row.id);
    if (!outgoing || outgoing.deleted_at) continue;
    await publish('message.posted', relay.outgoingInput(outgoing));
  }
  return rows.length >= BATCH;
}

// ---- changes and deletions ------------------------------------------------

// The kind an event carries when the row it is about has changed.
const UPDATE_KIND = {
  community: 'community.updated',
  channel: 'channel.updated',
  message: 'message.edited',
  outgoing: 'message.edited',
};

// The kind an event carries when the row it is about is gone. A community
// and a channel have no deletion event in the vocabulary, so their rows are
// only retired in the ledger.
const DELETE_KIND = {
  message: 'message.deleted',
  reaction: 'reaction.removed',
  outgoing: 'message.deleted',
};

// Has the row stopped changing?
//
// A message that was edited a moment ago may be edited again, and the feed
// publishes the state a row is in rather than every state it was in. So a
// row whose last change is more recent than the quiet period waits for the
// next pass.
function settled(row) {
  const quiet = quietMs();
  if (!quiet) return true;
  const editedAt = row && row.edited_at;
  if (!editedAt) return true;
  const at = Date.parse(editedAt);
  if (!Number.isFinite(at)) return true;
  return Date.now() - at >= quiet;
}

// Walk the ledger and look at what it says against what is there now.
async function sweepSource(publish, sourceKind) {
  const after = await feedCursor('sweep:' + sourceKind);
  let rows = await ledger.listForSweep(sourceKind, { after, limit: BATCH });
  if (!rows.length) {
    // The sweep has come to the end of the ledger. It starts again from the
    // beginning, so a change is noticed within a pass or two of it
    // happening rather than never.
    rows = await ledger.listForSweep(sourceKind, { after: '', limit: BATCH });
    if (!rows.length) return 0;
    await setFeedCursor('sweep:' + sourceKind, '');
  }

  let swept = 0;
  for (const row of rows) {
    swept += 1;
    const local = await relay.readSource(sourceKind, row.source_id);
    if (!local) {
      // The row is gone. A deletion is relayed for the things the vocabulary
      // has a deletion for, so the remote copy does not outlive the original.
      const kind = DELETE_KIND[sourceKind];
      if (kind) {
        const input = relay.deletionInput(sourceKind, row.source_id, ledger.contextOf(row));
        if (input) await publish(kind, input);
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
    if (!settled(local)) continue;
    const input = await relay.updateInput(sourceKind, local);
    if (!input) continue;
    await publish(kind, input);
  }

  const last = rows[rows.length - 1];
  await setFeedCursor('sweep:' + sourceKind, last.published_at + '|' + last.source_id);
  return swept;
}

// ---- the feed's own state --------------------------------------------------

function safeParse(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// What the feed last did, and how far behind it is.
//
// The lag is the operator's to see: a change is noticed within one interval
// and published within two, and a feed that is further behind than that is
// not quiet about it.
async function status() {
  const row = await db.get('SELECT `cursor`, updated_at FROM continuum_feed_state WHERE name = ?', [STATUS_ROW]);
  const last = row ? safeParse(row.cursor) : {};
  const interval = intervalMs();
  const bound = interval * 2;
  const lastPassAt = last.at || (row ? row.updated_at : null);
  const parsedAt = lastPassAt ? Date.parse(lastPassAt) : NaN;
  const lagMs = Number.isFinite(parsedAt) ? Math.max(0, Date.now() - parsedAt) : null;
  return {
    interval_ms: interval,
    quiet_ms: quietMs(),
    bound_ms: bound,
    last_pass_at: lastPassAt || null,
    lag_ms: lagMs,
    behind: lagMs === null ? true : lagMs > bound,
    published: Number(last.published || 0),
    withheld: Number(last.withheld || 0),
    duplicates: Number(last.duplicates || 0),
    swept: Number(last.swept || 0),
    truncated: !!last.truncated,
  };
}

async function writeStatus(pass) {
  await setFeedCursor(STATUS_ROW, JSON.stringify({
    at: now(),
    published: pass.published,
    withheld: pass.withheld,
    duplicates: pass.duplicates,
    swept: pass.swept,
    truncated: pass.truncated ? 1 : 0,
  }));
}

// ---- one pass --------------------------------------------------------------

// One pass of the feed.
//
// The counts it keeps are the operator's: what was published, what the rules
// refused, what the ledger already knew about, and whether the pass reached
// the end of what there was to do.
async function run(publish) {
  const counted = { published: 0, withheld: 0, duplicates: 0, swept: 0, truncated: false };
  const record = async (kind, input, opts) => {
    const result = await publish(kind, input, opts);
    if (result && result.ok) counted.published += 1;
    else if (result && result.duplicate) counted.duplicates += 1;
    else if (result && result.withhold) counted.withheld += 1;
    return result;
  };

  const scans = [
    scanCommunities(record), scanChannels(record), scanMessages(record),
    scanReactions(record), scanOutgoing(record),
  ];
  const truncated = await Promise.all(scans);
  for (const wasTruncated of truncated) {
    if (wasTruncated) counted.truncated = true;
  }

  for (const sourceKind of ['community', 'channel', 'message', 'reaction', 'outgoing']) {
    counted.swept += await sweepSource(record, sourceKind);
  }

  await writeStatus(counted);
  return counted;
}

module.exports = {
  run,
  status,
  intervalMs,
  quietMs,
  feedCursor,
  setFeedCursor,
};

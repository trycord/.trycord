// Per-actor sequence numbers.
//
// Two counters live in one table, told apart by their scope:
//
//   'out:<actor id>'                  - the sequence this instance has handed
//                                       out for one local actor. It increases
//                                       with every event that actor causes,
//                                       so a receiver can tell a new event
//                                       from a replayed one.
//   'in:<origin instance>:<actor id>' - the highest sequence this instance
//                                       has accepted from one remote actor.
//                                       It is the replay floor: an event
//                                       whose sequence is not newer than the
//                                       highest already accepted for that
//                                       (origin, actor) is refused as stale.
//
// The outbound counter is allocated inside a transaction, so two events
// published at the same moment cannot be handed the same number.

const db = require('../../db');
const { now } = require('../../util');

function outboundScope(actorId) { return 'out:' + actorId; }
function inboundScope(originInstanceId, actorId) {
  return 'in:' + originInstanceId + ':' + actorId;
}

// The next sequence number for a local actor.
async function nextOutbound(actorId) {
  const scope = outboundScope(actorId);
  return db.transaction(async (t) => {
    const row = await t.get('SELECT last_seq FROM continuum_sequences WHERE scope = ?', [scope]);
    const next = (row ? Number(row.last_seq) : 0) + 1;
    if (row) {
      await t.run(
        'UPDATE continuum_sequences SET last_seq = ?, updated_at = ? WHERE scope = ?',
        [next, now(), scope]
      );
    } else {
      await t.run(
        'INSERT INTO continuum_sequences (scope, last_seq, updated_at) VALUES (?, ?, ?)',
        [scope, next, now()]
      );
    }
    return next;
  });
}

// The highest sequence accepted so far from one remote actor.
async function inboundHighWater(originInstanceId, actorId) {
  const row = await db.get(
    'SELECT last_seq FROM continuum_sequences WHERE scope = ?',
    [inboundScope(originInstanceId, actorId)]
  );
  return row ? Number(row.last_seq) : 0;
}

// Accept an inbound sequence. An event without a sequence carries no order
// information, so there is nothing to check and it is accepted.
//
// An event whose sequence is not newer than the highest already accepted for
// that (origin, actor) is refused: it is either a replay of something that
// has been seen, or an event that has been overtaken by a later one.
async function acceptInbound(originInstanceId, actorId, seq) {
  if (!Number.isFinite(seq)) return { ok: true };
  const scope = inboundScope(originInstanceId, actorId);
  const stamp = now();
  const updated = await db.run(
    'UPDATE continuum_sequences SET last_seq = ?, updated_at = ? WHERE scope = ? AND last_seq < ?',
    [seq, stamp, scope, seq]
  );
  if (updated && updated.changes) return { ok: true };

  const row = await db.get('SELECT last_seq FROM continuum_sequences WHERE scope = ?', [scope]);
  if (row) {
    if (Number(row.last_seq) >= seq) {
      return { ok: false, reason: 'the sequence is not newer than the last one accepted from this actor' };
    }
    await db.run(
      'UPDATE continuum_sequences SET last_seq = ?, updated_at = ? WHERE scope = ?',
      [seq, stamp, scope]
    );
    return { ok: true };
  }
  await db.run(
    'INSERT INTO continuum_sequences (scope, last_seq, updated_at) VALUES (?, ?, ?)',
    [scope, seq, stamp]
  );
  return { ok: true };
}

module.exports = {
  outboundScope,
  inboundScope,
  nextOutbound,
  inboundHighWater,
  acceptInbound,
};

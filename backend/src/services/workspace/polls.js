// Polls: a question put to a channel, a message, or the community.
//
// A poll has a question, its options, a window (opens and closes), an
// anonymity mode, whether more than one choice is allowed, who is eligible to
// vote, and optionally a quorum.
//
// Voting is idempotent: a member has one ballot per poll, and casting a
// ballot replaces the previous one. A repeated request therefore counts once,
// and changing your mind counts once as well.
//
// Scoring is either
//
//   plurality - one choice per voter, or several when the poll allows it,
//               and the option with the most votes wins
//   ranked    - an ordered ballot, scored by position (a Borda count)
//
// The tie-break for a ranked poll, in order: the higher Borda score wins; then
// the option with the most first preferences; then the one with the most
// second preferences, and so on down the ballot; then the option that comes
// first in the poll. Every step of that is deterministic, so the same
// ballots always produce the same winner.
//
// The result as it stood when the poll closed is kept. A later recount
// computes a fresh tally and leaves that record alone.
const db = require('../../db');
const { now, uuid } = require('../../util');
const { fail, required, optionalInstant, positiveInt, oneOf } = require('./common');
const roles = require('../roles');
const permissions = require('../permissions');

const SCORINGS = ['plurality', 'ranked'];
const ELIGIBILITIES = ['members', 'role'];
const MAX_OPTIONS = 20;
const MIN_OPTIONS = 2;

function shapePoll(row) {
  return {
    id: row.id,
    serverId: row.server_id,
    channelId: row.channel_id || null,
    messageId: row.message_id || null,
    question: row.question,
    scoring: row.scoring,
    allowsMultiple: !!row.allows_multiple,
    maxChoices: Number(row.max_choices || 1),
    isAnonymous: !!row.is_anonymous,
    eligibility: row.eligibility,
    requiredRoleId: row.required_role_id || null,
    quorum: row.quorum === null || row.quorum === undefined ? null : Number(row.quorum),
    opensAt: row.opens_at || null,
    closesAt: row.closes_at || null,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    closedAt: row.closed_at || null,
    // Whether anybody has answered it. A poll with answers cannot be edited:
    // the ballots were given for the options as they stand. The client uses
    // this to avoid offering an edit the server would refuse.
    hasAnswers: Number(row.answer_count || 0) > 0,
  };
}

function shapeOption(row) {
  return { id: row.id, pollId: row.poll_id, position: Number(row.position || 0), label: row.label };
}

// The count of the answers a poll has, so the shape can say whether it may
// still be edited.
//
// A poll with answers cannot be edited: the ballots were given for the
// options as they stand. The count is carried in the query rather than
// asked for separately, because a list of polls would otherwise be one
// query per poll.
const ANSWER_COUNT = '(SELECT COUNT(*) FROM poll_votes WHERE poll_id = p.id)'
  + ' + (SELECT COUNT(*) FROM poll_ballots WHERE poll_id = p.id)';

async function pollOf(serverId, pollId) {
  const row = await db.get(
    'SELECT p.*, ' + ANSWER_COUNT + ' AS answer_count FROM polls p WHERE p.id = ? AND p.server_id = ?',
    [pollId, serverId],
  );
  if (!row) fail('NOT_FOUND', 'poll not found');
  return row;
}

async function options(pollId) {
  const rows = await db.all('SELECT * FROM poll_options WHERE poll_id = ? ORDER BY position ASC, id ASC', [pollId]);
  return rows.map(shapeOption);
}

async function get(serverId, pollId) {
  const row = await pollOf(serverId, pollId);
  return Object.assign(shapePoll(row), { options: await options(row.id) });
}

async function list(serverId) {
  const rows = await db.all(
    'SELECT p.*, ' + ANSWER_COUNT + ' AS answer_count FROM polls p'
    + ' WHERE p.server_id = ? ORDER BY p.created_at DESC, p.id DESC',
    [serverId],
  );
  return rows.map(shapePoll);
}

async function create(serverId, actorId, input) {
  const question = required(input.question, 500, 'question');
  const rawOptions = Array.isArray(input.options) ? input.options : [];
  if (rawOptions.length < MIN_OPTIONS) fail('VALIDATION_ERROR', `a poll needs at least ${MIN_OPTIONS} options`);
  if (rawOptions.length > MAX_OPTIONS) fail('VALIDATION_ERROR', `a poll may have at most ${MAX_OPTIONS} options`);
  const labels = rawOptions.map((o) => required(o, 255, 'option'));
  const scoring = oneOf(input.scoring, SCORINGS, 'scoring', 'plurality');
  const allowsMultiple = input.allowsMultiple === true;
  let maxChoices = 1;
  if (allowsMultiple) {
    maxChoices = positiveInt(input.maxChoices, 'maxChoices') || labels.length;
    if (maxChoices > labels.length) fail('VALIDATION_ERROR', 'maxChoices cannot be larger than the number of options');
  }
  const eligibility = oneOf(input.eligibility, ELIGIBILITIES, 'eligibility', 'members');
  let requiredRoleId = null;
  if (eligibility === 'role') {
    requiredRoleId = String(input.requiredRoleId || '').trim();
    if (!requiredRoleId) fail('VALIDATION_ERROR', 'a poll restricted to a role needs that role');
    const role = await db.get('SELECT id FROM roles WHERE id = ? AND server_id = ?', [requiredRoleId, serverId]);
    if (!role) fail('VALIDATION_ERROR', 'that role is not in this community');
  }
  const quorum = positiveInt(input.quorum, 'quorum');
  const opensAt = optionalInstant(input.opensAt, 'opensAt');
  const closesAt = optionalInstant(input.closesAt, 'closesAt');
  if (opensAt && closesAt && new Date(closesAt) <= new Date(opensAt)) {
    fail('VALIDATION_ERROR', 'the poll closes before it opens');
  }
  if (input.channelId) {
    const channel = await db.get('SELECT id FROM channels WHERE id = ? AND server_id = ?', [input.channelId, serverId]);
    if (!channel) fail('NOT_FOUND', 'channel not found in this community');
  }
  if (input.messageId) {
    const message = await db.get('SELECT * FROM messages WHERE id = ?', [input.messageId]);
    if (!message) fail('NOT_FOUND', 'message not found');
    const channel = await db.get('SELECT id FROM channels WHERE id = ? AND server_id = ?', [message.channel_id, serverId]);
    if (!channel) fail('NOT_FOUND', 'message not found in this community');
  }
  const id = uuid();
  const ts = now();
  await db.transaction(async (t) => {
    await t.run(
      'INSERT INTO polls (id, server_id, channel_id, message_id, question, scoring, allows_multiple, max_choices,'
      + ' is_anonymous, eligibility, required_role_id, quorum, opens_at, closes_at, status, created_by, created_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, serverId, input.channelId || null, input.messageId || null, question, scoring,
        allowsMultiple ? 1 : 0, maxChoices, input.isAnonymous === true ? 1 : 0, eligibility, requiredRoleId,
        quorum, opensAt, closesAt, 'open', actorId, ts]
    );
    let pos = 0;
    for (const label of labels) {
      await t.run(
        'INSERT INTO poll_options (id, poll_id, position, label) VALUES (?, ?, ?, ?)',
        [uuid(), id, pos++, label]
      );
    }
  });
  return get(serverId, id);
}

// Whether anybody has answered the poll yet.
//
// A poll that has answers is a record: the ballots were given for the options
// as they stood, and an option that is renamed or taken away leaves a ballot
// that means nothing. So a poll with answers is not edited at all.
async function hasAnswers(pollId) {
  const votes = await db.get('SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id = ?', [pollId]);
  const ballots = await db.get('SELECT COUNT(*) AS n FROM poll_ballots WHERE poll_id = ?', [pollId]);
  return Number(votes && votes.n ? votes.n : 0) > 0
    || Number(ballots && ballots.n ? ballots.n : 0) > 0;
}

// Edit a poll.
//
// A poll that has closed is not edited: its result has been written down, and
// the question it asked is part of that record. Neither is a poll that has
// answers, for the reason hasAnswers() gives.
//
// What can be edited, then, is a poll nobody has answered: its question, its
// options, how the answers are counted, whether more than one answer may be
// given, and whether it names its voters.
//
// The fields the body does not carry are left as they are. This is a partial
// change, not a replacement: a body with only a question changes the question
// and nothing else.
//
// Who may edit it is the author's job and a moderator's, the same rule the
// close uses. The rule belongs here rather than only in the route, because a
// service that can be called from anywhere has to carry it itself: the route
// is one caller and the next one would not be.
async function update(serverId, pollId, actorId, input) {
  const poll = await pollOf(serverId, pollId);
  if (poll.status === 'closed') {
    fail('CONFLICT', 'a closed poll cannot be edited: its result is on record');
  }
  if (await hasAnswers(poll.id)) {
    fail('CONFLICT', 'a poll that has answers cannot be edited: the ballots were given for the options as they stand');
  }

  const question = input.question === undefined || input.question === null
    ? poll.question
    : required(input.question, 500, 'question');

  // The options, when the body carries them. The same rules the create route
  // enforces: at least two, at most twenty, each one a line of text.
  let labels = null;
  if (input.options !== undefined && input.options !== null) {
    const raw = Array.isArray(input.options) ? input.options : [];
    if (raw.length < MIN_OPTIONS) fail('VALIDATION_ERROR', `a poll needs at least ${MIN_OPTIONS} options`);
    if (raw.length > MAX_OPTIONS) fail('VALIDATION_ERROR', `a poll may have at most ${MAX_OPTIONS} options`);
    labels = raw.map((o) => required(o, 255, 'option'));
  }

  const scoring = input.scoring === undefined || input.scoring === null || input.scoring === ''
    ? poll.scoring
    : oneOf(input.scoring, SCORINGS, 'scoring', 'plurality');

  const allowsMultiple = booleanField(input.allowsMultiple, poll.allows_multiple, 'allowsMultiple');
  const isAnonymous = booleanField(input.isAnonymous, poll.is_anonymous, 'isAnonymous');

  // The author, or somebody who manages the content of this community. The
  // owner is the author of everything they made, so they are included.
  const author = String(poll.createdBy || '') === String(actorId || '');
  const owner = await db.get('SELECT owner_id FROM servers WHERE id = ?', [serverId]);
  const isOwner = !!(owner && String(owner.owner_id) === String(actorId || ''));
  const moderates = author || isOwner
    || await permissions.hasPermission(actorId, serverId, 'MANAGE_MESSAGES');
  if (!moderates) {
    fail('PERMISSION_DENIED', 'only the author or a moderator can edit this poll');
  }

  const optionCount = labels ? labels.length : await optionTotal(poll.id);
  let maxChoices = 1;
  if (allowsMultiple) {
    maxChoices = positiveInt(input.maxChoices, 'maxChoices') || optionCount;
    if (maxChoices > optionCount) fail('VALIDATION_ERROR', 'maxChoices cannot be larger than the number of options');
  }

  await db.transaction(async (t) => {
    await t.run(
      'UPDATE polls SET question = ?, scoring = ?, allows_multiple = ?, max_choices = ?, is_anonymous = ?'
      + ' WHERE id = ?',
      [question, scoring, allowsMultiple ? 1 : 0, maxChoices, isAnonymous ? 1 : 0, poll.id]
    );
    if (!labels) return;
    // The options are replaced, not merged: a poll nobody has answered has
    // nothing that refers to an option, so the old ones can go. The ids are
    // new, and a client reads them again after the change.
    await t.run('DELETE FROM poll_options WHERE poll_id = ?', [poll.id]);
    let pos = 0;
    for (const label of labels) {
      await t.run(
        'INSERT INTO poll_options (id, poll_id, position, label) VALUES (?, ?, ?, ?)',
        [uuid(), poll.id, pos++, label]
      );
    }
  });
  return get(serverId, poll.id);
}

// A flag, when the body carries it, and the one the poll has when it does not.
//
// A flag is a yes or a no, so a body that carries anything else is refused
// rather than guessed at: "true" and 1 are not flags, and treating them as
// flags would let a body mean two things at once.
function booleanField(value, current, field) {
  if (value === undefined || value === null) return !!current;
  if (typeof value !== 'boolean') fail('VALIDATION_ERROR', `${field} must be true or false`);
  return value;
}

// How many options a poll has.
async function optionTotal(pollId) {
  const row = await db.get('SELECT COUNT(*) AS n FROM poll_options WHERE poll_id = ?', [pollId]);
  return Number(row && row.n ? row.n : 0);
}

// Whether the poll is open for voting right now.
function isOpen(poll) {
  if (poll.status !== 'open') return false;
  const at = Date.now();
  if (poll.opens_at && new Date(poll.opens_at).getTime() > at) return false;
  if (poll.closes_at && new Date(poll.closes_at).getTime() < at) return false;
  return true;
}

// Who is allowed to vote. A poll restricted to a role is restricted to the
// members holding that role; the owner of the community is never locked out
// of their own community.
async function isEligible(poll, serverId, userId) {
  if (poll.eligibility !== 'role') return true;
  const owner = await db.get('SELECT owner_id FROM servers WHERE id = ?', [serverId]);
  if (owner && String(owner.owner_id) === String(userId)) return true;
  return roles.userHasRole(serverId, userId, poll.required_role_id);
}

// Cast a ballot.
//
// The member's previous ballot is removed and the new one written in the same
// transaction, so a vote is never counted twice and a repeated request lands
// on the same tally as the first one.
async function vote(serverId, pollId, actorId, { choices }) {
  const poll = await pollOf(serverId, pollId);
  if (!isOpen(poll)) fail('CONFLICT', 'this poll is not open');
  if (!(await isEligible(poll, serverId, actorId))) {
    fail('PERMISSION_DENIED', 'you are not eligible to vote in this poll');
  }
  if (!Array.isArray(choices) || !choices.length) fail('VALIDATION_ERROR', 'a vote needs at least one choice');
  const optionRows = await options(poll.id);
  const byId = new Map(optionRows.map((o) => [String(o.id), o]));
  const picked = choices.map((c) => String(c));
  for (const id of picked) {
    if (!byId.has(id)) fail('VALIDATION_ERROR', 'that is not an option of this poll');
  }
  if (new Set(picked).size !== picked.length) fail('VALIDATION_ERROR', 'the same option cannot be chosen twice');
  if (poll.scoring === 'ranked') {
    if (picked.length > optionRows.length) fail('VALIDATION_ERROR', 'a ballot cannot rank more options than there are');
  } else if (!poll.allows_multiple) {
    if (picked.length !== 1) fail('VALIDATION_ERROR', 'this poll takes a single choice');
  } else if (picked.length > Number(poll.max_choices || 1)) {
    fail('VALIDATION_ERROR', `this poll takes at most ${poll.max_choices} choices`);
  }
  const ts = now();
  await db.transaction(async (t) => {
    await t.run('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?', [poll.id, actorId]);
    await t.run('DELETE FROM poll_ballots WHERE poll_id = ? AND user_id = ?', [poll.id, actorId]);
    if (poll.scoring === 'ranked') {
      let rank = 1;
      for (const optionId of picked) {
        await t.run(
          'INSERT INTO poll_ballots (id, poll_id, option_id, user_id, `rank`, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [uuid(), poll.id, optionId, actorId, rank++, ts]
        );
      }
    } else {
      for (const optionId of picked) {
        await t.run(
          'INSERT INTO poll_votes (id, poll_id, option_id, user_id, created_at) VALUES (?, ?, ?, ?, ?)',
          [uuid(), poll.id, optionId, actorId, ts]
        );
      }
    }
  });
  return get(serverId, poll.id);
}

// The tally.
//
// Plurality counts the choices. Ranked scores each ballot by position: the
// first choice of a ballot is worth the number of options, the second one
// fewer, and the last one a point. A ballot that does not rank an option
// scores nothing for it.
async function tally(poll, optionRows) {
  const votes = await db.all('SELECT * FROM poll_votes WHERE poll_id = ?', [poll.id]);
  const ballots = await db.all('SELECT * FROM poll_ballots WHERE poll_id = ?', [poll.id]);
  const byId = new Map(optionRows.map((o) => [String(o.id), o]));
  const scored = optionRows.map((o) => ({
    id: o.id,
    label: o.label,
    position: o.position,
    votes: 0,
    score: 0,
  }));
  const index = new Map(scored.map((s) => [String(s.id), s]));

  if (poll.scoring === 'ranked') {
    const total = optionRows.length;
    // How often each option was ranked at each position. The tie-break reads
    // this list from the first position down.
    const atPosition = new Map(scored.map((s) => [String(s.id), new Array(total).fill(0)]));
    for (const ballot of ballots) {
      const option = index.get(String(ballot.option_id));
      if (!option) continue;
      option.score += total - Number(ballot.rank) + 1;
      const positions = atPosition.get(String(ballot.option_id));
      positions[Number(ballot.rank) - 1] += 1;
    }
    const sorted = [...scored].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const pa = atPosition.get(String(a.id));
      const pb = atPosition.get(String(b.id));
      for (let i = 0; i < pa.length; i++) {
        if (pb[i] !== pa[i]) return pb[i] - pa[i];
      }
      return a.position - b.position;
    });
    sorted.forEach((option, i) => { option.rank = i + 1; });
    // One ballot per voter, however many options it ranks.
    const votersCount = new Set(ballots.map((b) => String(b.user_id))).size;
    return { options: sorted, ballots: votersCount, votes: votersCount };
  }

  for (const vote of votes) {
    const option = index.get(String(vote.option_id));
    if (!option) continue;
    option.votes += 1;
  }
  const sorted = [...scored].sort((a, b) => (b.votes - a.votes) || (a.position - b.position));
  sorted.forEach((option, i) => { option.rank = i + 1; });
  const ballotsCount = new Set(votes.map((v) => String(v.user_id))).size;
  return { options: sorted, ballots: ballotsCount, votes: votes.length };
}

// Who voted, and what they chose.
//
// An anonymous poll never answers this. The number of ballots is public; the
// names behind them are not, before the close or after it.
async function voters(poll, includeChoices) {
  const rows = poll.scoring === 'ranked'
    ? await db.all(
      'SELECT b.user_id, b.option_id, b.`rank` FROM poll_ballots b WHERE b.poll_id = ? ORDER BY b.user_id, b.`rank`',
      [poll.id]
    )
    : await db.all(
      'SELECT v.user_id, v.option_id FROM poll_votes v WHERE v.poll_id = ? ORDER BY v.user_id, v.created_at',
      [poll.id]
    );
  const byUser = new Map();
  for (const row of rows) {
    const userId = String(row.user_id);
    if (!byUser.has(userId)) byUser.set(userId, []);
    byUser.get(userId).push(String(row.option_id));
  }
  if (!byUser.size) return [];
  const ids = [...byUser.keys()];
  const people = await db.all(
    'SELECT id, username, display_name FROM users WHERE id IN (' + ids.map(() => '?').join(', ') + ')',
    ids
  );
  const names = new Map(people.map((p) => [String(p.id), p]));
  const out = [];
  for (const [userId, choices] of byUser) {
    const person = names.get(userId);
    const entry = { userId, username: person ? person.username : null, displayName: person ? person.display_name : null };
    if (includeChoices) entry.choices = choices;
    out.push(entry);
  }
  return out;
}

// The result of a poll, and the record of the result it had when it closed.
async function results(serverId, pollId, { canSeeIntermediate, recount }) {
  const poll = await pollOf(serverId, pollId);
  const optionRows = await options(poll.id);
  const snapshotRow = await db.get(
    'SELECT * FROM poll_results WHERE poll_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1',
    [poll.id]
  );
  const snapshot = snapshotRow ? JSON.parse(snapshotRow.payload) : null;
  if (poll.status === 'closed') {
    const out = {
      pollId: poll.id,
      question: poll.question,
      status: poll.status,
      scoring: poll.scoring,
      closed: true,
      results: snapshot,
      snapshot,
      recount: recount ? await liveResult(poll, optionRows) : null,
    };
    return out;
  }
  if (!canSeeIntermediate) {
    fail('PERMISSION_DENIED', 'the results of this poll are not visible until it closes');
  }
  return {
    pollId: poll.id,
    question: poll.question,
    status: poll.status,
    scoring: poll.scoring,
    closed: false,
    results: await liveResult(poll, optionRows),
    snapshot: null,
    recount: null,
  };
}

// The tally as it stands now.
//
// The voters are named only when the poll is not anonymous and the reader is
// allowed to see them.
async function liveResult(poll, optionRows) {
  const counted = await tally(poll, optionRows);
  const leader = counted.options[0] || null;
  const hasBallots = counted.ballots > 0;
  let winner = null;
  let tied = [];
  if (leader && hasBallots) {
    if (poll.scoring === 'ranked') {
      // The rank order already applied the whole tie-break, which is total:
      // two options that share every step are separated by the order they
      // were given in. So a ranked poll always has exactly one winner, and
      // the scores beside it show the tie it was broken out of.
      winner = leader.id;
      tied = [];
    } else {
      // A plurality poll can end level. There is no honest way to pick one of
      // two options that received the same number of votes, so the tie is
      // reported as a tie.
      tied = counted.options.filter((o) => o.votes === leader.votes).map((o) => o.id);
      winner = tied.length === 1 ? tied[0] : null;
    }
  }
  const showVoters = !poll.is_anonymous;
  return {
    options: counted.options.map((o) => ({
      id: o.id,
      label: o.label,
      votes: o.votes,
      score: o.score,
      rank: o.rank,
    })),
    ballots: counted.ballots,
    votes: counted.votes,
    winner,
    tied,
    quorum: {
      required: poll.quorum === null || poll.quorum === undefined ? null : Number(poll.quorum),
      votes: counted.ballots,
      met: poll.quorum === null || poll.quorum === undefined
        ? null
        : counted.ballots >= Number(poll.quorum),
    },
    voters: showVoters ? await voters(poll, true) : [],
  };
}

// Close a poll.
//
// The result is computed once, written down, and the poll stops accepting
// votes. The record is append-only: a recount afterwards produces a fresh
// tally and leaves it alone.
async function close(serverId, pollId, actorId) {
  const poll = await pollOf(serverId, pollId);
  if (poll.status === 'closed') {
    const existing = await db.get(
      'SELECT * FROM poll_results WHERE poll_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1',
      [poll.id]
    );
    if (existing) return { pollId: poll.id, closed: true, results: JSON.parse(existing.payload) };
  }
  const optionRows = await options(poll.id);
  const result = await liveResult(poll, optionRows);
  const ts = now();
  await db.transaction(async (t) => {
    await t.run(
      'INSERT INTO poll_results (id, poll_id, server_id, scoring, payload, recorded_at, recorded_by)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuid(), poll.id, serverId, poll.scoring, JSON.stringify(result), ts, actorId]
    );
    await t.run("UPDATE polls SET status = 'closed', closed_at = ? WHERE id = ?", [ts, poll.id]);
  });
  return { pollId: poll.id, closed: true, results: result };
}

module.exports = {
  SCORINGS, ELIGIBILITIES,
  list, get, create, update, vote, results, close,
};

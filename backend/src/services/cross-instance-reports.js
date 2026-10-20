// A report about activity on another instance.
//
// The report crosses, and it crosses carrying as little as it has to. What
// goes with it is:
//
//   - the identity of the instance it comes from
//   - the identifier of the community, the channel and the content
//   - the reason for the report
//   - the identifier of the reporter's account on the instance it comes from
//
// What does not go with it is the content, and anything personal about the
// reporter: no name, no address, no profile, no message text.
//
// The receiving instance receives it as a report about a reference. It may
// or may not be able to act on it, and it says which: a report about
// something this instance has never seen is still a report, but there is
// nothing here to act on.
//
// The privacy decision is not made here. A report about a private community
// or a restricted channel is refused exactly the way the relay refuses to
// federate that community or channel, because the relay rules are asked
// rather than a second set of rules written.

const db = require('../db');
const { now, uuid } = require('../clock');
const rules = require('./continuum/rules');
const identity = require('./continuum/identity');

const REASON_MAX = 255;
const DESCRIPTION_MAX = 2000;
const CONTENT_TYPES = ['message', 'user', 'attachment', 'channel', 'community'];
const DELIVERY_TIMEOUT_MS = 10000;

// What a report carries, and what it does not.
//
// The reporter is told this, so they know what crossed before they send it.
const SHARED = [
  'the identity of the instance the report comes from',
  'the identifier of the community and the channel the content is in',
  'the identifier of the reported content',
  'the reason for the report',
  'the identifier of your account on the instance the report comes from',
];

const NOT_SHARED = [
  'the content itself',
  'your name, your email address, your profile, or anything else about you',
];

function bad(message, code) {
  const e = new Error(message);
  e.code = code || 'VALIDATION_ERROR';
  throw e;
}

function notFound() {
  const e = new Error('no such report');
  e.code = 'NOT_FOUND';
  throw e;
}

function disclosure() {
  return { shared: SHARED.slice(), notShared: NOT_SHARED.slice() };
}

// The payload that crosses. A reference and a reason, and nothing else.
//
// This is the whole of what a report carries, so it is written out here
// rather than assembled from the row: a field that is not in this function
// does not cross.
function buildPayload(report) {
  return {
    origin_instance_id: String(report.originInstanceId || ''),
    origin_community_id: String(report.communityId || ''),
    origin_channel_id: String(report.channelId || ''),
    content_id: String(report.contentId || ''),
    content_type: String(report.contentType || ''),
    reason: String(report.reason || ''),
    reporter_origin_id: String(report.reporterOriginId || ''),
  };
}

// Check a payload that arrived from another instance.
function checkPayload(payload) {
  if (!payload || typeof payload !== 'object') return 'the report has no payload';
  if (!payload.origin_instance_id) return 'the report does not say where it comes from';
  if (!payload.content_id) return 'the report does not say what it is about';
  if (!payload.reason) return 'the report does not give a reason';
  if (!CONTENT_TYPES.includes(String(payload.content_type || ''))) {
    return 'the report is about something this build does not recognise';
  }
  return null;
}

/**
 * File a report about something on another instance.
 *
 * @param {object} options
 * @param {string} options.reporterId      the reporter here
 * @param {string} options.targetInstanceId the instance it is addressed to
 * @param {string} options.communityId     the community the content is in
 * @param {string} options.channelId       the channel the content is in
 * @param {string} options.contentId       the content's identifier there
 * @param {string} options.contentType
 * @param {string} options.reason
 * @param {string} [options.description]
 */
async function create(options) {
  const opts = options || {};
  const reporterId = opts.reporterId;
  const targetInstanceId = String(opts.targetInstanceId || '').trim();
  const communityId = String(opts.communityId || '').trim();
  const channelId = String(opts.channelId || '').trim();
  const contentId = String(opts.contentId || '').trim();
  const contentType = String(opts.contentType || 'message').trim().toLowerCase();
  const reason = String(opts.reason || '').trim().slice(0, REASON_MAX);
  const description = String(opts.description || '').trim().slice(0, DESCRIPTION_MAX);

  if (!targetInstanceId) bad('a report has to be addressed to an instance');
  if (!communityId || !channelId) bad('a report has to name the community and the channel');
  if (!contentId) bad('a report has to name the content');
  if (!reason) bad('a report has to give a reason');
  if (!CONTENT_TYPES.includes(contentType)) {
    bad('contentType must be one of: ' + CONTENT_TYPES.join(', '));
  }

  // The relay's own rules, asked the same questions. A private community
  // and a channel the community's members cannot post in are not federated,
  // and a report about them is refused for the same reason - not because a
  // second set of rules says so, but because these are the rules.
  const gate = await rules.mayFederateMessage({
    serverId: communityId,
    channelId,
    authorId: reporterId,
  });
  if (!gate.ok) {
    bad('this report cannot cross: ' + gate.reason, 'PERMISSION_DENIED');
  }

  // The instance it is addressed to has to be one this instance federates
  // with. A report that could never be delivered is not worth recording.
  const target = await db.get(
    'SELECT id, origin, trust_status FROM continuum_instances WHERE id = ?',
    [targetInstanceId]
  );
  if (!target) bad('that instance is not one this instance federates with', 'NOT_FOUND');
  if (target.trust_status !== 'trusted') {
    bad('that instance is not trusted here', 'PERMISSION_DENIED');
  }

  const originInstanceId = identity.getInstanceId() || String(process.env.TRYCORD_INSTANCE_ID || 'local');
  const id = uuid();
  const ts = now();

  const report = {
    id,
    originInstanceId,
    targetInstanceId,
    targetInstanceOrigin: target.origin,
    communityId,
    channelId,
    contentId,
    contentType,
    reason,
    reporterOriginId: reporterId,
  };
  const payload = buildPayload(report);

  await db.run(
    'INSERT INTO cross_instance_reports (id, direction, origin_instance_id, target_instance_id,'
    + ' target_instance_origin, community_id, channel_id, content_id, content_type, reason,'
    + ' description, reporter_id, reporter_origin_id, status, actionable, disclosure,'
    + ' created_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id, 'outbound', originInstanceId, targetInstanceId, target.origin,
      communityId, channelId, contentId, contentType, reason, description || null,
      reporterId, reporterId, 'FILED', 0, JSON.stringify(disclosure()), ts,
    ]
  );

  const delivery = await deliver(id);
  return {
    id,
    status: delivery.delivered ? 'DELIVERED' : 'FILED',
    payload,
    disclosure: disclosure(),
    delivery: { delivered: delivery.delivered, reason: delivery.reason || null },
  };
}

// Send a filed report to the instance it is addressed to.
//
// The signature is what makes the receiving side able to trust it, and it is
// the same key the rest of the federation uses. The address is checked
// against the same rules the federation uses, so a peer cannot be used to
// reach into the host's own network.
async function deliver(reportId) {
  const report = await db.get(
    'SELECT id, origin_instance_id, target_instance_id, target_instance_origin, community_id,'
    + ' channel_id, content_id, content_type, reason, reporter_origin_id'
    + ' FROM cross_instance_reports WHERE id = ? AND direction = ?',
    [reportId, 'outbound']
  );
  if (!report) return { delivered: false, reason: 'no such report' };

  const continuum = require('./continuum');
  if (!continuum.enabled()) {
    const reason = 'federation is disabled on this instance';
    await db.run(
      'UPDATE cross_instance_reports SET status = ?, delivery_error = ? WHERE id = ?',
      ['PENDING', reason, reportId]
    );
    return { delivered: false, reason };
  }

  let origin;
  try {
    origin = continuum.validateOrigin(report.target_instance_origin);
  } catch (e) {
    const reason = (e && e.message) || 'the instance address is not usable';
    await db.run(
      'UPDATE cross_instance_reports SET status = ?, delivery_error = ? WHERE id = ?',
      ['FAILED', reason, reportId]
    );
    return { delivered: false, reason };
  }

  const envelope = {
    id: uuid(),
    kind: 'report.filed',
    actor: null,
    target: report.content_id,
    timestamp: now(),
    payload: buildPayload(report),
    key_id: report.origin_instance_id,
  };
  envelope.signature = continuum.signEvent(envelope);

  let body;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const response = await fetch(origin + '/api/federation-reports/inbound', {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(envelope),
    });
    body = await response.json();
    if (!response.ok) {
      const reason = (body && body.error && body.error.message) || ('answered HTTP ' + response.status);
      await db.run(
        'UPDATE cross_instance_reports SET status = ?, delivery_error = ?, envelope_id = ? WHERE id = ?',
        ['FAILED', reason, envelope.id, reportId]
      );
      return { delivered: false, reason };
    }
  } catch (e) {
    const reason = (e && e.message) || 'the instance could not be reached';
    await db.run(
      'UPDATE cross_instance_reports SET status = ?, delivery_error = ?, envelope_id = ? WHERE id = ?',
      ['FAILED', reason, envelope.id, reportId]
    );
    return { delivered: false, reason };
  } finally {
    clearTimeout(timer);
  }

  await db.run(
    'UPDATE cross_instance_reports SET status = ?, delivery_error = NULL, envelope_id = ? WHERE id = ?',
    ['DELIVERED', envelope.id, reportId]
  );
  return { delivered: true, receipt: body && body.receipt ? body.receipt : null };
}

/**
 * Receive a report from another instance.
 *
 * The signature is the credential: the sender has to be an instance this one
 * knows and trusts, and the signature has to verify against the key recorded
 * for it. What arrives is a reference, and it is stored as one.
 */
async function receive(envelope) {
  if (!envelope || !envelope.key_id || !envelope.id || !envelope.kind) {
    return { accepted: false, reason: 'the report is not a valid envelope' };
  }
  if (envelope.kind !== 'report.filed') {
    return { accepted: false, reason: 'that is not a report' };
  }

  const continuum = require('./continuum');
  if (!continuum.enabled()) {
    return { accepted: false, reason: 'federation is disabled on this instance' };
  }
  const sender = await db.get(
    'SELECT id, origin, public_key, trust_status FROM continuum_instances WHERE id = ?',
    [envelope.key_id]
  );
  if (!sender) return { accepted: false, reason: 'the sending instance is not known here' };
  if (sender.trust_status !== 'trusted') {
    return { accepted: false, reason: 'the sending instance is not trusted' };
  }
  if (!continuum.verifyEvent(envelope, sender.public_key)) {
    return { accepted: false, reason: 'the signature does not verify' };
  }

  const problem = checkPayload(envelope.payload);
  if (problem) return { accepted: false, reason: problem };

  const seen = await db.get(
    'SELECT id FROM cross_instance_reports WHERE direction = ? AND envelope_id = ?',
    ['inbound', envelope.id]
  );
  if (seen) return { accepted: true, duplicate: true, id: seen.id };

  const payload = envelope.payload;
  const id = uuid();
  const ts = now();

  // Whether this instance can act on it: it can when it holds the content
  // the report is about. A report about something it has never seen is
  // still a report, and it is still worth keeping.
  const held = await db.get(
    'SELECT id FROM continuum_relay_messages WHERE origin_instance_id = ? AND origin_message_id = ?',
    [payload.origin_instance_id, payload.content_id]
  );
  const actionable = held ? 1 : 0;

  await db.run(
    'INSERT INTO cross_instance_reports (id, direction, origin_instance_id, target_instance_id,'
    + ' community_id, channel_id, content_id, content_type, reason, reporter_origin_id,'
    + ' status, actionable, disclosure, envelope_id, created_at, received_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id, 'inbound', payload.origin_instance_id, identity.getInstanceId() || 'local',
      payload.origin_community_id || null, payload.origin_channel_id || null,
      payload.content_id, payload.content_type, payload.reason, payload.reporter_origin_id || null,
      'RECEIVED', actionable, JSON.stringify(disclosure()), envelope.id, ts, ts,
    ]
  );

  return { accepted: true, id, actionable: !!actionable };
}

// The reports this reader filed.
async function listOutbound(reporterId) {
  return db.all(
    'SELECT id, target_instance_id AS targetInstanceId, community_id AS communityId,'
    + ' channel_id AS channelId, content_id AS contentId, content_type AS contentType,'
    + ' reason, status, actionable, created_at AS createdAt FROM cross_instance_reports'
    + ' WHERE direction = ? AND reporter_id = ? ORDER BY created_at DESC, id DESC',
    ['outbound', reporterId]
  );
}

// The reports that arrived here, for the moderation queue.
async function listInbound(options) {
  const opts = options || {};
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  return db.all(
    'SELECT id, origin_instance_id AS originInstanceId, community_id AS communityId,'
    + ' channel_id AS channelId, content_id AS contentId, content_type AS contentType,'
    + ' reason, reporter_origin_id AS reporterOriginId, status, actionable,'
    + ' received_at AS receivedAt FROM cross_instance_reports'
    + ' WHERE direction = ? ORDER BY received_at DESC, id DESC LIMIT ' + limit,
    ['inbound']
  );
}

// One report, by id.
//
// The reporter is a filter, not a hint: a report is the reporter's own, and
// an id that belongs to somebody else is not found rather than forbidden -
// the answer must not say that the id exists. The filter applies to the
// outbound direction only, because the inbound direction has no reporter
// here: those reports are the moderation queue's business.
async function get(id, options = {}) {
  const reporterId = options.reporterId ? String(options.reporterId) : null;
  const row = await db.get(
    'SELECT id, direction, origin_instance_id AS originInstanceId,'
    + ' target_instance_id AS targetInstanceId, community_id AS communityId,'
    + ' channel_id AS channelId, content_id AS contentId, content_type AS contentType,'
    + ' reason, status, actionable, disclosure, delivery_error AS deliveryError,'
    + ' created_at AS createdAt, received_at AS receivedAt FROM cross_instance_reports'
    + ' WHERE id = ?' + (reporterId ? ' AND direction = ? AND reporter_id = ?' : ''),
    reporterId ? [id, 'outbound', reporterId] : [id]
  );
  if (!row) notFound();
  try { row.disclosure = JSON.parse(row.disclosure); } catch { row.disclosure = null; }
  return row;
}

module.exports = {
  SHARED, NOT_SHARED,
  buildPayload, disclosure,
  create, deliver, receive, listOutbound, listInbound, get,
};

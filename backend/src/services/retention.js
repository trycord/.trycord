// What this instance keeps, and what it lets go of.
//
// Every row here is something the instance wrote to remember something. Left
// alone they grow forever: expired sessions, revoked tokens nobody will ever
// present again, notifications from months ago, job rows for work that
// finished long ago, and the recovery links that expired.
//
// The periods are instance settings, so an operator who wants to keep a year of
// notifications says so. The defaults are the ones a community instance
// actually wants: sessions and tokens go when they expire, notifications are
// kept a couple of months, and the job history is kept long enough to look at
// what happened.
//
// Nothing here deletes a message, a community, a membership or anything a person
// wrote. It removes rows that no longer mean anything.

const db = require('../db');
const settings = require('./settings');
const { now } = require('../util');

function daysAgo(days) {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString();
}

// One pass. Returns what was removed, so the job can say something useful and
// the diagnostics can show that the housekeeping is running.
async function run() {
  const read = (key, fallback) => (settings.isLoaded() ? settings.read(key, fallback) : fallback);

  const removed = {};

  // Sessions that were revoked, and sessions nobody has touched in a long time.
  // A revoked session is dead weight the moment it is revoked: the token it
  // named is refused by the session version, not by this row.
  removed.revokedSessions = (await db.run(
    'DELETE FROM user_sessions WHERE revoked_at IS NOT NULL AND revoked_at < ?', [daysAgo(7)])).changes || 0;

  // Revoked tokens, once they could no longer be presented.
  removed.expiredRevokedTokens = (await db.run(
    'DELETE FROM revoked_tokens WHERE expires_at < ?', [now()])).changes || 0;

  // Recovery links that expired, and the ones that were used.
  removed.expiredPasswordResets = (await db.run(
    'DELETE FROM password_resets WHERE expires_at < ?', [now()])).changes || 0;
  removed.expiredEmailVerifications = (await db.run(
    'DELETE FROM email_verifications WHERE expires_at < ?', [now()])).changes || 0;

  // Notifications, once they are older than the instance keeps them.
  const notificationDays = Number(read('retention.notificationsDays', 90));
  if (Number.isFinite(notificationDays) && notificationDays > 0) {
    removed.oldNotifications = (await db.run(
      'DELETE FROM notifications WHERE created_at < ?', [daysAgo(notificationDays)])).changes || 0;
  }

  // Job rows: the finished ones older than the history window. A job that is
  // still pending or running is never touched here - that is the queue's own
  // business.
  const jobDays = Number(read('retention.jobHistoryDays', 30));
  if (Number.isFinite(jobDays) && jobDays > 0) {
    removed.oldJobs = (await db.run(
      "DELETE FROM jobs WHERE status IN ('done', 'failed') AND updated_at < ?", [daysAgo(jobDays)])).changes || 0;
  }

  // The audit trail is kept for as long as the instance keeps the record of
  // what its administrators did. It is the one table here whose loss matters.
  const auditDays = Number(read('retention.auditDays', 365));
  if (Number.isFinite(auditDays) && auditDays > 0) {
    removed.oldAuditLogs = (await db.run(
      'DELETE FROM audit_logs WHERE created_at < ?', [daysAgo(auditDays)])).changes || 0;
  }

  // Continuum traffic that has been delivered and acknowledged long ago.
  const continuumDays = Number(read('retention.continuumDays', 90));
  if (Number.isFinite(continuumDays) && continuumDays > 0) {
    removed.oldContinuumDeliveries = (await db.run(
      "DELETE FROM continuum_deliveries WHERE attempted_at < ? AND status = 'delivered'", [daysAgo(continuumDays)])).changes || 0;
  }

  return { removed, at: now() };
}

// The scheduled pass. It enqueues the next one before it does its work, so
// the housekeeping keeps a rhythm that survives a restart: the row is in the
// queue, not in a timer inside a process that can die.
const EVERY_MS = 6 * 60 * 60 * 1000;

async function scheduled() {
  const jobs = require('./jobs');
  try {
    await jobs.enqueue('retention', {}, { runAfterMs: EVERY_MS, maxAttempts: 3 });
  } catch (e) {
    console.warn('[retention] could not schedule the next pass: ' + (e && e.message));
  }
  const out = await run();
  const removed = out.removed;
  const total = Object.values(removed).reduce((a, b) => a + b, 0);
  if (total) {
    console.log('[retention] removed ' + total + ' expired row(s): '
      + Object.entries(removed).filter(([, n]) => n).map(([k, n]) => k + ' ' + n).join(', '));
  }
  return out;
}

module.exports = { run, scheduled, EVERY_MS };

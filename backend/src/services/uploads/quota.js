// How much may one account store?
//
// MAX_SIZE bounds one file and the route's rate limit bounds the rate, but
// neither bounds the total. 8 MB every 30 minutes is 14 GB an hour, and nothing
// ever reclaims an attached file. This is the only thing that stops one member
// filling the host disk.
//
// Counted from the database rather than by walking the storage tree, so it
// behaves identically on local disk and in an object store, and costs one
// indexed aggregate.
//
// Read per call so the quota in the configuration centre is live. A value the
// dashboard saves has to be the value the next upload is measured against.

const db = require('../../db');
const features = require('../../features');

const DEFAULT_QUOTA_MB = 512;

function quotaBytes() {
  const mb = features.current.quotaBytes / (1024 * 1024);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : DEFAULT_QUOTA_MB * 1024 * 1024;
}

// Returns null when the upload fits, or a { error, message, detail } for the caller
// to return verbatim.
async function check(userId, incoming) {
  const limit = quotaBytes();
  const row = await db.get(
    'SELECT COALESCE(SUM(size), 0) AS total FROM attachments WHERE uploader_id = ?',
    [userId]
  );
  const used = row ? Number(row.total) : 0;
  if (used + incoming <= limit) return null;
  return {
    error: 'QUOTA_EXCEEDED',
    message: 'Storage quota reached; delete an attachment or ask a moderator to raise your limit',
    detail: { used, limit, incoming },
  };
}

function usage(userId) {
  return db.get(
    'SELECT COALESCE(SUM(size), 0) AS used, COUNT(*) AS files FROM attachments WHERE uploader_id = ?',
    [userId]
  ).then((row) => ({
    used: row ? Number(row.used) : 0,
    files: row ? Number(row.files) : 0,
    limit: quotaBytes(),
  }));
}

module.exports = { check, usage };

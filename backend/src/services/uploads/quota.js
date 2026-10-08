// How much may one account store?
//
// This exists because nothing else bounds it. MAX_SIZE bounds one file and the route's
// rate limit bounds the rate, but neither bounds the total: 8 MB every 30 minutes is
// 14 GB an hour, and nothing ever reclaims an attached file. This is the only thing that
// stops one member filling the host disk.
//
// Counted from the database rather than by walking the storage tree, so it behaves
// identically on local disk and in an object store, and costs one indexed aggregate.
// Attachments only: avatars and community art are replaced in place rather than
// accumulated, so they cannot grow without bound either.

const db = require('../../db');

const QUOTA_BYTES = (() => {
  const mb = parseInt(process.env.STORAGE_QUOTA_MB || '', 10);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 512 * 1024 * 1024;
})();

// Returns null when the upload fits, or a { error, message, detail } for the caller to
// return verbatim. Shaped like that so no call site has to invent its own wording for the
// same condition.
async function check(userId, incoming) {
  const row = await db.get(
    'SELECT COALESCE(SUM(size), 0) AS total FROM attachments WHERE uploader_id = ?',
    [userId]
  );
  const used = row ? Number(row.total) : 0;
  if (used + incoming <= QUOTA_BYTES) return null;
  return {
    error: 'QUOTA_EXCEEDED',
    message: 'storage quota reached; delete an attachment or ask a moderator to raise your limit',
    detail: { used, limit: QUOTA_BYTES, incoming },
  };
}

function usage(userId) {
  return db.get(
    'SELECT COALESCE(SUM(size), 0) AS used, COUNT(*) AS files FROM attachments WHERE uploader_id = ?',
    [userId]
  ).then((row) => ({
    used: row ? Number(row.used) : 0,
    files: row ? Number(row.files) : 0,
    limit: QUOTA_BYTES,
  }));
}

module.exports = { QUOTA_BYTES, check, usage };

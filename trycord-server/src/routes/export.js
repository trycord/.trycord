// Account data export.
//
// A data-access request answered from the caller's own rows, assembled on
// request. There is no queue and no emailed link, because the alternative makes
// a person wait for a stranger's infrastructure to hand them their own data and
// gives the instance a place to fail silently.
//
// Rate limited, because it is the most expensive read in the application: it
// joins across a dozen tables and returns the caller's whole history. The limit
// is generous enough that asking twice out of curiosity is fine and scraping is
// not, which is the actual intent - this endpoint answers one person, not a
// crawler.

const express = require('express');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { serviceError } = require('../errors');
const exporter = require('../services/export');

const router = express.Router();

/**
 * GET /api/me/export
 *
 * Everything this instance holds about the caller, as JSON.
 *
 * `?format=ndjson` streams the sections as newline-delimited JSON for someone
 * whose data is large enough that a single document is inconvenient to open.
 * The content type changes but the contents do not: there is one export, not two.
 */
router.get('/export', auth, rateLimit({ windowMs: 3600000, max: 20 }), async (req, res, next) => {
  try {
    const payload = await exporter.exportAccount(req.user.id);
    if (String(req.query.format || '').toLowerCase() === 'ndjson') {
      res.status(200)
        .set('Cache-Control', 'no-store')
        .type('application/x-ndjson');
      for (const [section, value] of Object.entries(payload.data)) {
        res.write(JSON.stringify({ section, data: value }) + '\n');
      }
      res.write(JSON.stringify({ section: '_meta', data: {
        exportedAt: payload.exportedAt,
        neverIncluded: payload.neverIncluded,
        incomplete: payload.incomplete || null,
      } }) + '\n');
      res.end();
      return;
    }
    res.status(200)
      .set('Cache-Control', 'no-store')
      .json(payload);
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
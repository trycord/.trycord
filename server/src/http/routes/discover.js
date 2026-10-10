// The public discovery feed: communities that chose to be discoverable.
//
// An instance that turns discovery off has this route mounted but answering that the
// feature is unavailable, rather than showing an empty feed that reads as nobody has ever
// made a community.

const express = require('express');
const { wrap } = require('../errors');
const limit = require('../../middleware/ratelimit');
const { authenticate } = require('../../middleware/auth');
const config = require('../../config');
const db = require('../../db');

const router = express.Router();
router.use(authenticate);

router.get('/', limit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  if (!config.features.publicDiscovery) {
    return res.json({ enabled: false, communities: [] });
  }

  const rows = await db.all(
    `SELECT s.id, s.name, s.description, s.slug, s.icon_url, s.banner_url, s.created_at,
       (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count
       FROM servers s
      WHERE s.is_discoverable = 1
      ORDER BY member_count DESC, s.created_at DESC
      LIMIT ?`,
    [Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100)]
  );

  res.json({
    enabled: true,
    communities: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description || '',
      slug: r.slug,
      iconUrl: r.icon_url || null,
      bannerUrl: r.banner_url || null,
      memberCount: Number(r.member_count || 0),
      createdAt: r.created_at,
    })),
  });
}));

module.exports = router;

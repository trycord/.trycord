// The public instance listing.
//
// A reader who wants another instance to join asks here. The answer is a list
// of pointers, not a verdict: whether an instance is reachable, whether it
// speaks this protocol and whether it accepts registrations are facts the
// client confirms with the instance itself.
//
// Public on purpose - a listing of public instances is public information, and
// it carries nothing an operator has not chosen to publish. It is rate limited
// because a directory reader is a remote fetch and should not be free.

const express = require('express');
const rateLimit = require('../middleware/ratelimit');
const discovery = require('../services/discovery');
const { wrap } = require('../errors');

const router = express.Router();

router.get('/instances', rateLimit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  const out = await discovery.discover();
  res.json(out);
}));

module.exports = router;

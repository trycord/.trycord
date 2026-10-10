// appeals routes. Mounted by http/app.js.
//
// The surface this instance publishes. Kept as its own module so adding or removing a
// capability is one file, not a section of the main app.

const express = require('express');
const { wrap } = require('../errors');
const { authenticate } = require('../../middleware/auth');

const router = express.Router();
router.use(authenticate);

module.exports = router;

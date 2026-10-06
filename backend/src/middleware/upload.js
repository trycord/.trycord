// Single-image upload middleware.
//
// Extracted from routes/users.js so the profile-image and community-image
// routes share ONE definition of "a single image, at most 8 MB, in the field
// named file". Duplicating it would mean the size limit and the field name
// could drift between the two surfaces.
const multer = require('multer');
const uploads = require('../services/uploads');
const { fail } = require('../errors');

const memory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploads.MAX_SIZE, files: 1 },
});

function singleImage(req, res, next) {
  memory.single('file')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return fail(res, 'VALIDATION_ERROR', 'file is too large (max ' + Math.round(uploads.MAX_SIZE / (1024 * 1024)) + ' MB)');
    }
    if (err) return next(err);
    next();
  });
}

module.exports = { singleImage, memory };

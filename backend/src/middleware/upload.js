// Multipart upload middleware, in one place.
//
// Three surfaces upload a single file in a field named "file": message attachments,
// direct-message attachments, and identity media (avatars, community icons and banners).
// They used to carry two hand-written copies of this, which is how the size limit and the
// error handling came to differ between them - one said "max 8 MB" as a number and the
// other spelled it out.
//
// Every failure mode is a 4xx. A malformed part header is a client sending bytes the
// parser cannot read, not a server fault: busboy rejects it as "Malformed part header",
// and before this existed that reached the catch-all error handler and answered 500.
const multer = require('multer');
const uploads = require('../services/uploads');
const { fail } = require('../errors');

const MAX_MB = Math.round(uploads.MAX_SIZE / (1024 * 1024));

const memory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploads.MAX_SIZE, files: 1 },
});

/**
 * Wrap multer so nothing it rejects becomes a 500.
 *
 * `single('file')` is called per request rather than at mount time because the parse
 * happens against req, and a shared pre-bound instance would be one closure for every
 * request.
 */
function singleFile(req, res, next) {
  memory.single('file')(req, res, (err) => {
    if (!err) return next();

    // Multer's own limits are a clean, expected refusal.
    if (err.code === 'LIMIT_FILE_SIZE') {
      return fail(res, 'VALIDATION_ERROR', 'file is too large (max ' + MAX_MB + ' MB)');
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return fail(res, 'VALIDATION_ERROR', 'send exactly one file, in a field named "file"');
    }

    // Anything else is the parser failing on bytes it cannot read: a malformed part
    // header, a truncated body, a control character inside a filename. All of them are
    // the client's fault and all of them are a 400.
    return fail(res, 'VALIDATION_ERROR', 'the uploaded file could not be read — check the file and try again');
  });
}

/**
 * Identity media wants a single image in the field named "file". The parse and the error
 * handling are the same as for attachments, so this is the same function under the name
 * its callers already use.
 */
const singleImage = singleFile;

module.exports = { singleImage, singleFile, memory, MAX_MB };

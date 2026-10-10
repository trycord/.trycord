// Multipart upload, in one place.
//
// Three surfaces upload a single file in a field named "file": message attachments, DM
// attachments, and identity media. Sharing one definition is what keeps the size cap and
// the error handling from drifting between them.
//
// Every failure mode is a 4xx. A malformed part header is a client sending bytes the
// parser cannot read, not a server fault - busboy rejects it as "Malformed part header"
// and before this existed that reached the catch-all handler and answered 500.

const multer = require('multer');
const config = require('../config');
const { fail } = require('../http/errors');

const MAX_MB = Math.round(config.maxUploadBytes / (1024 * 1024));

const memory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

function singleFile(req, res, next) {
  if (!config.features.uploads) {
    return fail(res, 'FORBIDDEN', 'uploads are disabled on this instance');
  }
  memory.single('file')(req, res, (err) => {
    if (!err) return next();

    if (err.code === 'LIMIT_FILE_SIZE') {
      return fail(res, 'PAYLOAD_TOO_LARGE', `file is too large (max ${MAX_MB} MB)`);
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return fail(res, 'VALIDATION_ERROR', 'send exactly one file, in a field named "file"');
    }

    // Anything else is the parser failing on bytes it cannot read: a malformed part
    // header, a truncated body, a control character inside a filename.
    return fail(res, 'VALIDATION_ERROR', 'the uploaded file could not be read — check the file and try again');
  });
}

module.exports = { singleFile, MAX_MB };

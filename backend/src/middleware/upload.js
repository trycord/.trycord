// Multipart upload middleware, in one place.
//
// Three surfaces upload a single file in a field named "file": message attachments,
// direct-message attachments, and identity media (avatars, community icons and banners).
// They used to carry two hand-written copies of this, which is how the size limit and
// the error handling came to differ between them.
//
// Every failure mode is a 4xx. A malformed part header is a client sending bytes the
// parser cannot read, not a server fault: busboy rejects it as "Malformed part header",
// and before this existed that reached the catch-all error handler and answered 500.
const multer = require('multer');
const { fail } = require('../errors');

// Multer takes a number, not a function, so its own ceiling is the widest value the
// configuration centre allows. The real limit is checked after the parse, against the
// live setting, which also means the refusal can say how large the file may be rather
// than emitting a busboy string.
const WIDEST_LIMIT = 100 * 1024 * 1024;

const memory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: WIDEST_LIMIT, files: 1 },
});

// Check the live size limit and turn anything multer rejected into a 4xx.
//
// `single('file')` is called per request rather than at mount time because the parse
// happens against req, and a shared pre-bound instance would be one closure for every
// request.
function guard(field) {
  return (req, res, next) => {
    memory.single(field)(req, res, (err) => {
      if (!err) {
        const max = require('../features').current.maxUploadBytes;
        if (req.file && req.file.size > max) {
          return fail(res, 'PAYLOAD_TOO_LARGE',
            'that file is ' + Math.round(req.file.size / 1024) + ' KB, and the limit is '
              + Math.round(max / 1024) + ' KB', 413);
        }
        return next();
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        return fail(res, 'PAYLOAD_TOO_LARGE', 'that file is larger than this instance allows', 413);
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return fail(res, 'VALIDATION_ERROR', 'send exactly one file, in a field named "' + field + '"');
      }
      // Anything else busboy produces is a malformed body, not a server fault.
      return fail(res, 'VALIDATION_ERROR', 'the upload could not be read');
    });
  };
}

// Identity media and message attachments use the same rules and the same limit, so
// they share one guard rather than two that can drift.
const singleFile = guard('file');
const singleImage = guard('image');

module.exports = { singleFile };

module.exports = { singleImage, singleFile, memory };

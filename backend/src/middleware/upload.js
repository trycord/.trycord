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

// The multipart ceiling is the live setting, not a fixed widest value.
//
// It used to be a single module-level multer instance pinned to 100 MB that buffered the
// whole body into RAM before the real limit (8 MB by default) was ever consulted, so an
// unauthenticated or merely careless client could hold 100 MB per connection. The instance
// is now built per request against `features.current.maxUploadBytes`, so the parser stops at
// the limit that actually applies and never buffers more than it. Multer takes a number,
// not a function, which is why the instance has to be rebuilt rather than configured once.
//
// Turn anything multer rejected into a 4xx.
function guard(field) {
  return (req, res, next) => {
    const max = require('../features').current.maxUploadBytes;
    const memory = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: max, files: 1 },
    });
    memory.single(field)(req, res, (err) => {
      if (!err) {
        // Multer already enforces `fileSize`, but the live setting can shrink between the
        // parse and this line, so the file is measured once more. This is also where the
        // refusal can say how large the file may be rather than emitting a busboy string.
        if (req.file && req.file.size > max) {
          return fail(res, 'PAYLOAD_TOO_LARGE',
            'that file is ' + Math.round(req.file.size / 1024) + ' KB, and the limit is '
              + Math.round(max / 1024) + ' KB', 413);
        }
        return next();
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        return fail(res, 'PAYLOAD_TOO_LARGE',
          'that file is larger than this instance allows (up to '
            + Math.round(max / 1024) + ' KB)', 413);
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
// Both fields are "file". Profile uploads used to expect "image" while every client
// sent "file", so the official client's avatar and banner uploads always 400ed.
const singleImage = guard('file');

module.exports = { singleImage, singleFile };

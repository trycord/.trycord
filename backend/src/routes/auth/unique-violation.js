// Whether a database error is somebody else taking the name you asked for.
//
// Registration and email changes both need this answer and neither should own it: the two
// dialects disagree about the error code and about the words in the message, and getting
// it wrong turns "that name is taken" into a 500.
function isUniqueViolation(e) {
  const message = String((e && e.message) || '');
  return e && (e.code === 'SQLITE_CONSTRAINT' || e.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || e.code === 'ER_DUP_ENTRY') || /unique|duplicate/i.test(message);
}

module.exports = { isUniqueViolation };

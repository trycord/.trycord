// The one place that answers "how long is too long".
//
// send and edit both had this: trim, throw if over, then slice to the maximum anyway.
// The slice was unreachable - the throw above it had already returned - and having it
// there invited the reading that a long message was silently shortened, which is exactly
// the behaviour the channel path deliberately does not have. A capped message is refused;
// a truncated one looks like a successful send of something the writer did not write.
//
// The empty check is deliberately NOT here. send accepts an empty body when there is an
// attachment, because a picture on its own is a message. edit does not, because editing a
// message to nothing is not an edit. Same length rule, two different emptiness rules, so
// only the length rule is shared.

const MAX_CONTENT = 2000;

function assertLength(text) {
  if (text.length > MAX_CONTENT) {
    throw { code: 'VALIDATION_ERROR', message: `message too long (max ${MAX_CONTENT} characters)` };
  }
}

module.exports = { MAX_CONTENT, assertLength };

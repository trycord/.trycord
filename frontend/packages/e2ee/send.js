// What the composer does with a message, given what the server says about the
// conversation.
//
// The server's answer is the only one that counts. A conversation is
// encrypted when every live member device holds the current key, and
// anything else is a fact about the keys rather than a flag somebody set.
//
// There are four answers, and the client has to be honest about each:
//
//   encrypted      the message is encrypted to every member device
//   not-encrypted  the message is sent as text, exactly as before
//   mixed          the message is sent as text, and the reader is told first
//   key-changed    the message is sent as text, and the reader is told first
//
// The last two are the ones that matter. A conversation that is "mixed" has
// a member device that cannot read what is sent in it, and a reader who is
// not told is trusting a promise the server has already broken. The client
// never sends in the clear over an encrypted conversation, and it never
// retries in the clear when the server refuses: a refusal is reported, and
// the message stays unsent.

/** The states the server reports. */
export const ENCRYPTED = 'encrypted';
export const NOT_ENCRYPTED = 'not-encrypted';
export const MIXED = 'mixed';
export const KEY_CHANGED = 'key-changed';

/** The words the reader is shown before a message goes out in the clear. */
export const WARNINGS = {
  [MIXED]: 'This conversation is not fully encrypted. At least one of the devices in it cannot read '
    + 'what is sent here, so this message will be sent in the clear.',
  [KEY_CHANGED]: 'The encryption key of this conversation has changed, and at least one of the devices in '
    + 'it does not have the new key yet, so this message will be sent in the clear.',
};

/**
 * What to do with a message, given the conversation's state.
 *
 * @param {object} state the server's answer for the conversation
 * @returns {{mode: 'encrypted'|'text', warn: string|null, state: string}}
 */
export function decide(state) {
  const name = state && state.state ? String(state.state) : NOT_ENCRYPTED;
  if (name === ENCRYPTED) {
    return { mode: 'encrypted', warn: null, state: name };
  }
  if (name === MIXED || name === KEY_CHANGED) {
    return { mode: 'text', warn: WARNINGS[name], state: name };
  }
  return { mode: 'text', warn: null, state: name };
}

/**
 * Whether a state is one in which the client has to say something before it
 * sends.
 */
export function needsWarning(state) {
  return !!decide(state).warn;
}

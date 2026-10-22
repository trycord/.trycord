// The words a refused sign-in, a locked account, or a tired token answers
// with.
//
// These sentences are the ones a reader hears when the product is at its
// least comfortable: refused, locked, forced out. They are kept in one
// place - not copied per client - because the two clients (the desk and the
// phone) must say the same thing in the same words or one of them will
// eventually say something untrue. The module carries only words and a
// description of an action; the clients draw the controls themselves, since
// their buttons and links are their own.
//
// One rule runs through all of it: the server withholds whether a sign-in
// failed on the name or the password, because that difference is how an
// account is confirmed to exist. These sentences keep that shape - they
// never name one of the two details as the wrong one.

// The wait a lockout has left.
//
// When the server names the seconds that remain on a lock, the sentence says
// the real wait rather than "later" - and when it does not, the sentence
// says so without inventing a number. Below a minute the sentence stays
// honest in the other direction too: it does not round a 40-second lock up
// to a minute.
export function waitPhrase(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (!s) return 'Wait a little, then try again.';
  if (s < 60) return 'Try again in ' + s + (s === 1 ? ' second.' : ' seconds.');
  const minutes = Math.ceil(s / 60);
  if (minutes < 60) return 'Try again in ' + minutes + (minutes === 1 ? ' minute.' : ' minutes.');
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return 'Try again in about ' + hours + (hours === 1 ? ' hour.' : ' hours.');
  return 'Try again in a few days.';
}

// The ceiling the password store can hold, checked while the passphrase is
// still in the reader's hands. The storage digests at most 72 bytes; a longer
// passphrase is refused at the door with a message that speaks in bytes, a
// unit nobody types in. Here the sentence is about the phrase, and no
// request is spent on a password that cannot be kept.
export function passwordIsOverTheCeiling(value) {
  return new TextEncoder().encode(String(value)).length > 72;
}

// A refused sign-in, told as a sentence and, when one exists, an action.
//
// The codes below are the ones the server distinguishes for exactly this
// hand-off, so each gets a whole sentence - and none of the sentences
// guesses at what went wrong when the design withholds that:
//
//   - AUTH_REQUIRED is the ordinary wrong-name-or-password refusal.
//   - ACCOUNT_LOCKED carries the seconds left on the lock, so the sentence
//     carries them too.
//   - ACCOUNT_ENFORCED is a moderation action. It has names - suspended,
//     banned, the day it ends - and the reference number an appeal is
//     written against. The people who can lift it are the ones who run
//     this instance; the action description says where support is reached.
//   - a code challenge that went stale (five minutes, from sign-in to code
//     entry) cannot be resumed; the sign-in starts over. `restartChallenge`
//     is the way back while a challenge stands open - a function, handed in
//     only when the reader is in the code step - and null otherwise.
//     Nothing here parses the server's words to tell a stale challenge from
//     a wrong code: the server answers with its own code, CHALLENGE_EXPIRED.
//
// The action is a description, not a control: { kind, href } - the clients
// draw it, because their buttons and links are their own.
export function signInRefusalWords(error, restartCallback) {
  const restart = typeof restartCallback === 'function' ? restartCallback : null;
  const details = (error && error.details) || null;
  if (error && error.code === 'ACCOUNT_LOCKED') {
    return { message: 'Too many tries in a row. ' + waitPhrase(details && details.retryAfterSeconds) };
  }
  if (error && error.code === 'ACCOUNT_ENFORCED') {
    const kind = details && details.type === 'ban'
      ? 'This account is not allowed on this instance anymore.'
      : 'This account is suspended'
        + (details && details.until ? ' until ' + new Date(details.until).toLocaleDateString() : '.');
    const sentences = [kind];
    sentences.push(details && details.actionId
      ? 'If you think that is a mistake, contact the people who run this instance and mention reference '
        + details.actionId + '.'
      : 'If you think that is a mistake, contact the people who run this instance.');
    return { message: sentences.join(' '), action: { kind: 'support', href: '/support' } };
  }
  if (error && error.code === 'CHALLENGE_EXPIRED' && restart) {
    return {
      message: 'The code window closed. Sign in again with the same details, and enter the new code.',
      action: { kind: 'restart' },
    };
  }
  if (error && error.code === 'AUTH_REQUIRED') {
    if (restart) return { message: 'That code is not right. Check the six digits the app shows and try again.' };
    return { message: 'We could not sign you in. Check the details and try again.' };
  }
  if (error && error.code === 'VALIDATION_ERROR' && /code/i.test(String(error.message || ''))) {
    return { message: 'That code is not right. Check the six digits the app shows and try again.' };
  }
  return null;
}

export default { waitPhrase, passwordIsOverTheCeiling, signInRefusalWords };

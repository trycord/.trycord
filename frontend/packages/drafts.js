// The drafts.
//
// What somebody has written and not sent.
//
// A draft belongs to a conversation, not to a page: a reader who starts a
// sentence, goes to another conversation and comes back finds the sentence
// where they left it. The same is true of a page that reloads, and of a send
// that failed - the text is still theirs, and it is still in the box.
//
// The desk and the phone write their own composers, and they are two
// implementations of the same thing. This is the part of it that must not
// differ, so it lives here and both of them use it.
//
// The drafts are kept in the browser's own storage, so they survive a
// reload and a crash, and they are kept per conversation, so two drafts do
// not overwrite each other.

const KEY = 'trycord.drafts.';

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The text written in a conversation and not yet sent. */
export function draftFor(scopeId) {
  const store = storage();
  if (!store || !scopeId) return '';
  try {
    return String(store.getItem(KEY + scopeId) || '');
  } catch {
    return '';
  }
}

/** Remember what has been written. */
export function saveDraft(scopeId, text) {
  const store = storage();
  if (!store || !scopeId) return;
  try {
    const value = String(text || '');
    if (value.trim()) store.setItem(KEY + scopeId, value);
    else store.removeItem(KEY + scopeId);
  } catch { /* the storage is full or turned off; the draft is lost, not the message */ }
}

/** Forget a draft: it has been sent. */
export function clearDraft(scopeId) {
  const store = storage();
  if (!store || !scopeId) return;
  try { store.removeItem(KEY + scopeId); } catch { /* nothing to do */ }
}

/**
 * Put a draft back into a box.
 *
 * The box is only filled when it is empty: a reader who is typing when the
 * conversation is opened again keeps what they are typing.
 */
export function restoreDraft(scopeId, textarea) {
  if (!textarea) return '';
  if (textarea.value && textarea.value.trim()) return textarea.value;
  const draft = draftFor(scopeId);
  if (draft) textarea.value = draft;
  return draft;
}

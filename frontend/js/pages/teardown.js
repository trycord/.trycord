// Teardown for the current page.
//
// Its own module because both ends need it and they cannot import each other: the
// lifecycle drains it on every navigation, and a page registers into it.

let pending = [];

/**
 * Register something to undo when this page is left.
 *
 * Registering does not replace what is already there - the old version kept a single
 * slot, so a page with two subscriptions could only keep one of them alive between
 * navigations.
 */
export function onCleanup(fn) {
  if (typeof fn === 'function') pending.push(fn);
}

/** Runs in reverse order, and one failure does not strand the rest. */
export function runTeardowns() {
  const list = pending;
  pending = [];
  for (let i = list.length - 1; i >= 0; i--) {
    try {
      list[i]();
    } catch (ex) {
      try { console.warn('[trycord] cleanup failed', ex); } catch { /* no console */ }
    }
  }
}

export function pendingCount() {
  return pending.length;
}

export default { onCleanup, runTeardowns, pendingCount };



// The cache is not the screen. An account event refreshes State so the next read
// is right, but a section already on screen was painted from what it fetched
// when it opened - so blocking someone on your phone left you looking at an
// empty list and a "People blocked: 0" that was true when you loaded and is not
// now.
//
// Only the section the event names, and only while it is still in the document.
// Repainting anything else throws away what the reader is looking at to update
// something they are not.
//
// Returns its own teardown; the caller registers that with setCleanup so a
// navigation doesn't leave a listener repainting a detached tree.
export function watchForRemoteChanges(kind, host, repaint) {
  const onChange = (e) => {
    if (!e || e.detail !== kind) return;
    if (!host.isConnected) return;
    repaint();
  };
  document.addEventListener('trycord:state', onChange);
  return () => document.removeEventListener('trycord:state', onChange);
}

// Message grouping: consecutive messages from one person inside a short window draw as
// one block rather than as separate messages.
//
// It lives here because the rule and the metadata it reads have to agree, and they were
// 120 lines apart in the middle of a channel renderer with about forty closures around
// them: `stampMsgNode` writes `data-author` and `data-ts`, `groupState` reads them back.
// Splitting one from the other would make the contract implicit and the next change to
// either half would silently stop grouping.
//
// The window is five minutes and it is deliberately not the same as the DM thread's
// layout, which draws every message separately. That is a different surface answering a
// different question, not two implementations of one thing.
//
// Everything reads `dataset` rather than holding a list, so grouping works the same for a
// message appended live, one inserted in the middle, and a whole feed rebuilt from a page
// of history - which is why `groupFeed` walks the feed and `regroupAround` fixes only the
// three nodes whose answer can have changed.

const GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Record what grouping needs on the node itself.
 *
 * The feed is re-rendered from history as often as from a live event, so this cannot rely
 * on the message object still being around by the time something asks. Decoration on a
 * node that survives reparenting is what makes `groupFeed` possible.
 */
export function stampMsgNode(node, m) {
  try {
    if (m && m.author_id) node.dataset.author = String(m.author_id);
    if (m && m.created_at) node.dataset.ts = String(m.created_at);
    if (m && typeof m.seq === 'number') node.dataset.seq = String(m.seq);
  } catch { /* grouping metadata is decorative */ }
}

function groupState(node, prev) {
  if (!node || !prev) return false;
  const a = node.dataset.author || '';
  if (!a) return false;
  const pa = prev.dataset.author || '';
  if (a !== pa) return false;
  const ts = Date.parse(node.dataset.ts || '') || 0;
  const pts = Date.parse(prev.dataset.ts || '') || 0;
  return ts >= pts && (ts - pts) < GROUP_WINDOW_MS;
}

function applyGrouping(node) {
  if (!node) return;
  const prev = node.previousElementSibling;
  node.classList.toggle('grouped', groupState(node, prev));
}

/**
 * Re-decide the three nodes whose neighbour changed.
 *
 * Called when a message is inserted or removed in the middle of the feed. Only the node,
 * the one above it and the one below can have a different answer afterwards; the rest of
 * the feed cannot, and walking all of it on every live message is what made a busy channel
 * stutter.
 */
export function regroupAround(node) {
  applyGrouping(node);
  if (node && node.previousElementSibling) applyGrouping(node.previousElementSibling);
  const next = node && node.nextElementSibling;
  if (next) applyGrouping(next);
}

/** Decide every message in a feed, for a rebuild from a page of history. */
export function groupFeed(feedEl) {
  let prev = null;
  for (const node of feedEl.querySelectorAll(':scope > .msg')) {
    node.classList.toggle('grouped', groupState(node, prev));
    prev = node;
  }
}
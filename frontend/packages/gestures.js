// Gestures on a message.
//
// Swiping a message to the side replies to it.
//
// The rules a swipe has to obey, or it is a nuisance rather than a gesture:
//
//   - a vertical move is a scroll, and a scroll that turns into a reply is
//     the worst thing a message list can do;
//   - a drag that starts on a control belongs to the control, so a link
//     inside a message is still a link;
//   - the movement has to be *deliberate* - a long way, and mostly
//     sideways - before it means anything;
//   - the message moves under the finger, so the reader can see what is
//     about to happen and can let go;
//   - and nothing is *only* a gesture: the menu on every message offers
//     the same reply, for a reader who cannot swipe, or does not think of
//     it.
//
// The movement is turned into a click-free action, so a swipe never
// selects text and never moves the caret.

/** How far a finger has to travel before it means something. */
const REPLY_DISTANCE = 64;

/** How much of the movement has to be sideways for it to be a swipe. */
const SIDEWAYS_RATIO = 1.6;

/** How far the message moves under the finger. */
const TRAVEL = 76;

/**
 * Give a message row the gesture.
 *
 * @param {HTMLElement} row      the message
 * @param {Function} onReply      what to do when the swipe means something
 * @param {object} [options]      { reducedMotion }
 */
export function swipeToReply(row, onReply, options) {
  const opts = options || {};
  if (!row || typeof row.addEventListener !== 'function') return () => {};

  let startX = 0;
  let startY = 0;
  let tracking = false;
  let sideways = false;

  const reset = () => {
    tracking = false;
    sideways = false;
    row.style.removeProperty('transform');
    row.classList.remove('is-swiping');
  };

  const onStart = (event) => {
    // A control inside the message is a control, and a drag on it is the
    // reader's business, not ours.
    if (event.target && event.target.closest('a, button, input, textarea, select, img, video')) {
      reset();
      return;
    }
    const touch = event.touches && event.touches[0];
    const point = touch || event;
    startX = point.clientX;
    startY = point.clientY;
    tracking = true;
    sideways = false;
  };

  const onMove = (event) => {
    if (!tracking) return;
    const touch = event.touches && event.touches[0];
    const point = touch || event;
    const dx = point.clientX - startX;
    const dy = point.clientY - startY;

    if (!sideways) {
      // A vertical move is a scroll. Once the finger is clearly going down
      // the list, the gesture is over.
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
        reset();
        return;
      }
      if (Math.abs(dx) < 10) return;
      sideways = true;
      row.classList.add('is-swiping');
    }

    // A drag that goes the other way is not a reply.
    if (dx < 0) { reset(); return; }

    const travel = Math.min(dx, TRAVEL);
    row.style.transform = 'translateX(' + travel + 'px)';
    if (event.cancelable) event.preventDefault();
  };

  const onEnd = () => {
    if (!tracking) return;
    const travelled = Math.abs(parseFloat(row.style.transform.replace(/[^0-9.-]/g, '')) || 0);
    const wasSideways = sideways;
    reset();
    if (wasSideways && travelled >= REPLY_DISTANCE) onReply();
  };

  row.addEventListener('touchstart', onStart, { passive: true });
  row.addEventListener('touchmove', onMove, { passive: false });
  row.addEventListener('touchend', onEnd);
  row.addEventListener('touchcancel', onEnd);

  return function release() {
    row.removeEventListener('touchstart', onStart);
    row.removeEventListener('touchmove', onMove);
    row.removeEventListener('touchend', onEnd);
    row.removeEventListener('touchcancel', onEnd);
  };
}

// Mobile gestures.
//
// Horizontal swipe on the view hops between bottom-tab destinations. A downward
// swipe on an open bottom sheet dismisses it.
//
// Direction is decided on the first move: vertical movement wins scrolling,
// horizontal movement wins the tab gesture. We only call preventDefault once we
// know which one it is, so a plain scroll is never hijacked.

const THRESHOLD_X = 30;
const DECIDE = 12; // px moved before we commit to a direction

function pos(t) { return { x: t.clientX, y: t.clientY }; }

// Returns a cleanup function that removes all listeners.
export function attachViewSwipe(view, onSwitchTab) {
  let start = null;
  let decided = null; // null | 'horizontal' | 'vertical'

  function onStart(e) {
    const t = e.touches[0];
    start = pos(t);
    decided = null;
  }

  function onMove(e) {
    if (!start) return;
    const t = e.touches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;

    if (decided === null) {
      if (Math.abs(dy) > DECIDE) {
        decided = 'vertical'; // the user is scrolling, stay out of the way
        return;
      }
      if (Math.abs(dx) > DECIDE && Math.abs(dx) > Math.abs(dy)) {
        decided = 'horizontal';
        e.preventDefault(); // claim the touch before the scroll starts
        return;
      }
      return; // still too small to call
    }

    if (decided === 'horizontal') e.preventDefault();
  }

  function onEnd(e) {
    if (!start || decided !== 'horizontal') {
      start = null;
      decided = null;
      return;
    }
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    if (Math.abs(dx) > THRESHOLD_X) {
      requestAnimationFrame(() => onSwitchTab(dx > 0 ? 1 : -1));
    }
    start = null;
    decided = null;
  }

  function onCancel() {
    start = null;
    decided = null;
  }

  view.addEventListener('touchstart', onStart, { passive: false });
  view.addEventListener('touchmove', onMove, { passive: false });
  view.addEventListener('touchend', onEnd, { passive: true });
  view.addEventListener('touchcancel', onCancel, { passive: true });

  return () => {
    view.removeEventListener('touchstart', onStart);
    view.removeEventListener('touchmove', onMove);
    view.removeEventListener('touchend', onEnd);
    view.removeEventListener('touchcancel', onCancel);
  };
}

export function attachSheetDismiss(sheet, onDismiss) {
  let start = null;

  function onStart(e) {
    const t = e.touches[0];
    start = pos(t);
  }

  function onEnd(e) {
    if (!start) return;
    const t = e.changedTouches[0];
    if (t.clientY - start.y > 100) onDismiss(); // dragged down far enough
    start = null;
  }

  function onCancel() {
    start = null;
  }

  sheet.addEventListener('touchstart', onStart, { passive: true });
  sheet.addEventListener('touchend', onEnd, { passive: true });
  sheet.addEventListener('touchcancel', onCancel, { passive: true });

  return () => {
    sheet.removeEventListener('touchstart', onStart);
    sheet.removeEventListener('touchend', onEnd);
    sheet.removeEventListener('touchcancel', onCancel);
  };
}

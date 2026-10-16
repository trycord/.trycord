// Mobile gestures.
//
// Horizontal swipes on the view switch between the bottom-tab destinations —
// only when the gesture is clearly horizontal and started at the top of the
// scroll, so scrolling a page is never mistaken for a tab change. A downward
// swipe on an open bottom sheet dismisses it.

const THRESHOLD_X = 30;
const THRESHOLD_Y = 100;

function startTouch(e) {
  const t = e.touches[0];
  return { x: t.clientX, y: t.clientY, time: Date.now() };
}

export function attachViewSwipe(view, onSwitchTab) {
  let start = null;
  let pending = false;

  const onStart = (e) => { start = startTouch(e); pending = false; };
  const onMove = (e) => {
    if (!start || pending) return;
    const t = e.touches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (view.scrollTop > 0 || Math.abs(dy) > Math.abs(dx) || Math.abs(dx) < THRESHOLD_X) return;
    e.preventDefault();
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      start = null;
      onSwitchTab(dx > 0 ? 1 : -1);
    });
  };
  const onEnd = () => { start = null; pending = false; };

  view.addEventListener('touchstart', onStart, { passive: true });
  view.addEventListener('touchmove', onMove, { passive: false });
  view.addEventListener('touchend', onEnd, { passive: true });
  view.addEventListener('touchcancel', onEnd, { passive: true });

  return () => {
    view.removeEventListener('touchstart', onStart);
    view.removeEventListener('touchmove', onMove);
    view.removeEventListener('touchend', onEnd);
    view.removeEventListener('touchcancel', onEnd);
  };
}

export function attachSheetDismiss(sheet, onDismiss) {
  let start = null;

  const onStart = (e) => { start = startTouch(e); };
  const onEnd = (e) => {
    if (!start) return;
    const t = e.changedTouches[0];
    const dy = t.clientY - start.y; // positive = dragged down
    if (dy > THRESHOLD_Y) onDismiss();
    start = null;
  };

  sheet.addEventListener('touchstart', onStart, { passive: true });
  sheet.addEventListener('touchend', onEnd, { passive: true });
  sheet.addEventListener('touchcancel', () => { start = null; }, { passive: true });

  return () => {
    sheet.removeEventListener('touchstart', onStart);
    sheet.removeEventListener('touchend', onEnd);
    sheet.removeEventListener('touchcancel', () => { start = null; });
  };
}

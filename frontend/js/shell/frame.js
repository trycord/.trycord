// The workspace frame.
//
// The persistent DOM the router never touches: the command bar, the communities
// rail, the place column, the stage, the inspector and the dock. Built once at
// boot; from then on regions are filled and emptied, never rebuilt.
//
// The tree is a grid with named areas, so the layout cannot drift from the
// regions it lays out: the command bar across the top, then rail | column |
// stage below it. Anything that floats - the inspector, the backdrop, the dock -
// is positioned rather than placed, because a floating thing that takes a grid
// cell moves the whole workspace instead of covering part of it.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { brandSymbolUrl } from '../../packages/brand.js';

// Drag a column's edge. `sign` is +1 when the column grows to the right of its
// grip (the place column) and -1 when it grows to the left of it (the
// inspector). One writer for the live width, one commit when the drag ends.
export function attachColumnResize(grip, options) {
  const { root, variable, min, max, sign, remember, fallback } = options;

  function current() {
    const value = parseFloat(getComputedStyle(root).getPropertyValue(variable));
    return Number.isFinite(value) ? value : fallback;
  }
  function apply(width) {
    const clamped = Math.min(max, Math.max(min, Math.round(width)));
    root.style.setProperty(variable, clamped + 'px');
    grip.setAttribute('aria-valuenow', String(clamped));
    return clamped;
  }

  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = current();
    grip.dataset.dragging = 'true';

    function move(moveEvent) {
      apply(startWidth + sign * (moveEvent.clientX - startX));
    }
    function end() {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      delete grip.dataset.dragging;
      remember(current());
    }
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  });

  grip.addEventListener('dblclick', () => { apply(fallback); remember(current()); });

  grip.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 32 : 12;
    if (event.key === 'ArrowLeft') { event.preventDefault(); apply(current() - step); remember(current()); }
    else if (event.key === 'ArrowRight') { apply(current() + step); remember(current()); event.preventDefault(); }
    else if (event.key === 'Enter') { apply(fallback); remember(current()); }
  });
}

export function brandMark(className) {
  const home = el('a', {
    class: className, href: '/home', title: 'Trycord home', 'aria-label': 'Trycord home',
  });
  const img = el('img', { src: brandSymbolUrl, alt: '', loading: 'lazy' });
  img.addEventListener('error', () => {
    home.replaceChildren(el('span', { class: 'brand-fallback', 'aria-hidden': 'true' }, 'T'));
  });
  home.appendChild(img);
  return home;
}

// Whether the window is narrow enough for the place column to be a panel over
// the stage rather than a column beside it.
//
// The stylesheet has the same question in a media query, and the two have to
// answer it the same way: the button decides which state the column is in,
// and the stylesheet decides what that state looks like.
export const NARROW_WIDTH = 860;

export function narrowWindow() {
  try {
    return window.matchMedia('(max-width: ' + NARROW_WIDTH + 'px)').matches;
  } catch {
    return false;
  }
}

export function buildFrame() {
  // -- the command bar -------------------------------------------------------
  const navToggle = el('button', {
    class: 'cmdbar-nav icon-btn', type: 'button',
    'aria-label': 'Show navigation', 'aria-expanded': 'true',
  }, icon('sidebar', { size: 18 }));

  const kbd = el('kbd', { class: 'cmdbar-kbd' });
  const omnibox = el('button', {
    class: 'cmdbar-omni', type: 'button', 'aria-haspopup': 'dialog',
    'aria-label': 'Search or jump to a place',
  },
    icon('search', { size: 16 }),
    el('span', { class: 'cmdbar-omni-label truncate' }, 'Search or jump to...'),
    kbd);

  const connection = el('div', { class: 'connection', id: 'connection-status', role: 'status' });
  const alertsSlot = el('div', { class: 'cmdbar-alerts' });
  // The inspector is the shell's own chrome, so its control lives beside the
  // navigation control. It is hidden until the page on screen has a panel to
  // show - a control that cannot open anything is not offered.
  const inspectorToggle = el('button', {
    class: 'icon-btn context-toggle cmdbar-panel', type: 'button',
    'aria-label': 'The panel beside this page', 'aria-expanded': 'false',
    hidden: true,
  }, icon('panel-left', { size: 18 }));
  const commandBar = el('header', { class: 'cmdbar', id: 'command-bar', 'aria-label': 'Command bar' },
    navToggle, omnibox, el('div', { class: 'spacer' }), inspectorToggle, connection, alertsSlot);

  // -- the rail --------------------------------------------------------------
  const rail = el('nav', {
    class: 'rail', id: 'community-rail', 'aria-label': 'Communities',
  });

  // -- the place column ------------------------------------------------------
  const columnHead = el('header', { class: 'context-head', id: 'spine-head' });
  const columnBody = el('div', {
    class: 'context-scroll', id: 'place-navigation', 'aria-label': 'Current place navigation',
  });
  const columnFoot = el('footer', { class: 'context-foot', id: 'spine-foot', 'aria-label': 'Account' });
  const columnGrip = el('div', {
    class: 'grip grip--column', role: 'separator', 'aria-orientation': 'vertical',
    'aria-label': 'Resize navigation', tabindex: '0',
  });
  const column = el('aside', { class: 'context', id: 'spine', 'aria-label': 'Navigation' },
    columnHead, columnBody, columnFoot, columnGrip);

  // -- the stage -------------------------------------------------------------
  const stageHead = el('header', { class: 'stage-head', id: 'context-header' });
  const stageBody = el('div', { class: 'stage-body', id: 'view-root', tabindex: '-1' });
  const composerSlot = el('div', { class: 'composer-slot', hidden: true });
  const screen = el('div', { class: 'screen', id: 'screen' }, stageHead, stageBody, composerSlot);
  // The stage is the reading column, and a reading column has a width the
  // reader chooses. Its grip sits on the right edge, so a drag narrows it.
  const stageGrip = el('div', {
    class: 'grip grip--stage', role: 'separator', 'aria-orientation': 'vertical',
    'aria-label': 'Resize the reading column', tabindex: '0',
  });
  const stage = el('main', { class: 'stage', id: 'trycord-main' }, screen, stageGrip);

  // -- floating layers -------------------------------------------------------
  const inspectorHead = el('header', { class: 'inspector-head', id: 'inspector-head' });
  const inspectorBody = el('div', { class: 'inspector-body', id: 'inspector-view' });
  const inspectorGrip = el('div', {
    class: 'grip grip--inspector', role: 'separator', 'aria-orientation': 'vertical',
    'aria-label': 'Resize panel', tabindex: '0',
  });
  const inspector = el('aside', {
    class: 'inspector', id: 'context-panel', 'aria-label': 'Context', hidden: true,
  }, inspectorGrip, inspectorHead, inspectorBody);

  const scrim = el('div', { class: 'scrim', id: 'desktop-backdrop', 'aria-hidden': 'true' });
  const dock = el('div', { class: 'dock', id: 'voice-dock', hidden: true });
  const skip = el('a', { class: 'skip-link', href: '#view-root' }, 'Skip to content');

  const root = el('div', {
    class: 'ws', id: 'shell', 'aria-label': 'Trycord',
    dataset: { context: 'closed', nav: 'expanded' },
  }, skip, commandBar, rail, column, stage, inspector, scrim, dock);

  const refs = {
    root, commandBar, navToggle, omnibox, kbd, connection, alertsSlot, inspectorToggle,
    rail, column, columnHead, columnBody, columnFoot, columnGrip,
    stage, stageHead, stageBody, composerSlot, stageGrip,
    inspector, inspectorGrip, inspectorHead, inspectorBody,
    scrim, dock, skip,
  };

  // The button that opens and closes the place column.
  //
  // Three states, not two. On a wide window the column is a column:
  // 'expanded' or 'hidden'. On a narrow window it is a panel that opens over
  // the stage: 'overlay' or 'hidden'.
  //
  // The button used to know only 'expanded' and 'hidden'. On a narrow window
  // the state was 'overlay', so one click made it 'expanded' - which is
  // *hidden* on a narrow window, because the panel is only shown when the
  // state is 'overlay'. The second click made it 'hidden', which is also
  // hidden. The column could be closed and never opened again: the button was
  // broken exactly where it is the only way in.
  navToggle.addEventListener('click', () => {
    const state = root.dataset.nav;
    const open = state === 'expanded' || state === 'overlay';
    const next = open ? 'hidden' : (narrowWindow() ? 'overlay' : 'expanded');
    root.dataset.nav = next;
    navToggle.setAttribute('aria-expanded', next === 'hidden' ? 'false' : 'true');
  });

  return refs;
}

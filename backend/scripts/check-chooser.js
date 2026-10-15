#!/usr/bin/env node
'use strict';

// The one decision that picks a module, and the one arithmetic that moves between them.
//
// Trycord is two independent frontend modules served from one origin. Nothing in either
// module decides which document a reader gets; `frontend/packages/chooser.js` does, and
// both entries ask it the same question. That is the entire coupling between the two
// modules, so it is the one place worth a check: if the rule drifts, a reader oscillates
// between two documents, or a deep link bounces them somewhere they did not ask for.
//
// The rules asserted here:
//
//   1. An explicit choice outranks the viewport; the viewport is the fallback.
//   2. Only the two known choices are honoured - a corrupted value is not a choice.
//   3. `siblingMount` is an involution: the sibling of the sibling is where you began.
//      That is what makes the two front doors agree rather than point past each other.
//   4. Both entries hand off through the chooser at their own front door, and neither
//      builds the other module's path by hand.
//
// Pure logic and source reading; no server, no DOM, no browser.
//
//   node scripts/check-chooser.js

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..');
const CHOOSER = path.join(REPO, 'frontend', 'packages', 'chooser.js');

let failures = 0;
const ok = (label, cond, detail) => {
  if (cond) { console.log('  ok   ' + label); }
  else { failures++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
};

// A localStorage the chooser will find on `window`, so the override path is exercised
// rather than assumed. Installed before the module is imported, but the chooser reads
// it per call, so ordering only matters for the clear-before/after cases.
function fakeLocalStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    dump: () => map,
  };
}

(async () => {
  global.window = { localStorage: fakeLocalStorage() };
  const chooser = await import(pathToFileURL(CHOOSER).href);
  const {
    readOverride, setOverride, clearOverride,
    resolvePresentation, preferredEntry, siblingMount,
    ENTRY_DESKTOP, ENTRY_MOBILE, MOBILE_MAX_WIDTH, PRESENTATION_KEY,
  } = chooser;

  console.log('\n  the decision');

  ok('the two entries are the two names', ENTRY_DESKTOP === 'desktop' && ENTRY_MOBILE === 'mobile',
    `desktop=${ENTRY_DESKTOP} mobile=${ENTRY_MOBILE}`);

  ok('an explicit choice outranks a viewport that disagrees',
    resolvePresentation(ENTRY_DESKTOP, true) === ENTRY_DESKTOP
    && resolvePresentation(ENTRY_MOBILE, false) === ENTRY_MOBILE,
    'override and viewport both consulted, and the override lost');

  ok('with no choice, the viewport decides',
    resolvePresentation(null, true) === ENTRY_MOBILE
    && resolvePresentation(null, false) === ENTRY_DESKTOP,
    'a phone-shaped viewport with no stored choice did not get the Mobile entry');

  ok('only a known choice is a choice',
    resolvePresentation('tablet', true) === ENTRY_MOBILE
    && resolvePresentation('', false) === ENTRY_DESKTOP,
    'an unknown override value was treated as a choice');

  ok('preferredEntry reads override and viewport the same way',
    preferredEntry(ENTRY_DESKTOP, { override: ENTRY_MOBILE, wantsMobile: false }) === ENTRY_MOBILE
    && preferredEntry(ENTRY_DESKTOP, { override: null, wantsMobile: true }) === ENTRY_MOBILE
    && preferredEntry(ENTRY_MOBILE, { override: null, wantsMobile: true }) === ENTRY_MOBILE
    && preferredEntry(ENTRY_MOBILE, { override: ENTRY_DESKTOP, wantsMobile: true }) === ENTRY_DESKTOP,
    'preferredEntry disagreed with resolvePresentation');

  // The stored choice itself, against the localStorage above.
  setOverride(ENTRY_MOBILE);
  ok('a stored choice is remembered', readOverride() === ENTRY_MOBILE && !!global.window.localStorage.getItem(PRESENTATION_KEY),
    'setOverride did not persist the choice');
  setOverride('nonsense');
  ok('an invalid choice is cleared rather than stored', readOverride() === null,
    'setOverride kept a value that is not an entry');
  setOverride(ENTRY_DESKTOP);
  clearOverride();
  ok('the choice can be cleared', readOverride() === null, 'clearOverride left the choice behind');

  console.log('\n  moving between the two documents');

  // The mounts a real deployment produces: origin root, a hosted /app mount, and the
  // root-relative client of a desktop app. The sibling is always exactly one known step.
  ok('the desktop entry\'s sibling is the mobile mount',
    siblingMount(ENTRY_DESKTOP, '') === '/mobile'
    && siblingMount(ENTRY_DESKTOP, '/app') === '/app/mobile',
    'siblingMount(desktop, base) is not base + /mobile');

  ok('the mobile entry\'s sibling is the mount above it',
    siblingMount(ENTRY_MOBILE, '/app/mobile') === '/app'
    && siblingMount(ENTRY_MOBILE, '/mobile') === '',
    'siblingMount(mobile, base) is not base minus /mobile');

  const roundTrips = ['', '/app', '/tc'].every(
    (m) => siblingMount(ENTRY_MOBILE, siblingMount(ENTRY_DESKTOP, m)) === m,
  );
  ok('the sibling of the sibling is where you began', roundTrips,
    'the two front doors do not point at each other - a reader could bounce');

  console.log('\n  the entries use it, and do not re-derive it');

  const desktopSrc = fs.readFileSync(path.join(REPO, 'frontend', 'js', 'main.js'), 'utf8');
  const mobileSrc = fs.readFileSync(path.join(REPO, 'frontend', 'mobile', 'js', 'main.js'), 'utf8');

  ok('the desktop entry hands off through the chooser',
    /from '\.\.\/packages\/chooser\.js'/.test(desktopSrc)
    && /preferredEntry\(/.test(desktopSrc) && /siblingMount\(/.test(desktopSrc),
    'the desktop entry does not hand off through the chooser');

  ok('the mobile entry hands back through the chooser',
    /from '\.\.\/\.\.\/packages\/chooser\.js'/.test(mobileSrc) && /siblingMount\(/.test(mobileSrc),
    'the mobile entry does not hand back through the chooser');

  // Neither module may build the other's address by hand: the mount rule is the chooser's,
  // and a second copy of it is where the two would drift.
  const handBuilt = [['desktop', desktopSrc], ['mobile', mobileSrc]]
    .filter(([, src]) => /['"`]\/(?:mobile|app)\/?['"`]/.test(src))
    .map(([entry]) => entry);
  ok('neither entry hand-builds the sibling path', handBuilt.length === 0,
    'a hard-coded sibling path in: ' + handBuilt.join(', '));

  ok('the width that defines "phone-shaped" is a named constant',
    Number.isFinite(MOBILE_MAX_WIDTH) && MOBILE_MAX_WIDTH > 0 && MOBILE_MAX_WIDTH < 1200,
    'MOBILE_MAX_WIDTH is ' + MOBILE_MAX_WIDTH);

  console.log(`\n  chooser check ${failures ? 'FAILED - ' + failures + ' problem(s)' : 'passed'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('chooser check could not run: ' + e.stack); process.exit(1); });

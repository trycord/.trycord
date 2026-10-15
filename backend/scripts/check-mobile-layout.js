// The Mobile module's composition, measured from its built stylesheet.
//
// A phone is not a narrowed desk. The desktop module carries no phone layer at all -
// `frontend/css/app.css` is the desk composition and nothing else - and the Mobile
// module is a second, independent presentation whose whole style is
// `frontend/mobile/css/app.css`: the shared token library prepended, then the
// module's own single layer. Nothing in jsdom can see layout, and nothing that
// renders a mobile page reads the stylesheet, so the shape the module promises is
// asserted here, off the file the browser actually loads.
//
// Two things this exists for, both of which a render check cannot catch:
//
//   1. A `display` rule applied to a region the shell hides with the `hidden`
//      attribute wins against the attribute itself, so a closed sheet stays on
//      screen as an undismissable box. The Mobile stylesheet rules this class of
//      fault out with an `!important` `[hidden]` rule, which this asserts is there.
//      The failure was found on the desktop sibling, so it is worth naming here
//      rather than assuming the mobile module is immune.
//   2. A component losing the measurement that makes it a phone affordance - a
//      target below the thumb, a composer under the home indicator, a 14px field
//      the software keyboard zooms into. These are the module's whole reason to
//      exist and none of them shows up in a render tree.
//
//   node scripts/check-mobile-layout.js

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const FILE = path.join(REPO, 'frontend', 'mobile', 'css', 'app.css');
const CSS = fs.readFileSync(FILE, 'utf8');

let failures = 0;
const ok = (label, cond, detail) => {
  if (cond) { console.log('  ok   ' + label); }
  else { failures++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
};

// ---- it is the module's own stylesheet -------------------------------------
//
// Built by frontend/scripts/build-css.js from the shared token library and
// frontend/mobile/css/mobile.css alone. If a desktop layer were ever concatenated
// in, the two modules would stop being separate presentations - the same fault as a
// cross-module import, one level down.

const markers = CSS.match(/\/\* ---- [A-Za-z0-9._-]+ ---- \*\//g) || [];
ok('the mobile bundle is exactly one layer, and it is the module\'s own',
  markers.length === 1 && markers[0] === '/* ---- mobile.css ---- */',
  'layer markers: ' + (markers.join(', ') || '(none)'));

ok('the shared token library is prepended to it',
  /--tc-brand\s*:/.test(CSS),
  'no --tc-brand in the bundle, so the token library was not prepended');

const DESKTOP_SELECTORS = ['.community-rail', '.spine', '.tabbar', '.context-panel',
  '.place-navigation', 'data-presentation'];
const leaked = DESKTOP_SELECTORS.filter((s) => CSS.includes(s));
ok('no desktop composition leaks into the mobile stylesheet',
  leaked.length === 0,
  'desktop selectors present: ' + leaked.join(', '));

// ---- a hidden region stays hidden ------------------------------------------
//
// `hidden` is a presentational attribute with a UA rule of `display: none`, and an
// author rule of any other display value beats it. `!important` makes the attribute
// authoritative no matter what a component rule says, which is the one-line reason
// the mobile module cannot grow the closed-sheet bug.

const hiddenRule = /\[hidden\]\s*\{([^}]*)\}/.exec(CSS);
ok('the hidden attribute outranks every component rule',
  !!hiddenRule && /display\s*:\s*none\s*!important/.test(hiddenRule[1]),
  hiddenRule ? '[hidden] is "' + hiddenRule[1].trim() + '"' : 'no [hidden] rule in the mobile stylesheet');

// ---- the shell -------------------------------------------------------------
//
// A fixed app bar and a fixed tab bar around a single scrolling view, on one
// column, full device height. This is the composition the module's shell builds and
// the grid it depends on.

function ruleBody(selector) {
  // The first block whose selector list contains the exact selector. Comments
  // between rules are part of the text a naive scan captures, so they are stripped
  // before the selector is split.
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(CSS))) {
    const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, ' ');
    const branches = sel.split(',').map((b) => b.trim());
    if (branches.includes(selector)) return m[2];
  }
  return null;
}

const app = ruleBody('.m-app');
ok('the mobile shell is a full-height, single-column grid',
  !!app && /grid-template-rows\s*:/.test(app) && /100dvh/.test(app),
  app ? '.m-app is "' + app.trim().replace(/\s+/g, ' ') + '"' : 'no .m-app rule');

const tabs = ruleBody('.m-tabs');
ok('the tab bar is the shell\'s own row and clears the home indicator',
  !!tabs && /min-height\s*:\s*var\(--m-tabbar-h\)/.test(tabs)
  && /env\(\s*safe-area-inset-bottom/.test(tabs),
  tabs ? '.m-tabs is "' + tabs.trim().replace(/\s+/g, ' ') + '"' : 'no .m-tabs rule');

ok('the shell clears the top safe area',
  !!app && /env\(\s*safe-area-inset-top/.test(app),
  'the app bar would sit under a notch');

const view = ruleBody('.m-view');
ok('the view is the one scrolling region',
  !!view && /overflow-y\s*:\s*auto/.test(view),
  view ? '.m-view does not scroll' : 'no .m-view rule');

// ---- the composer ----------------------------------------------------------
//
// The footer a conversation hands its tab-bar row to, and the field the software
// keyboard opens into. A 16px field is what stops iOS zooming the whole page on
// focus, and the bottom inset is what keeps the send button off the home indicator.

const composer = ruleBody('.m-composer');
ok('the composer clears the home indicator',
  !!composer && /env\(\s*safe-area-inset-bottom/.test(composer),
  composer ? '.m-composer has no bottom safe-area inset' : 'no .m-composer rule');

const field16 = /font-size\s*:\s*16px/.test(ruleBody('.m-input') || '')
  && /font-size\s*:\s*16px/.test(ruleBody('.m-composer__input') || '');
ok('the text fields are 16px, so a phone keyboard does not zoom into them',
  field16,
  'a field below 16px makes iOS zoom the page rather than the field');

// ---- touch targets ---------------------------------------------------------

ok('the module names a thumb-sized target and uses it',
  /--m-tap\s*:\s*44px/.test(CSS)
  && /min-height\s*:\s*var\(--m-tap\)/.test(CSS),
  'no 44px tap token, or nothing spends it - a list of sub-thumb controls');

// ---- overlays --------------------------------------------------------------
//
// A sheet rises from the bottom with a rounded top edge; it does not float as a
// card in the middle of the viewport the way the desk's dialog does.

const sheet = ruleBody('.m-sheet');
ok('an overlay is a sheet that rises from the bottom',
  !!sheet && /bottom\s*:\s*0/.test(sheet)
  && /border-top-left-radius\s*:/.test(sheet) && /border-top-right-radius\s*:/.test(sheet),
  sheet ? '.m-sheet is not anchored as a bottom sheet' : 'no .m-sheet rule');

// ---- motion ----------------------------------------------------------------
//
// The brand's motion is not optional, so the one preference that must be honoured
// is the one that turns it off.

ok('reduced motion is honoured across the module',
  /@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(CSS)
  && /animation-duration\s*:\s*[^;]*!important/.test(CSS),
  'no reduced-motion rule that actually disables the animation');

console.log(`\n  mobile layout check ${failures ? 'FAILED - ' + failures + ' problem(s)' : 'passed'}`);
process.exit(failures ? 1 : 0);

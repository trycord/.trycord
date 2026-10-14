// The responsive composition, measured from the built stylesheet.
//
// The failure this exists for: a `display` rule applied to a region the shell hides
// with the `hidden` attribute wins against the attribute itself, so a closed panel
// stays on screen as an undismissable box. Nothing in jsdom can see it - there is no
// layout engine - and nothing in the render check reads the stylesheet at all.
//
//   node scripts/check-mobile-layout.js

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const CSS = fs.readFileSync(path.join(REPO, 'frontend', 'css', 'app.css'), 'utf8');

// Regions the shell toggles with the `hidden` attribute. The spine is deliberately
// absent: it is keyed to #shell[data-spine], not to `hidden`, because a collapsed spine
// and a phone spine are the same element and hide themselves in their own ways.
const HIDEABLE = [
  'context-panel',
  'composer-slot',
];

let failures = 0;
const ok = (label, cond, detail) => {
  if (cond) { console.log('  ok   ' + label); }
  else { failures++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
};

// The name a selector's last compound part addresses, without its prefix or any
// attribute/state suffix: ".context-panel:not([hidden])" -> "context-panel".
function addressed(compound) {
  return compound.replace(/^[.#]/, '').split(/[^a-zA-Z0-9_-]/)[0];
}

// Every rule that sets a display property, with its selector.
const rules = [];
const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = ruleRe.exec(CSS))) {
  const sel = m[1].trim().replace(/\s+/g, ' ');
  if (!sel || sel.startsWith('@') || sel.startsWith('/*')) continue;
  const body = m[2];
  const disp = body.match(/display\s*:\s*([a-z-]+)/);
  if (!disp) continue;
  if (['block', 'flex', 'grid', 'inline-flex', 'inline-grid'].indexOf(disp[1]) === -1) continue;
  const line = CSS.slice(0, m.index).split('\n').length;
  rules.push({ sel, display: disp[1], line });
}

// A rule that shows a hideable region must be scoped away from the hidden state.
// `hidden` is a presentational attribute with a UA rule of `display: none`, and an
// author rule of any other display value beats it.
//
// Only a selector whose last compound part *is* the region counts, not one that merely
// names it: the children of a hidden region are hidden along with it, so guarding every
// descendant would be guarding against a failure that cannot happen.
const unguarded = rules.filter((r) => {
  // A grouped selector is several rules in one block, and the guard has to be judged
  // per branch rather than on the joined text - ".a, .context-panel" is not the
  // context-panel rule.
  const branches = r.sel.split(',').map((b) => b.trim()).filter(Boolean);
  return branches.some((b) => {
    const lastCompound = b.split(/\s+/).pop();
    return HIDEABLE.indexOf(addressed(lastCompound)) !== -1 && !b.includes(':not([hidden])');
  });
});

ok('every rule that shows a hideable region is scoped away from [hidden]',
  unguarded.length === 0,
  unguarded.map((r) => 'line ' + r.line + ': ' + r.sel).join(' | '));

// ---- the desk composition --------------------------------------------------
//
// The rail, the column and the stage, three tracks, until the context panel is
// asked for. The rail is the communities list, the column belongs to the open
// place, the stage is the conversation. A grid that has lost the rail track is a
// sidebar and a page again - the dashboard the client is not.
ok('the resting shell is the rail, the column and the stage',
  /\.ws\s*\{[^}]*grid-template-columns\s*:\s*var\(--rail-w\)\s+var\(--spine-w\)\s+minmax\(0,\s*1fr\)/.test(CSS),
  'the base grid is not the rail, column and stage the shell builds');

ok('the rail is the far-left column, not a second sidebar',
  /\.community-rail\s*\{[^}]*grid-column\s*:\s*1/.test(CSS)
  && /\.spine\s*\{[^}]*grid-column\s*:\s*2/.test(CSS)
  && /\.stage\s*\{[^}]*grid-column\s*:\s*3/.test(CSS),
  'the rail, the column and the stage do not occupy three tracks, so two regions share one');

ok('the context panel takes a column only while it is open',
  /\.ws\[data-context="open"\]\s*\{[^}]*var\(--context-w\)/.test(CSS),
  'no rule gives the open context panel a column of its own');

ok('a collapsed spine keeps its track rather than removing it',
  /\.ws\[data-spine="collapsed"\]\s*\{[^}]*grid-template-columns\s*:\s*var\(--rail-w\)\s+0\s+minmax\(0,\s*1fr\)/.test(CSS),
  'the stage would move out of its column when the spine collapses');

// The two stage-head controls, each shown at the size where it means something. The
// drawer control on a desk opens a drawer that is already a column; the collapse
// control on a phone collapses a drawer. Both are .icon-btn, so the hiding rule has to
// outrank .icon-btn's own display: grid - a bare .nav-toggle loses that tie and both
// controls end up on screen at every width.
ok('the collapse control is a desk affordance',
  /\.icon-btn\.spine-toggle\s*\{[^}]*display\s*:\s*none/.test(CSS)
  && /html\[data-presentation="desktop"\]\s+\.spine-toggle\s*\{[^}]*display\s*:\s*grid/.test(CSS),
  'the collapse control is shown where the spine is not a column, or loses the display tie to .icon-btn');

ok('the drawer control is a phone affordance',
  /\.icon-btn\.nav-toggle\s*\{[^}]*display\s*:\s*none/.test(CSS)
  && /html\[data-presentation="mobile"\]\s+\.nav-toggle\s*\{[^}]*display\s*:\s*grid/.test(CSS),
  'the drawer control is shown where the spine is a column, or loses the display tie to .icon-btn');

// ---- the phone composition -------------------------------------------------
//
// The phone is its own layer (css/mobile.css), keyed to
// <html data-presentation="mobile">, the breakpoint presentation.js owns and the
// bootstrap in index.html writes before the first paint. The desk layers carry no
// phone rules, so a phone rule cannot drift away from the drawer it describes.
// PHONE is the built stylesheet with that prefix removed, so the checks below
// read as the phone rules themselves.
const PHONE = CSS.replace(/html\[data-presentation="mobile"\]\s*/g, '');

// Drawer on a tab root, Back on a detail; #shell[data-depth] picks one.
ok('the back control is the phone detail affordance',
  /\.icon-btn\.nav-back\s*\{[^}]*display\s*:\s*none/.test(CSS)
  && /\.ws\[data-depth="detail"\]\s+\.nav-back\s*\{[^}]*display\s*:\s*grid/.test(PHONE),
  'Back is shown on a tab root, or loses the display tie to .icon-btn');

// A push and a back must not animate the same way.
ok('a phone screen slides in the direction it was navigated',
  /\.screen\.nav-forward\s*\{[^}]*animation/.test(PHONE)
  && /\.screen\.nav-back\s*\{[^}]*animation/.test(PHONE),
  'a push and a back would render the same, so the direction is not carried');

ok('the phone presentation is one layer, and it is the last one',
  /html\[data-presentation="mobile"\]/.test(CSS)
  && CSS.slice(CSS.lastIndexOf('/* ---- ')).startsWith('/* ---- mobile.css ---- */'),
  'the phone composition is not a single layer built after every desk layer');

ok('no phone layout is left behind in a width media query',
  !/@media\s*\(max-width:\s*(?:599\.98|600)px\)/.test(CSS),
  'a phone rule is still a max-width patch over the desk layers');

// The spine is off-canvas rather than a column, the tab bar is what carries the
// primary destinations, and the context panel is a sheet over the stage.
ok('the spine is off-canvas on a phone',
  /\.spine\s*\{[^}]*transform\s*:\s*translateX\(-104%\)/.test(PHONE),
  'the spine is still in the flow on a phone, so it and the stage share the width');

ok('the phone grid is one column',
  /\.ws\[data-spine="collapsed"\]\[data-context="open"\]\s*\{[^}]*grid-template-columns\s*:\s*minmax\(0,\s*1fr\)/.test(PHONE),
  'a phone still reserves a navigation column');

ok('the tab bar is anchored as the shell\'s last row on a phone',
  /\.tabbar\s*\{[^}]*grid-row\s*:\s*2/.test(CSS)
  && /\.tabbar\s*\{[^}]*grid-column\s*:\s*1\s*\/\s*-1/.test(CSS)
  && /\.tabbar\s*\{[^}]*display\s*:\s*flex/.test(PHONE),
  'the tab bar is not the full-width last row of the phone shell');

ok('the context panel is a sheet on a phone',
  /\.context-panel:not\(\[hidden\]\)\s*\{[^}]*inset\s*:\s*0/.test(PHONE),
  'the context panel still takes part of the width on a phone');

ok('below a wide desk the context panel overlays instead of taking a column',
  /@media\s*\(max-width:\s*1280px\)/.test(CSS)
  && /\.context-panel\s*\{[^}]*position\s*:\s*fixed/.test(CSS),
  'a narrow desk loses conversation width to a panel that could overlay it');

// The content phone composition: the controls a thumb lands on, fields that do
// not zoom, and a composer that clears the home indicator.
ok('a field is 16px on a phone, so iOS does not zoom when it takes focus',
  /\.input,\s*\.textarea,\s*\.select\s*\{[^}]*font-size\s*:\s*16px/.test(PHONE),
  'a phone field below 16px makes iOS zoom the page on focus');

ok('a dialog rises as a sheet on a phone rather than floating',
  /\.dialog\s*\{[^}]*border-radius:\s*var\(--radius-xl\)\s+var\(--radius-xl\)\s+0\s+0/.test(PHONE),
  'the dialog is still a floating card on a phone');

ok('a menu is clamped to the viewport it opens in',
  /\.menu\s*\{[^}]*max-width:\s*calc\(100vw/.test(PHONE),
  'an anchored menu can open wider than the phone');

ok('the composer sits above the tab bar and honours the bottom inset',
  /\.composer-slot\s*\{[^}]*env\(\s*safe-area-inset-bottom/.test(PHONE),
  'the composer does not clear the home indicator or the tab bar');

ok('the message actions open on a tap where there is no hover',
  /\.msg--hovered\s+\.msg-actions\s*\{[^}]*opacity\s*:\s*1/.test(CSS),
  'a phone cannot reach a message action that only opens on hover');

console.log(`\n  mobile layout check ${failures ? 'FAILED - ' + failures + ' problem(s)' : 'passed'}`);
process.exit(failures ? 1 : 0);

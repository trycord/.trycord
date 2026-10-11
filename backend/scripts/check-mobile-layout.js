// The mobile composition, measured from the built stylesheet.
//
// The failure this exists for: a `display` rule applied to a region the shell hides
// with the `hidden` attribute wins against the attribute itself, so a closed drawer
// scrim or a closed member panel stays on screen as an undismissable black box. Nothing
// in jsdom can see it - there is no layout engine - and nothing in the render check
// reads the stylesheet at all.
//
//   node scripts/check-mobile-layout.js

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const CSS = fs.readFileSync(path.join(REPO, 'frontend', 'css', 'app.css'), 'utf8');

// Regions the shell toggles with the `hidden` attribute rather than a class.
const HIDEABLE = [
  'nav-backdrop',
  'member-sidebar',
  'context-sidebar',
  'app-rail',
  'place-navigation',
  'mobile-tab-navigation',
];

let failures = 0;
const ok = (label, cond, detail) => {
  if (cond) { console.log('  ok   ' + label); }
  else { failures++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
};

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
  // per branch rather than on the joined text - ".a, .member-sidebar" is not the
  // member-sidebar rule.
  const branches = r.sel.split(',').map((b) => b.trim()).filter(Boolean);
  return branches.some((b) => {
    const lastCompound = b.split(/\s+/).pop();
    return HIDEABLE.some((h) => lastCompound === h) && !b.includes(':not([hidden])');
  });
});

ok('every rule that shows a hideable region is scoped away from [hidden]',
  unguarded.length === 0,
  unguarded.map((r) => 'line ' + r.line + ': ' + r.sel).join(' | '));

// On a phone the rail is not on screen at all, and the tab bar is what carries the
// destinations. Both have to be true, or the phone is a desktop with things missing.
const railHidden = /\.app-rail\s*\{[^}]*display\s*:\s*none/.test(CSS);
ok('the rail is off-screen on a phone', railHidden);

const tabBarFixed = /\.mobile-tab-navigation\s*\{[^}]*position\s*:\s*fixed/.test(CSS);
ok('the tab bar is anchored to the bottom on a phone', tabBarFixed);

// The context navigation becomes a sheet, not a column.
const ctxSheet = /\.context-sidebar\s*\{[^}]*position\s*:\s*fixed/.test(CSS);
ok('the context navigation is a sheet on a phone', ctxSheet);

console.log(`\n  mobile layout check ${failures ? 'FAILED - ' + failures + ' problem(s)' : 'passed'}`);
process.exit(failures ? 1 : 0);

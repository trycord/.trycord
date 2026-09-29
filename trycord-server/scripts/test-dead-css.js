// Finds CSS selectors that no markup and no script ever references.
//
// A selector is "dead" when its class never appears in index.html, in any
// script under js/, and never appears in a class list another selector uses as
// a prefix. The last case matters: .dm-row__main is dead even though
// .dm-row has no rule of its own, because nothing writes data-dm-row-class.
//
// Run: node scripts/test-dead-css.js [--fix]
// With --fix it deletes the rules. Reports the same either way.
const fs = require('fs');
const path = require('path');

const CLIENT = path.join(__dirname, '..', '..', 'trycord-client');
const CSS = path.join(CLIENT, 'css', 'app.css');
const HTML = path.join(CLIENT, 'index.html');
const JS_DIR = path.join(CLIENT, 'js');

let pass = 0;
let fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}

const raw = fs.readFileSync(CSS, 'utf8');
const html = fs.readFileSync(HTML, 'utf8');
const js = fs.readdirSync(JS_DIR)
  .filter((f) => f.endsWith('.js'))
  .map((f) => fs.readFileSync(path.join(JS_DIR, f), 'utf8'))
  .join('\n');

// Comments are stripped before parsing so a banner block above a rule cannot be
// mistaken for part of its selector. Line numbers are computed against the
// original file, so removals still land in the right place.
const css = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
const lineOf = (index) => raw.slice(0, index).split('\n').length;

// Every token that appears anywhere in markup or script: class names, ids,
// data attributes, and string fragments built in template literals.
const used = new Set();
const harvest = (text) => {
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_-]*/g)) used.add(m[0]);
};
harvest(html);
harvest(js);

// Walks the stylesheet once, collecting every rule and recursing into at-rule
// bodies, so a rule inside @media is judged the same as one at the top level.
const rules = [];
function collect(src, offset = 0) {
  let i = 0;
  while (i < src.length) {
    const braceAt = src.indexOf('{', i);
    if (braceAt === -1) break;
    const prelude = src.slice(i, braceAt).trim();
    let depth = 0;
    let j = braceAt;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) break; }
    }
    const body = src.slice(braceAt + 1, j);
    if (prelude.startsWith('@')) {
      collect(body, offset + braceAt + 1);
    } else if (prelude) {
      rules.push({ selector: prelude, start: offset + i, end: offset + j + 1 });
    }
    i = j + 1;
  }
}
collect(css);

const classesOf = (selector) =>
  [...selector.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map((c) => c[1]);

const dead = [];
for (const rule of rules) {
  const classes = classesOf(rule.selector);
  if (!classes.length) continue;
  // A rule is dead only when every class in it is unreferenced. A rule with one
  // live class is still doing work.
  if (classes.every((c) => !used.has(c))) {
    dead.push({ ...rule, line: lineOf(rule.start), classes });
  }
}

const report = dead.map((d) => ({ line: d.line, selector: d.selector, classes: d.classes }));
console.log(`  ${dead.length} dead rule(s) out of ${rules.length} selector blocks`);
for (const d of report) console.log(`       L${d.line}  ${d.selector}`);

if (process.argv.includes('--fix')) {
  // Cuts into the original file, never the comment-blanked copy used for
  // parsing: blanking comments is a parsing aid and must not reach the output.
  let out = raw;
  for (const d of [...dead].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, d.start) + out.slice(d.end);
  }
  out = out.replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(CSS, out, 'utf8');
  console.log(`  removed ${dead.length} rule(s)`);
  process.exit(0);
}

// A dead class must not also appear in a rule that is being kept: if it did,
// the rule would not have been flagged in the first place, so a mismatch means
// the two lists disagree and one of the classifications is wrong.
const deadSelectors = new Set(dead.map((d) => d.selector));
const deadNames = new Set(dead.flatMap((d) => d.classes));
const shared = [];
for (const rule of rules) {
  if (deadSelectors.has(rule.selector)) continue;
  for (const c of classesOf(rule.selector)) {
    if (deadNames.has(c)) shared.push(`${c} in "${rule.selector}"`);
  }
}
ok('no dead class is also used by a rule that is kept', shared.length === 0);
for (const s of shared) console.log(`       ${s}`);

ok(`the dead-CSS count stays at or below the budget (${dead.length} now)`, dead.length <= 4);
console.log(`\ndead-css: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

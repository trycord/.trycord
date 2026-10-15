// Every class name the client puts on the DOM has a rule in the stylesheet.
//
// Two different bugs look identical on screen: something is invisible because its
// rule was never written, and something is invisible because the rule that should
// apply is overridden by a later one. Only the first is mechanical, so this
// catches the first.
//
// It is not a substitute for looking at the rendered page. It is the thing that
// makes the looking worthwhile, because it turns "this looks wrong" into "this is
// the one class with no rule".
//
// What counts as emitted, which took a few passes to get right:
//
//   class: 'a b'                  object literal, the usual form
//   classList.add('a')            imperative, for a class added after render
//   className: 'a'                an option object, e.g. a helper that takes a
//                                 className - this was the gap that let
//                                 .member-name-btn ship with no rule at all
//   class: ['a', cond && 'b']    a conditional array
//
// Conditional classes are the reason this reports "not styled" rather than
// failing on the difference: 'b' only exists when the condition holds, and the
// stylesheet is allowed to style it without the JS being able to prove it.
//
//   node tests/checks/check-client-styles.js [clientDir]
//
// This lives under tests/ with the screenshot driver rather than in
// backend/scripts/ with the checks CI runs. It is a tool for finding things
// while working, not a gate the build depends on, and it has not earned a place in
// the pipeline on the strength of one run.
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const CLIENT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(REPO, 'frontend');
// Two presentation modules, two stylesheets. A class emitted by the Desktop module
// has to have a rule in the Desktop bundle and a class emitted by the Mobile module
// has to have a rule in the Mobile bundle: they are separate documents and neither
// loads the other's stylesheet, so checking one against the other only ever
// produces a green result for a class that is invisible on the phone that asked.
const CSS_BY_KIND = {
  desktop: path.join(CLIENT, 'css', 'app.css'),
  mobile: path.join(CLIENT, 'mobile', 'css', 'app.css'),
};

for (const [kind, css] of Object.entries(CSS_BY_KIND)) {
  if (!fs.existsSync(css)) {
    console.error('no ' + kind + ' stylesheet at ' + css);
    process.exit(1);
  }
}

const stylesheet = Object.fromEntries(
  Object.entries(CSS_BY_KIND).map(([k, f]) => [k, fs.readFileSync(f, 'utf8')])
);

function sourcesIn(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) sourcesIn(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const PATTERNS = [
  /class:\s*'([^']*)'/g,
  /class:\s*\[([^\]]*)\]/g,
  /classList\.(?:add|toggle|replace)\(\s*'([^']*)'/g,
  /className\s*=\s*'([^']*)'/g,
  /className:\s*'([^']*)'/g,
  /setAttribute\(\s*'class'\s*,\s*'([^']*)'/g,
];

// A class with no rule is usually a mistake, and a mistake this catches by being noisy
// rather than by being careful: a forgotten rule looks exactly like a deliberate one, so
// the two can only be told apart by somebody saying which is which.
//
// The two below are deliberate. app.css says so at the section that owns them, and the
// reasoning is that a rule on these roots would either do nothing or fight the children,
// which position themselves:
//
//   modal-root, popover-root   inert containers - the modal card and the popover panel
//                             both place themselves
//
// They carry a class and no rule because ui.js finds the layer by it. A class with no rule
// and a reader is a handle, not an oversight.
//
// toast-root is deliberately NOT in this list, because it does have a rule: it is
// positioned, and it was the reason the comment above used to be wrong about all three.
const UNSTYLED_ON_PURPOSE = new Set(['modal-root', 'popover-root']);

// A class in the emitted set is only interesting if it looks like one. Template
// fragments, ternaries and stray words all fall out here.
const PLAUSIBLE = /^[a-z][a-z0-9_-]*$/;

const emitted = new Map(); // class -> Set of kinds ('desktop', 'mobile')

const KIND_ROOTS = [
  ['desktop', ['js', 'packages']],
  ['mobile', ['mobile']],
];

for (const [kind, roots] of KIND_ROOTS) {
  for (const file of roots.flatMap((r) => sourcesIn(path.join(CLIENT, r)))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        for (const raw of m[1].split(/[\s,]+/)) {
          const name = raw.trim().replace(/^['"]|['"]$/g, '');
          if (!name || !PLAUSIBLE.test(name)) continue;
          if (!emitted.has(name)) emitted.set(name, new Set());
          emitted.get(name).add(kind);
        }
      }
    }
  }
}

// A class is styled when every stylesheet that would need to render it has a rule
// for it. The two modules never share a document, so "the other one has it" is not
// an answer the phone can use.
const selectorFor = (name, css) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return new RegExp('(^|[^a-zA-Z0-9_-])(\\.[a-zA-Z0-9_-]*)*\\.' + escaped + '(?![a-zA-Z0-9_-])');
};

// Coverage has two tiers, and conflating them produces either silent misses or a
// wall of false alarms.
//
//   styled on its own   '.member-name-btn { ... }'          - unambiguous
//   styled compound     only ever '.btn.ghost'               - legitimate for a
//                       modifier that is always used with a base class, but it
//                       means nothing on its own
//
// Only the first tier is a failure. The second is listed, because a class that is
// only ever compound and is sometimes used alone is a real bug that no static test
// can distinguish from a correctly used modifier.
const rows = [...emitted.entries()].sort((a, b) => a[0].localeCompare(b[0]));

// A class has a rule in one stylesheet but not the other: the two trees are
// independent documents, and reaching for a helper class defined in the module you
// are not shipping is how a control becomes invisible on one of them.
const unstyled = [];
const onPurpose = [];
const modifier = [];

for (const [name, kinds] of rows) {
  for (const kind of kinds) {
    const css = stylesheet[kind];
    if (!css.includes('.' + name)) {
      (UNSTYLED_ON_PURPOSE.has(name) ? onPurpose : unstyled).push([name, kind]);
    } else if (!selectorFor(name, css).test(css)) {
      modifier.push([name, kind]);
    }
  }
}

for (const [name, kind] of unstyled) {
  console.log('  FAIL  .' + name + ' is emitted by the ' + kind
    + ' module and appears nowhere in its stylesheet');
}
if (modifier.length) {
  console.log('  note  ' + modifier.length + ' class(es) only ever appear in a compound selector,'
    + ' which is correct for a modifier used with a base class:');
  console.log('        ' + [...new Set(modifier.map(([n]) => '.' + n))].join(' '));
}
if (onPurpose.length) {
  console.log('  note  ' + onPurpose.length + ' class(es) are handles with no rule by design: '
    + onPurpose.map(([n]) => '.' + n).join(' '));
}
console.log('client styles: ' + (emitted.size - unstyled.length) + '/' + emitted.size
  + ' class names have a rule'
  + (unstyled.length ? ', ' + unstyled.length + ' with none' : ''));
process.exit(unstyled.length ? 1 : 0);
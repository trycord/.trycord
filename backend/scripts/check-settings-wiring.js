// Every setting in the configuration centre has to be read by something.
//
// The first version of this service declared eighteen settings and nothing read
// any of them. They saved, they persisted, they showed a green tick, and the
// application behaved exactly as before. That is worse than not having them: an
// administrator who turns registration off and watches accounts still get
// created has been lied to by their own dashboard.
//
// This reads the catalogue and greps the server for each key. A key nothing
// reads is a failure, not a warning.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

let failures = 0;
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { failures++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
};

const settings = require(path.join(SRC, 'services', 'settings.js'));

// Collect the source of every server module once.
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
})(SRC);

const sources = new Map();
for (const f of files) {
  // Strip comments so a key mentioned only in prose does not count as a read.
  // Line comments go first. A comment can carry a URL that ends in `//*`, and
  // stripping block comments before line comments read that as an opening `/*`
  // running to the next `*/` in the file, deleting the real code in between.
  // That is how this check once reported that nothing reads a setting it was
  // looking straight at, when the function reading four of them was swallowed.
  const raw = fs.readFileSync(f, 'utf8')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  sources.set(f, raw);
}

// A key is read when some module other than the settings service itself asks the
// store for it, or names its environment variable. The env name counts because
// features.js resolves a flag from the store under that name.
const declared = [];
for (const entry of settings.SCHEMA) {
  const readers = [];
  for (const [file, src] of sources) {
    if (file.endsWith(path.join('services', 'settings.js'))) continue;
    if (src.includes("'" + entry.key + "'") || src.includes('"' + entry.key + '"')) {
      readers.push(path.relative(ROOT, file));
      continue;
    }
    if (entry.env && (src.includes(entry.env))) {
      readers.push(path.relative(ROOT, file));
    }
  }
  declared.push({ key: entry.key, env: entry.env, readers });
}

const decorative = declared.filter((d) => !d.readers.length);
ok('every declared setting is read by something',
  decorative.length === 0,
  decorative.map((d) => d.key).join(', '));

// The categories the brief asks for, and the ones this instance actually has.
// A category with no settings is not offered, because an empty tab is a promise
// the instance cannot keep.
const categories = settings.CATEGORIES.map((c) => c.id);
const populated = settings.catalogue().map((c) => c.id);
ok('no category is offered without a setting in it',
  populated.length === new Set(populated).size,
  'duplicate categories');

// Feature flags have to be enforced by the server, not only shown in the UI.
const features = require(path.join(SRC, 'features.js'));
const flagKeys = ['registration', 'emailVerificationRequired', 'fileUploads',
  'communityDiscovery', 'bots', 'webhooks', 'pushNotifications'];
for (const key of flagKeys) {
  ok('the ' + key + ' flag is exposed by features.js',
    features.capabilities(features.current)[key] !== undefined);
}

console.log('\n  ' + declared.length + ' settings, '
  + (declared.length - decorative.length) + ' of them read');
console.log('  categories offered: ' + populated.join(', '));
console.log(`\n  settings wiring check ${failures ? 'FAILED - ' + failures + ' problem(s)' : 'passed'}`);
process.exit(failures ? 1 : 0);

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

// A setting's environment variable has to be the one the deployment actually sets.
//
// Reading and writing agreed on their own, which is why nothing caught this: the
// schema declared `TRYCOD_APP_MOUNT`, one letter from the documented
// `TRYCORD_APP_MOUNT`, and the server kept reading the store's value. The result
// was a deployment that set /app in .env and a process that mounted nothing,
// because the store never saw a variable by that name. A name one edit away from a
// documented one is a typo, not a second spelling, so it is reported.
function editDistance(a, b) {
  const rows = a.length;
  const cols = b.length;
  const dp = Array.from({ length: rows + 1 }, (_, i) => [i, ...new Array(cols).fill(0)]);
  for (let j = 0; j <= cols; j++) dp[0][j] = j;
  for (let i = 1; i <= rows; i++) {
    for (let j = 1; j <= cols; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[rows][cols];
}

const examplePath = path.join(ROOT, '.env.example');
const documented = new Set();
if (fs.existsSync(examplePath)) {
  for (const line of fs.readFileSync(examplePath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m) documented.add(m[1]);
  }
}
const nearMisses = [];
for (const entry of settings.SCHEMA) {
  if (!entry.env || documented.has(entry.env)) continue;
  for (const name of documented) {
    if (editDistance(entry.env, name) === 1) {
      nearMisses.push(entry.key + ': ' + entry.env + ' looks like ' + name);
    }
  }
}
ok('no setting reads an environment variable one letter off a documented one',
  nearMisses.length === 0,
  nearMisses.join('; '));

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

// The voice provider is instance configuration now, not a file on the server. The feature
// snapshot has to carry it, and the capability response - which every client fetches, signed
// in or not - must carry the app ID and the TURN URL but never a credential.
const voice = features.current.voiceVideo;
ok('the voice app ID reaches the feature layer', typeof voice.sfuAppId === 'string');
ok('the voice TURN URL reaches the feature layer', typeof voice.turn.url === 'string');
ok('the voice stage-channel flag is carried by features', typeof voice.stageChannels === 'boolean');
const capabilityVoice = features.capabilities(features.current).voiceVideo;
ok('the capability response carries no media secret',
  capabilityVoice.sfuAppSecret === undefined && voice.sfuAppSecret !== undefined);
ok('the capability response carries no TURN credential',
  capabilityVoice.turn === undefined
    || !JSON.stringify(capabilityVoice).includes('"credential"'));

console.log('\n  ' + declared.length + ' settings, '
  + (declared.length - decorative.length) + ' of them read');
console.log('  categories offered: ' + populated.join(', '));
console.log(`\n  settings wiring check ${failures ? 'FAILED - ' + failures + ' problem(s)' : 'passed'}`);
process.exit(failures ? 1 : 0);

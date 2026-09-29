// Parses every web-client module as an ES module and fails on any that does not
// parse.
//
// The reason this exists in its own file: `node --check some.js` reports
// SUCCESS for a .js file that contains import statements, even when the body
// has a duplicate declaration or an unbalanced call. Verified: the same body
// fails as .mjs and passes as .js. So `node --check` over the client is not a
// check at all, and CI ran it.
//
// A duplicate `const serverId` shipped to main that way, in 44e1ba8, and the
// app would not start. The .mjs extension forces module parsing, which does
// report it.
//
//   node scripts/check-client-modules.js [dir ...]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const DIRS = process.argv.length > 2 ? process.argv.slice(2) : ['trycord-client/js'];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-modules-'));
const probe = path.join(tmp, 'probe.mjs');
let checked = 0;
const broken = [];

for (const rel of DIRS) {
  const dir = path.resolve(REPO, rel);
  if (!fs.existsSync(dir)) {
    console.error('missing directory: ' + dir);
    process.exit(1);
  }
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const p = path.join(dir, name);
    // A test or fixture is not shipped to a browser, so a top-level await or a
    // CommonJS require in one is legitimate. Only shipped modules are held to
    // browser-module rules, and every file in trycord-client/js is shipped.
    fs.copyFileSync(p, probe);
    const r = spawnSync(process.execPath, ['--check', probe], { encoding: 'utf8' });
    checked++;
    if (r.status !== 0) {
      const err = String(r.stderr || '').split('\n').find((l) => /Error/.test(l)) || 'parse error';
      const at = String(r.stderr || '').split('\n').find((l) => /\^/.test(l)) || '';
      broken.push({ file: path.relative(REPO, p), err: err.trim(), at: at.trim() });
    }
  }
}
fs.rmSync(tmp, { recursive: true, force: true });

for (const b of broken) console.log('  FAIL  ' + b.file + '\n        ' + b.err + '\n        ' + b.at);
console.log('client modules: ' + (checked - broken.length) + '/' + checked + ' parse');
process.exit(broken.length ? 1 : 0);

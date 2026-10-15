// Two frontends, one platform: the boundary, enforced.
//
// The directive that split the client into Desktop and Mobile says a module is
// not independent because it sits in its own directory - the dependency graph has
// to show it. A directory layout drifts the first time someone reaches across for
// a helper, and the crossing is invisible: the import resolves, the build passes,
// and the two "independent" frontends are one tree again.
//
// So this reads every shipped module under the three client roots and resolves
// every local import - static and dynamic - to the root it lands in:
//
//   packages/  shared, nonvisual. Imports only itself.
//   js/        the Desktop presentation. Imports itself and packages/.
//   mobile/    the Mobile presentation. Imports itself and packages/.
//
// Desktop may not import mobile; mobile may not import desktop; neither may live
// in packages/. The check resolves by path, not by naming convention, so a
// `../` that reaches the wrong root is caught wherever it is written.
//
//   node scripts/check-frontend-modules.js

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const FRONTEND = path.join(REPO, 'frontend');

// root name -> { dir, may import these roots }
const ROOTS = [
  { name: 'packages', dir: path.join(FRONTEND, 'packages'), mayImport: ['packages'], required: true },
  { name: 'desktop', dir: path.join(FRONTEND, 'js'), mayImport: ['desktop', 'packages'], required: true },
  { name: 'mobile', dir: path.join(FRONTEND, 'mobile'), mayImport: ['mobile', 'packages'], required: false },
];

let failures = 0;
let assertions = 0;
const ok = (label, cond, detail) => {
  assertions++;
  if (cond) console.log('  ok   ' + label);
  else { failures++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
};

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Which root an absolute path belongs to, or null when it is outside every root.
function rootOf(file) {
  for (const r of ROOTS) {
    const rel = path.relative(r.dir, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return r;
  }
  return null;
}

function rel(file) {
  return path.relative(REPO, file).split(path.sep).join('/');
}

// Every local specifier in a module: re-exports, side-effect imports and dynamic
// imports all reach another module, and all three can cross a boundary.
function localSpecifiers(src) {
  const specs = [];
  const push = (s) => { if (s && s.startsWith('.')) specs.push(s); };
  for (const m of src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) push(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1]);
  for (const m of src.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) push(m[1]);
  return specs;
}

const crossings = [];
const dangling = [];
let files = 0;
const present = [];

for (const r of ROOTS) {
  const where = 'frontend/' + (r.name === 'desktop' ? 'js' : r.name);
  const exists = fs.existsSync(r.dir);
  if (r.required) ok('the ' + r.name + ' module root exists (' + where + ')', exists, r.dir);
  else if (exists) ok('the mobile module root is present (' + where + ')', true);
  if (!exists) {
    if (!r.required) console.log('  ..   the mobile module root is not built yet');
    continue;
  }
  present.push(r.name);

  for (const file of walk(r.dir)) {
    files++;
    const src = fs.readFileSync(file, 'utf8');
    for (const spec of localSpecifiers(src)) {
      const target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target)) { dangling.push([rel(file), spec]); continue; }
      const targetRoot = rootOf(target);
      if (!targetRoot) continue; // outside every client root (e.g. an asset URL)
      if (targetRoot.name === r.name) continue; // same module: always allowed
      if (r.mayImport.includes(targetRoot.name)) continue;
      crossings.push([rel(file), spec, r.name + '/' + ' -> ' + targetRoot.name + '/']);
    }
  }
}

ok('every local import in a module root points at a file that exists',
  dangling.length === 0, dangling.map(([f, s]) => f + ' -> ' + s).join(', '));
ok('no module imports across the desktop/mobile boundary, and packages stays package-only',
  crossings.length === 0, crossings.map(([f, s, where]) => f + ' ' + s + ' (' + where + ')').join(', '));

console.log('');
console.log('  frontend modules: ' + files + ' file(s) across ' + present.join(', ')
  + (present.includes('mobile') ? '' : ' (mobile not built yet)')
  + (failures ? '' : ', every import stays inside its module'));
process.exit(failures ? 1 : 0);

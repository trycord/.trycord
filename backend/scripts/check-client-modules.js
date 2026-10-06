// Parses every web-client module and resolves its imports.
//
// Two failures are caught, because both reach production as "Trycord could not
// start" and neither is a syntax error:
//
//   1. Parse errors. `node --check some.js` reports SUCCESS for a .js file that
//      contains import statements, even when the body has a duplicate
//      declaration or an unbalanced call. Verified: the same body fails as .mjs
//      and passes as .js. A duplicate `const serverId` shipped to main that way,
//      in 44e1ba8. The .mjs extension forces module parsing, which reports it.
//
//   2. Imports that name an export the target module does not have. This is a
//      link-time error, so parsing is perfectly happy and the app still dies on
//      load. links.js imported a named `state` from a module that only default
//      exports it, and nothing else in the pipeline noticed.
//
//   node scripts/check-client-modules.js [dir ...]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { stripCommentsOnly } = require('./strip-comments.mjs');

const REPO = path.join(__dirname, '..', '..');
const DIRS = process.argv.length > 2 ? process.argv.slice(2) : ['frontend/js'];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-modules-'));
const probe = path.join(tmp, 'probe.mjs');
let checked = 0;
const broken = [];
const allSources = new Map();
const stripped = new Map();

for (const rel of DIRS) {
  const dir = path.resolve(REPO, rel);
  if (!fs.existsSync(dir)) {
    console.error('missing directory: ' + dir);
    process.exit(1);
  }
  for (const p of jsFilesUnder(dir)) {
    // A test or fixture is not shipped to a browser, so a top-level await or a
    // CommonJS require in one is legitimate. Only shipped modules are held to
    // browser-module rules, and every file in frontend/js is shipped.
    const src = fs.readFileSync(p, 'utf8');
    allSources.set(p, src);
    stripped.set(p, stripCommentsOnly(src));
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

// --- import resolution ---------------------------------------------------
//
// Collects the export names a module provides, then checks every relative
// import against them. Only relative specifiers are resolved: a bare specifier
// is a dependency or a built-in, and the bundler or the browser owns those.
function exportsOf(src) {
  const names = new Set();
  let hasDefault = false;
  const add = (list) => {
    for (const raw of list.split(',')) {
      const part = raw.trim().replace(/^type\s+/, '');
      if (!part) continue;
      const as = /\bas\s+([A-Za-z0-9_$]+)$/.exec(part);
      names.add(as ? as[1] : part);
    }
  };
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) add(m[1]);
  for (const m of src.matchAll(/^export\s+default\b/gm)) hasDefault = true;
  // `export * from './x.js'` re-exports everything the target has.
  return { names, hasDefault };
}

// Every .js file under a directory, recursively. The client grew a pages/
// subdirectory and a flat readdir indexed none of it, so a page module importing a
// sibling was reported as "module not found" for a file sitting right there.
function jsFilesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name === 'node_modules') continue;
    if (entry.isDirectory()) out.push(...jsFilesUnder(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out.sort();
}


const reexports = new Map();
for (const rel of DIRS) {
  const dir = path.resolve(REPO, rel);
  for (const p of jsFilesUnder(dir)) {
    const src = fs.readFileSync(p, 'utf8');
    const info = exportsOf(src);
    info.star = [...src.matchAll(/^export\s+\*\s+from\s+['"](\.[^'"]+)['"]/gm)].map((m) => m[1]);
    reexports.set(p, info);
  }
}

// Follows export * chains so a name re-exported through another module counts.
function provides(p, name, seen) {
  const info = reexports.get(p);
  if (!info) return true; // not a local module
  if (info.names.has(name)) return true;
  const s = seen || new Set();
  for (const spec of info.star) {
    const t = path.resolve(path.dirname(p), spec);
    if (s.has(t)) continue;
    s.add(t);
    if (provides(t, name, s)) return true;
  }
  return false;
}

const unresolved = [];
for (const [file] of allSources) {
  const src = stripped.get(file);
  const dir = path.dirname(file);
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s*['"](\.[^'"]+)['"]/g)) {
    const clause = m[1].trim();
    const spec = m[2];
    const target = path.resolve(dir, spec);
    const info = reexports.get(target);
    if (!info) {
      unresolved.push([path.relative(REPO, file), spec, 'module not found']);
      continue;
    }
    // Default import, when the clause does not start with '{'.
    const def = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, '').trim();
    if (def && !def.startsWith('*') && !info.hasDefault) {
      unresolved.push([path.relative(REPO, file), spec, 'no default export, imported as ' + def]);
    }
    const braced = /\{([\s\S]*)\}/.exec(clause);
    if (braced) {
      for (const raw of braced[1].split(',')) {
        const part = raw.trim().replace(/^type\s+/, '');
        if (!part) continue;
        const as = /\bas\s+([A-Za-z0-9_$]+)$/.exec(part);
        const name = as ? part.replace(/\s+as\s+.*$/, '').trim() : part;
        if (!name) continue;
        if (!provides(target, name)) {
          unresolved.push([path.relative(REPO, file), spec, 'no export named ' + JSON.stringify(name)]);
        }
      }
    }
  }
}

for (const b of broken) console.log('  FAIL  ' + b.file + '\n        ' + b.err + '\n        ' + b.at);
for (const [f, spec, why] of unresolved) console.log('  FAIL  ' + f + '\n        ' + why + ' from ' + spec);
console.log('client modules: ' + (checked - broken.length) + '/' + checked + ' parse, '
  + (unresolved.length ? unresolved.length + ' unresolved import(s)' : 'all relative imports resolve'));
process.exit(broken.length || unresolved.length ? 1 : 0);

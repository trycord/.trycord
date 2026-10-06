#!/usr/bin/env node
'use strict';

// A route registered twice inside one module is unreachable the second time.
//
// Express takes the first handler that responds, so a duplicate is not a
// double registration - it is dead code sitting next to the live one, in the same
// list, often looking identical to it. /support and /security were both listed as
// editable pages and then again as plain files, and the second listing could never
// run while reading exactly like the one that did.
//
// Cross-module overlap is not checked: two routers mounted at the same prefix is
// ordinary (Express composes them), and so is a route declared in one file and
// re-exported. Only same-file duplication is unambiguous.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Matches router.get('/x') and app.get('/x') but not a call whose first argument is
// a variable - those cannot be compared without evaluating the module.
const CALL = /(?:^|[^\w.])(router|app)\.(get|post|put|patch|delete)\(\s*'([^']*)'/g;

let files = 0;
const findings = [];

for (const file of walk(SRC)) {
  files++;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const seen = new Map();
  lines.forEach((line, i) => {
    CALL.lastIndex = 0;
    let m;
    while ((m = CALL.exec(line))) {
      const key = m[2].toUpperCase() + ' ' + m[3];
      if (seen.has(key)) findings.push({ file, key, first: seen.get(key), again: i + 1, text: line.trim() });
      else seen.set(key, i + 1);
    }
  });
}

const rel = (f) => path.relative(path.join(__dirname, '..', '..'), f);

if (findings.length) {
  console.error(`server routes check FAILED - ${findings.length} duplicate registration(s):`);
  for (const f of findings) {
    console.error(`  ${rel(f.file)}:${f.again}  ${f.key}`);
    console.error(`    already registered at line ${f.first}`);
    console.error(`    ${f.text.slice(0, 100)}`);
  }
  process.exit(1);
}

console.log(`server routes check passed (${files} modules, no route registered twice in a module)`);
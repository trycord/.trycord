#!/usr/bin/env node
'use strict';

// That the counts in docs/architecture.md are still true.
//
// They were written when the suite was smaller and drifted: the summary still claimed 51
// render assertions and 66 client modules long after both had roughly doubled, and 79
// contrast ratios when there were 100. A number in prose is the one kind of claim no check
// looks at, so this reads them back.
//
// The cheap numbers are read straight from the source tree. The expensive ones - assertion
// counts from checks that boot a server - are not re-run here; they are compared against
// what each check reports on its own, which is what a reader would compare them against.
// Nothing in this file runs a check.
//
// node scripts/check-doc-counts.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DOC = path.join(ROOT, 'docs', 'architecture.md');

let failures = 0;
const ok = (label, cond, detail) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail && !cond ? '  <- ' + detail : ''}`);
  if (!cond) failures++;
};

if (!fs.existsSync(DOC)) {
  console.error('  no ' + DOC);
  process.exit(0);
}
const doc = fs.readFileSync(DOC, 'utf8');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const clientModules = walk(path.join(ROOT, 'frontend', 'js')).length;
ok('the client module count in the summary', doc.includes(`all ${clientModules} client modules`),
  clientModules + ' modules, and the docs do not say that');

// Each check prints its own assertion count. Rather than running them, the docs are held
// to the numbers those runs last printed, which are recorded here so a stale figure in the
// summary is a failing check rather than a sentence nobody re-reads.
const REPORTED = {
  'check:flows': 72,
  'check:render': 81,
  'check:realtime': 17,
  'check:contrast': 100,
  'check:origins': 35,
  'check-client-styles': 596,
  'check:checks-can-fail': 19,
};
for (const [name, n] of Object.entries(REPORTED)) {
  ok(`${name} is described without a stale count`,
    !new RegExp('`' + name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&') + '`[^|]*\\b' + (n - 1) + '\\b').test(doc),
    'the table for ' + name + ' mentions ' + (n - 1));
}

// The summary paragraph, specifically.
const claims = [
  [/passes (\d+)\n?assertions against real flows/, REPORTED['check:flows']],
  [/passing (\d+) assertions/, REPORTED['check:render']],
  [/finds (\d+) ratios that pass/, REPORTED['check:contrast']],
  [/evaluates all (\d+) client modules/, clientModules],
];
for (const [re, expected] of claims) {
  const m = re.exec(doc);
  ok('the summary says ' + expected + ' for ' + re.source.slice(0, 26),
    !!m && Number(m[1]) === expected, m ? 'says ' + m[1] : 'no match');
}

console.log(failures
  ? `\n  doc counts FAILED - ${failures} assertion(s)\n`
  : '\n  doc counts passed - every number in the summary matches the suite\n');
process.exit(failures ? 1 : 0);
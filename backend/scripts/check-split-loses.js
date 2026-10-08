#!/usr/bin/env node
'use strict';

// Every module-scope name a file declared must survive being split into a directory.
//
// This exists because of a bug that ran for a whole session undetected. Splitting
// privacy-ui.js into privacy/ dropped seven module-scope declarations - SCOPE_HELP,
// scopeText, scopeOptions, PREF_LABELS, PREF_HINTS, labelToMinutes, minutesToLabel - so
// settings.privacy and settings.notifications rendered "scopeOptions is not defined" and
// nothing else. The public/ split dropped one more, and the components/ split dropped the
// authenticated-image cache out from under the two functions that use it.
//
// Nothing caught them:
//
//   - check-client-bindings.js asks about names the repository exports, and these were
//     private to one file
//   - check-client-modules.js resolves the specifier and parses; a file that imports four
//     modules correctly and reads a fifth name from nowhere parses fine
//   - check-render.js rendered all 40 routes and passed 81 assertions. A view carrying an
//     error block has a heading, is not empty, and usually has a button on it - which is
//     everything that check used to ask for
//
// What caught it was the layout check, and by accident: an error message contains a file:
// URL, so it is wider than a phone, so four surfaces "scrolled sideways". A wiring fault
// showing up as a layout symptom.
//
// So this compares the committed version of each split file against the union of what it
// became, and reports a name that is in neither - dropped - or in more than one -
// duplicated, which is a copy that survived alongside the moved original.
//
// Each entry names the revision its split happened in, because HEAD is the re-export
// surface rather than the original.
//
// Usage: node scripts/check-split-loses.js

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// revision, file it was split from, what it became
// The commit each file was split in, so the revision to compare against is its parent -
// the state where the file still held everything. Full hashes rather than HEAD~n, which
// walks as soon as anything else is committed on top.
const SPLITS = [
  { rev: '64b87717', was: 'frontend/js/ui.js', became: 'frontend/js/ui' },
  { rev: '4e12f64a', was: 'frontend/js/theme.js', became: 'frontend/js/theme' },
  { rev: '57172415', was: 'frontend/js/shell.js', became: 'frontend/js/shell' },
  { rev: '89000c3a', was: 'frontend/js/admin/admin.js', became: 'frontend/js/admin' },
  { rev: '1e096bca', was: 'frontend/js/admin/pages.js', became: 'frontend/js/admin/pages' },
  { rev: '343bec9a', was: 'frontend/js/privacy-ui.js', became: 'frontend/js/privacy' },
  { rev: '343bec9a', was: 'frontend/js/public/public.js', became: 'frontend/js/public' },
  { rev: '89000c3a', was: 'frontend/js/components.js', became: 'frontend/js/components' },
];

function at(rev, rel) {
  return execFileSync('git', ['show', rev + ':' + rel], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 8 << 20,
  });
}

function moduleScope(src) {
  src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const names = new Set();
  for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  return names;
}

function read(dir) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  if (!fs.statSync(full).isDirectory()) return [full];
  return fs.readdirSync(full).filter((f) => f.endsWith('.js')).map((f) => path.join(full, f));
}

const findings = [];
let compared = 0;

for (const { rev, was, became } of SPLITS) {
  let original;
  try {
    original = at(rev, was);
  } catch {
    continue; // that revision no longer has it; nothing to compare against
  }
  // The root is part of the result: a name is accounted for if it is in the directory or
  // still in the file it became. When the directory contains the root - admin.js became
  // admin/, so admin/admin.js is inside it - adding the root again would count every
  // surviving declaration as a duplicate.
  const root = path.join(ROOT, was);
  const inside = read(became).filter((f) => f !== root);
  const files = inside.includes(root) || !fs.existsSync(path.join(ROOT, became))
    ? inside
    : [...inside, root];
  if (!files.every((f) => fs.existsSync(f))) continue;
  compared++;

  const before = moduleScope(original);
  const seen = new Map();
  for (const f of files) {
    for (const n of moduleScope(fs.readFileSync(f, 'utf8'))) {
      if (!seen.has(n)) seen.set(n, []);
      seen.get(n).push(path.relative(ROOT, f));
    }
  }
  // Names the split deliberately renamed or removed. Each was a decision, not a loss:
  // `legal` became `versions` behind legalVersions(); EXTERNAL_SECTIONS had no reader.
  const REMOVED = { legal: 'renamed to versions, behind legalVersions()',
    EXTERNAL_SECTIONS: 'had no reader anywhere in the client',
    statusChip: 'moved to components.js - a status badge is not an admin concept',
    summaryOf: 'the bbcode bar labels its own buttons; summaryOf had no reader',
    AUTH_BG: 'the stylesheet applies this background itself, at app.css:3135',
  };
  for (const n of before) {
    if (!seen.has(n) && REMOVED[n]) continue;
    const homes = seen.get(n) || [];
    if (!homes.length) {
      findings.push(`${was}: ${n} was declared and is in none of ${became}/ or the root`);
    } else if (homes.length > 1) {
      findings.push(`${was}: ${n} is declared in ${homes.length} files - ${homes.join(', ')}`);
    }
  }
}

if (findings.length) {
  console.error(`\n  split loss check FAILED - ${findings.length} module-scope name(s) lost or duplicated\n`);
  for (const f of findings) console.error(`  ${f}`);
  console.error('');
  process.exit(1);
}
// Comparing nothing is not passing. This check reads the committed version of each file
// from before its split, so a shallow clone makes every `git show` throw, every split
// `continue`, and the check report success while having verified no split at all. Found by
// check-checks-can-fail.js, which runs this against a copy of the tree precisely because a
// copy has no history.
//
// Two situations, two answers. No repository at all - a source tarball, a Docker build
// context, `git archive` - means the check cannot run, and saying so and exiting clean is
// right, because there is no defect there to find. A repository that is present but cannot
// produce the revisions means CI checked out too little, and that is a failure.
const inARepository = fs.existsSync(path.join(ROOT, '.git'))
  || fs.existsSync(path.join(ROOT, '..', '.git'));

if (!compared) {
  if (!inARepository) {
    console.log(`split loss check SKIPPED - there is no repository here, so there is no`
      + ` history to compare against (${SPLITS.length} splits). Each one is compared as it`
      + `\n  was before the split, so this needs a clone rather than an export.`);
    process.exit(0);
  }
  console.error('\n  split loss check FAILED - 0 of ' + SPLITS.length
    + ' splits could be compared.\n');
  console.error('  It reads each file as it was before its split, so it needs the commits. A'
    + ' shallow\n  clone has the repository but not the history, so every comparison throws'
    + ' and the\n  check passes on nothing. CI needs fetch-depth: 0.\n');
  process.exit(1);
}
console.log(`split loss check passed (${compared} splits, every module-scope declaration is accounted for)`);
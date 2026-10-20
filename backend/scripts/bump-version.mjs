#!/usr/bin/env node
'use strict';

// Bump the version, and say what the change was.
//
// The rule:
//
//   a fix             the patch number goes up by one      3.0.0 -> 3.0.1
//   a minor update    the minor number goes up by one tenth 3.0.0 -> 3.0.10
//   a major update    the major number goes up by one       3.0.0 -> 4.0.0
//
// A minor update is a tenth rather than a hundredth because a release that
// adds a feature is a tenth of a release, and a release that fixes a thing
// is a hundredth of one. The minor number therefore runs 0 to 9 and then
// carries into the next tenth, so 3.0.9 is the last tenth before 3.0.10.
//
// The version is written in the package manifest and read from there by
// everything that reports it, so there is one place to change.
//
//   node scripts/bump-version.mjs fix "the context menu closed on its own scroll"
//   node scripts/bump-version.mjs minor "community onboarding"
//   node scripts/bump-version.mjs major "the settings and the instance admin were made one"
//
// It refuses to run on a tree that is not committed, so a version is never
// claimed for work that is not in the history, and it prints the line it
// added to the changelog so the entry can be read before it is committed.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const MANIFEST = path.join(ROOT, 'backend', 'package.json');
const CHANGELOG = path.join(ROOT, 'public', 'changelog.html');

// What each kind of change does to the number.
const KINDS = {
  fix: { patch: 1, minor: 0, major: 0, label: 'Fixed' },
  minor: { patch: 0, minor: 1, major: 0, label: 'Added' },
  major: { patch: 0, minor: 0, major: 1, label: 'Changed' },
};

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function readVersion() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  return String(manifest.version || '0.0.0');
}

function bump(version, kind) {
  const rule = KINDS[kind];
  if (!rule) throw new Error('unknown kind: ' + kind);
  const parts = String(version).split('.').map((n) => Number(n) || 0);
  let [major, minor, patch] = parts;

  if (rule.major) { major += rule.major; minor = 0; patch = 0; }
  else if (rule.minor) {
    minor += rule.minor;
    // The minor number runs to nine and then carries, because a minor update
    // is a tenth of a release.
    if (minor > 9) { major += Math.floor(minor / 10); minor = minor % 10; }
    patch = 0;
  } else {
    patch += rule.patch;
    if (patch > 99) { minor += 1; patch = 0; }
  }
  return [major, minor, patch].join('.');
}

function writeVersion(version) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  manifest.version = version;
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

  // The lock file carries the version too, and a lock file that disagrees
  // with the manifest is a lock file that will be rewritten by the next
  // install and confuse everybody in between.
  const lock = path.join(ROOT, 'backend', 'package-lock.json');
  if (fs.existsSync(lock)) {
    const text = fs.readFileSync(lock, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed.version) parsed.version = version;
    if (parsed.packages && parsed.packages[''] && parsed.packages[''].version) {
      parsed.packages[''].version = version;
    }
    fs.writeFileSync(lock, JSON.stringify(parsed, null, 2) + '\n');
  }
}

function addToChangelog(version, kind, summary) {
  const rule = KINDS[kind];
  const html = fs.readFileSync(CHANGELOG, 'utf8');

  const day = new Date().toISOString().slice(0, 10);
  const entry = [
    '        <li><strong>' + version + '</strong> — ' + rule.label + ': ' + summary + '</li>',
  ].join('\n');

  // The list of changes for the current release, at the top of the document.
  //
  // The document is a timeline of releases, so the entry goes into the list
  // of the newest one - the first list in the document.
  const at = html.indexOf('<ul>');
  if (at === -1) {
    console.log('the changelog has no list to add to; the version was bumped and '
      + 'the entry has to be written by hand.');
    return null;
  }
  const insertAt = at + '<ul>'.length;
  const next = html.slice(0, insertAt) + '\n' + entry + html.slice(insertAt);
  fs.writeFileSync(CHANGELOG, next);

  // The sentence that says what the current release is. A version that is
  // written in two places and disagrees with itself is a version nobody can
  // rely on.
  const said = /The current release is <strong>[^<]*<\/strong>/;
  if (said.test(next)) {
    fs.writeFileSync(CHANGELOG, next.replace(said,
      'The current release is <strong>' + version + '</strong>'));
  }
  return entry;
}

// The changes, in the order they happened.
//
// Each is `kind:summary`, and the version moves once per change: a fix
// takes the patch number up by one, a minor update takes the minor number up
// by a tenth, a major update takes the major number up by one.
//
//   node scripts/bump-version.mjs fix:"the menu closed on its own scroll" minor:"community onboarding"
//
// A change with no summary is refused: a version with no note is a version
// nobody can read.
const changes = [];
for (const argument of process.argv.slice(2)) {
  const at = argument.indexOf(':');
  const kind = at === -1 ? argument : argument.slice(0, at);
  const summary = at === -1 ? '' : argument.slice(at + 1).trim();
  if (!KINDS[kind]) {
    console.error('unknown kind: ' + kind);
    console.error('usage: node scripts/bump-version.mjs <fix|minor|major>:"<what changed>" ...');
    process.exit(2);
  }
  if (!summary) {
    console.error('say what changed: ' + kind + ' with no note is a version nobody can read');
    process.exit(2);
  }
  changes.push({ kind, summary });
}
if (!changes.length) {
  console.error('usage: node scripts/bump-version.mjs <fix|minor|major>:"<what changed>" ...');
  process.exit(2);
}

// A version is a claim about the history, so it is only claimed when the
// history holds the work.
try {
  const status = git(['status', '--porcelain']);
  if (status) {
    console.error('the tree has changes that are not committed:\n' + status);
    console.error('commit the work first, then bump the version for it.');
    process.exit(2);
  }
} catch (error) {
  // A tree with no git is not a tree this tool can make claims about.
  console.error('this does not look like a git checkout: ' + error.message);
  process.exit(2);
}

const before = readVersion();
let version = before;
const entries = [];
for (const change of changes) {
  version = bump(version, change.kind);
  const entry = addToChangelog(version, change.kind, change.summary);
  entries.push({ version, kind: change.kind, summary: change.summary, entry });
}
writeVersion(version);

console.log(before + ' -> ' + version);
for (const one of entries) {
  console.log('  ' + one.version + '  ' + KINDS[one.kind].label + ': ' + one.summary);
}
console.log('the manifest and the changelog are updated; commit them with the change.');

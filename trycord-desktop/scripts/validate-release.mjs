#!/usr/bin/env node
'use strict';

// The built artefacts, checked before anything is published.
//
// The gate refuses a release whose artefacts do not say what they should. It
// runs after the build and before the publish, so a broken build never reaches
// a release page.
//
// The checks:
//
//   - the installer is there, and it is not empty;
//   - the update metadata is there, because the updater reads it and a release
//     without it installs and then cannot update;
//   - the version in the artefacts is the version in package.json, because a
//     tag once shipped a build of a different version;
//   - the version in package.json is the version in the git tag, because every
//     other check compares the artefacts to package.json and none compared
//     package.json to the tag.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');
const DIST = path.join(DESKTOP, 'dist');

const failures = [];

function ok(condition, message) {
  if (!condition) failures.push(message);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

const manifest = readJson(path.join(DESKTOP, 'package.json'));
ok(manifest && manifest.version, 'the package manifest has no version');
const version = manifest ? manifest.version : '';

const files = listFiles(DIST);
ok(files.length > 0, 'the build produced nothing in ' + DIST);

const installers = files.filter((file) => /\.(exe|AppImage|dmg)$/i.test(file));
ok(installers.length > 0, 'there is no installer in ' + DIST);
for (const file of installers) {
  ok(fs.statSync(file).size > 1024 * 1024,
    'the installer is too small to be a build: ' + path.basename(file));
}

// The update metadata, when the platform publishes one. Linux does not: the
// updater has no working path there, and the AppImage is distributed by
// download.
if (process.platform === 'win32' || process.platform === 'darwin') {
  const metadata = files.filter((file) => /latest.*\.yml$/i.test(file));
  ok(metadata.length > 0, 'the build carries no update metadata (latest.yml)');
  for (const file of metadata) {
    const text = fs.readFileSync(file, 'utf8');
    ok(text.includes(version), 'the update metadata does not name the built version: '
      + path.basename(file));
  }
}

// The git tag, when there is one. A build from a branch has no tag, and that
// is not a failure - it is not a release build.
let tag = '';
try {
  tag = execFileSync('git', ['describe', '--tags', '--exact-match'], {
    cwd: DESKTOP,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  tag = '';
}
if (tag) {
  ok(tag.replace(/^v/, '') === version,
    'the tag says ' + tag + ' and the build says ' + version);
}

if (failures.length) {
  console.log('the release is not fit to publish:\n');
  for (const failure of failures) console.log('  ' + failure);
  process.exit(1);
}

console.log('the release is fit to publish: version ' + version
  + ', ' + installers.length + ' installer(s)');

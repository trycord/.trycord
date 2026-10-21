#!/usr/bin/env node
'use strict';

// The desktop application, checked.
//
// The native client has a check like this one, and it exists because nothing
// else here can be run: there is no Electron on this machine and no display.
// So the check reads the application the way the release reads it - every
// import resolves, every file the build needs is there, and the things the
// documentation promises are the things the code does.
//
//   node scripts/check-desktop.mjs
//
// It exits non-zero when it finds something, so it can be a build step.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');
const REPO = path.join(DESKTOP, '..');

const failures = [];
function ok(condition, message) {
  if (!condition) failures.push(message);
}

// The files the application is made of.
const FILES = [
  'main.js',
  'preload.js',
  'launcher.js',
  'launcher-preload.js',
  'launcher.html',
  'updater.js',
  'package.json',
  'electron-builder.yml',
  'scripts/stage-client.mjs',
  'scripts/validate-release.mjs',
];
for (const file of FILES) {
  ok(fs.existsSync(path.join(DESKTOP, file)), 'the application has no ' + file);
}

// The scripts the release workflow calls.
const manifest = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
for (const script of ['dev', 'build:win', 'build:linux', 'validate:release', 'release', 'check']) {
  ok(manifest.scripts && manifest.scripts[script],
    'the package has no "' + script + '" script, and the release calls it');
}

// Every import of a local file resolves.
const require = createRequire(path.join(DESKTOP, 'package.json'));
for (const file of ['main.js', 'preload.js', 'launcher.js', 'launcher-preload.js', 'updater.js']) {
  const full = path.join(DESKTOP, file);
  if (!fs.existsSync(full)) continue;
  const source = fs.readFileSync(full, 'utf8');
  for (const match of source.matchAll(/require\(\s*'(\.[^']+)'\s*\)/g)) {
    const target = path.resolve(path.dirname(full), match[1]);
    const candidates = [target, target + '.js', path.join(target, 'index.js')];
    ok(candidates.some((candidate) => fs.existsSync(candidate)),
      file + ' asks for ' + match[1] + ', which is not there');
  }
}

// The renderer origin is the one the documentation names, and it is a real
// origin: a privileged scheme is what makes the API's answers readable.
const main = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
ok(/standard:\s*true/.test(main) && /secure:\s*true/.test(main),
  'the trycord scheme is not privileged as standard and secure, so the renderer is opaque');
ok(/trycord:\/\/app/.test(main), 'the application does not serve the client from trycord://app');
ok(/<base href=/.test(main), 'the shell does not rewrite its <base>, so its relative URLs resolve elsewhere');
ok(/will-navigate/.test(main), 'the renderer can navigate away from the client');
ok(/setWindowOpenHandler/.test(main), 'a link opened in the window is not handled');
ok(/requestSingleInstanceLock/.test(main), 'a second launch opens a second application');

// The launcher is the startup layer: the application window is not created
// until the launcher says so.
ok(/trycord:launch/.test(main), 'nothing tells the main process to open the application');
ok(/trycord:launch/.test(fs.readFileSync(path.join(DESKTOP, 'launcher-preload.js'), 'utf8')),
  'the launcher cannot ask for the application');

// The updater classifies its failures, because "could not check" and "there is
// nothing to install" are different answers.
const updater = fs.readFileSync(path.join(DESKTOP, 'updater.js'), 'utf8');
for (const kind of ['missing-metadata', 'offline', 'unknown']) {
  ok(updater.includes(kind), 'the updater does not report "' + kind + '"');
}
ok(/electron-updater/.test(updater), 'the updater does not use electron-updater');

// The build stages the client, so the application has something to serve.
const stage = fs.readFileSync(path.join(DESKTOP, 'scripts', 'stage-client.mjs'), 'utf8');
ok(/frontend/.test(stage), 'the staging does not read the client from the repository');

// The client's own tree is where the staging looks, and it is there.
ok(fs.existsSync(path.join(REPO, 'frontend', 'index.html')),
  'the repository has no client to stage');

// The version in the package matches the version the product reports, so the
// two cannot say different things about the same release.
const product = JSON.parse(fs.readFileSync(path.join(REPO, 'backend', 'package.json'), 'utf8'));
ok(manifest.version === product.version,
  'the desktop app says ' + manifest.version + ' and the product says ' + product.version);

if (failures.length) {
  console.log('the desktop application is not as it should be:\n');
  for (const failure of failures) console.log('  ' + failure);
  process.exit(1);
}

console.log('the desktop application is whole: ' + FILES.length + ' files, '
  + 'the scripts the release calls, and the promises the documentation makes');

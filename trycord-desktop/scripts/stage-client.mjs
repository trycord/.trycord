#!/usr/bin/env node
'use strict';

// Stage the web client into the application.
//
// The desktop app is an access point: it serves the same client the browser
// gets, from `trycord://app`. So the client has to be inside the application,
// and the address it should talk to has to be written beside it.
//
// The client is the product's own tree, so it is copied from the repository
// rather than fetched: the application is built from a source tree, and the
// client in that tree is the client that is shipped.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');
const REPO = path.join(DESKTOP, '..');
const CLIENT = path.join(REPO, 'frontend');
const OUT = path.join(DESKTOP, 'client');

// What is copied. The client's own tree, with the parts that are not the
// client left out: the native client is a different application, the scripts
// are the tools that check it, and the desktop app has no use for either.
const SKIP = new Set(['node_modules', 'tests', 'scripts', '.git']);

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else if (entry.isFile()) fs.copyFileSync(source, target);
  }
}

if (!fs.existsSync(path.join(CLIENT, 'index.html'))) {
  console.error('the client is not where it should be: ' + CLIENT);
  console.error('the desktop app serves the client, so the client has to be there.');
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
copyTree(CLIENT, OUT);

// The address the built client talks to.
//
// It is the same file the web deployment publishes, and it is written from
// the same place, so the two cannot disagree. An operator who wants their own
// instance runs the application with `--api-url=`, which wins over this.
const backendUrl = process.env.TRYCORD_DESKTOP_BACKEND
  || process.env.TRYCORD_API_URL
  || 'https://api.trycord.dev';
fs.writeFileSync(
  path.join(OUT, 'backend.json'),
  JSON.stringify({ backendUrl: String(backendUrl).replace(/\/+$/, '') }, null, 2) + '\n'
);

// The mobile module is a second entry document for phones. The desktop app
// does not use it, but the tree is the product's, and leaving it out would make
// the staged copy differ from what the repository holds.
const version = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8')).version;

console.log('staged the client into ' + path.relative(REPO, OUT) + ' (version ' + version + ')');
console.log('the client will talk to ' + backendUrl);

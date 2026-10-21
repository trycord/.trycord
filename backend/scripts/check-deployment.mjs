#!/usr/bin/env node
'use strict';

// The deployment files, checked.
//
// The container image and the compose file are what a self-hoster runs, and
// nothing here can build them: this machine has no Docker socket. So the
// files are read the way the build reads them, and the things the build
// needs are checked to be there.
//
//   node scripts/check-deployment.mjs
//
// It exits non-zero when it finds something, so it can be a build step.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');

const failures = [];
function ok(condition, message) {
  if (!condition) failures.push(message);
}

// -- the Dockerfile ----------------------------------------------------------

const dockerfile = path.join(ROOT, 'Dockerfile');
ok(fs.existsSync(dockerfile), 'there is no Dockerfile');
const docker = fs.existsSync(dockerfile) ? fs.readFileSync(dockerfile, 'utf8') : '';

// Every source the image copies has to be in the repository, or the build
// fails at the copy rather than at the thing that is wrong.
for (const match of docker.matchAll(/^COPY\s+(.+)$/gm)) {
  const line = match[1].trim();
  // A copy from another stage names a path inside the image, not in the
  // repository.
  if (line.startsWith('--from=')) continue;
  const sources = line.split(/\s+/);
  for (const source of sources.slice(0, -1)) {
    const clean = source.replace(/\*+$/, '');
    if (!fs.existsSync(path.join(ROOT, clean))) {
      failures.push('the image copies ' + source + ', which is not in the repository');
    }
  }
}

// The image runs the API, and it carries the voice subsystem so a deployment
// can run the relay from the same image.
ok(/CMD \["node", "src\/server\.js"\]/.test(docker),
  'the image does not start the server');
ok(fs.existsSync(path.join(ROOT, 'backend', 'src', 'voice', 'index.js')),
  'the voice subsystem is not in the image, so a container has no relay');

// The health check has to ask something that exists.
//
// The address is built from the environment, so the route is the last quoted
// path in the check rather than the first.
const health = /HEALTHCHECK[\s\S]*?CMD node -e "([\s\S]*?)"/.exec(docker);
ok(health, 'the image has no health check');
if (health) {
  const route = /'(\/[a-z-]+)'/.exec(health[1]);
  ok(route && ['/api/health', '/health', '/ready'].includes(route[1]),
    'the health check asks for something that is not a route the server has');
}

// -- the compose file ---------------------------------------------------------

const composePath = path.join(ROOT, 'docker-compose.yml');
ok(fs.existsSync(composePath), 'there is no docker-compose.yml');
let compose = null;
if (fs.existsSync(composePath)) {
  const text = fs.readFileSync(composePath, 'utf8');
  // A small reader for the two things that matter: the service names and the
  // keys under each. A YAML parser is not a dependency of the backend, and the
  // file is written by hand.
  const services = {};
  let current = null;
  let lastKey = null;
  for (const line of text.split('\n')) {
    const service = /^  ([a-zA-Z0-9_-]+):\s*$/.exec(line);
    if (service) { current = service[1]; services[current] = {}; lastKey = null; continue; }
    const key = /^    ([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (key && current) {
      current === null;
      services[current][key[1]] = key[2].trim();
      lastKey = key[1];
      continue;
    }
    // A list under a key: the port mappings, the volumes.
    const item = /^      -\s*(.+)$/.exec(line);
    if (item && current && lastKey) {
      const list = Array.isArray(services[current][lastKey])
        ? services[current][lastKey]
        : [];
      list.push(item[1].trim().replace(/^["']|["']$/g, ''));
      services[current][lastKey] = list;
    }
  }
  compose = services;

  ok(Object.keys(services).includes('trycord'), 'the compose file has no trycord service');
  ok(Object.keys(services).includes('trycord-voice'),
    'the compose file has no voice service, so a container has no relay');
  const voice = services['trycord-voice'] || {};
  ok(/src\/voice\/index\.js/.test(voice.command || ''),
    'the voice service does not run the voice subsystem');
  const ports = [].concat(voice.ports || []);
  ok(ports.some((port) => /udp/.test(port)),
    'the voice service does not publish the relay port as UDP, and a relay needs UDP');
  ok(voice.healthcheck !== undefined, 'the voice service has no health check');
  ok((services.trycord || {}).healthcheck !== undefined, 'the API service has no health check');
}

if (failures.length) {
  console.log('the deployment files are not as they should be:\n');
  for (const failure of failures) console.log('  ' + failure);
  process.exit(1);
}

console.log('the deployment files are whole: the image copies what is in the repository, '
  + 'and the compose file runs the API and the relay');

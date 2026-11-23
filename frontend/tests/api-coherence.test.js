// The coherence audit: what the client calls must exist.
//
// Two checks the duct tape hides in:
//  1. every `Api.<method>` used in js/, mobile/js and portal/js is defined in
//     packages/api.js — a missing one is "Api.foo is not a function" the
//     moment its button is pressed (conversation-browser.js called Api.get
//     and Api.post, which have never existed);
//  2. every literal path packages/api.js requests answers to a backend
//     route — a missing one is a 404 wearing a toast.
//
// The path half reads the backend's own route table, so the audit fails when
// the two ends drift, in either direction.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const apiSrc = fs.readFileSync(path.join(ROOT, 'packages', 'api.js'), 'utf8');

const defined = new Set();
for (const m of apiSrc.matchAll(/^\s{2}([A-Za-z_$][\w$]*):\s*(?:\(|async|function)/gm)) {
  defined.add(m[1]);
}

test('every Api.<method> the client calls is defined in packages/api.js', () => {
  const used = new Map();
  for (const dir of ['js', 'mobile/js', 'portal/js']) {
    const base = path.join(ROOT, dir);
    if (!fs.existsSync(base)) continue;
    for (const file of walk(base, [])) {
      if (file.endsWith(path.join('packages', 'api.js'))) continue;
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\bApi\.([A-Za-z_$][\w$]*)/g)) {
        if (!used.has(m[1])) used.set(m[1], path.relative(ROOT, file));
      }
    }
  }
  // Non-API members that legitimately hang off the import (promises, the
  // default export itself) are not the audit's business.
  const notApi = new Set(['then', 'catch', 'finally', 'default']);
  const missing = [...used.keys()]
    .filter((k) => !notApi.has(k) && !defined.has(k))
    .map((k) => '  Api.' + k + '  ←  ' + used.get(k));
  assert.deepEqual(missing, [], 'calls that throw at runtime:\n' + missing.join('\n'));
});

test('every literal path packages/api.js requests has a backend route', () => {
  // Backend route table, read from the routers themselves. The mount
  // prefixes live in server.js (`app.use('/api/auth', require('./routes/auth'))`),
  // and a mount may point at a directory router, in which case every file
  // under it answers under that prefix.
  const mounts = new Map(); // router dir/file name → mount prefix
  const routesDir = path.join(ROOT, '..', 'backend', 'src', 'routes');
  const serverFile = path.join(ROOT, '..', 'backend', 'src', 'server.js');
  for (const m of fs.readFileSync(serverFile, 'utf8')
    .matchAll(/app\.use\(\s*'([^']+)',\s*require\(\s*'\.\/routes\/([^']+)'\)/g)) {
    const target = m[2].replace(/\/+$/, '');
    const base = path.join(routesDir, target);
    if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
      for (const f of walk(base, [])) {
        mounts.set(path.basename(f, '.js'), m[1]);
      }
    } else {
      mounts.set(target.replace(/\.js$/, ''), m[1]);
    }
  }
  const routes = new Set();
  // server.js also mounts a few routes inline (`app.get('/api/instance', …)`);
  // those are read from the same file the mounts come from.
  for (const m of fs.readFileSync(serverFile, 'utf8')
    .matchAll(/app\.(get|post|patch|put|delete)\(\s*'([^']+)'/g)) {
    routes.add(m[1].toUpperCase() + ' ' + m[2]);
  }
  for (const file of walk(routesDir, [])) {
    const src = fs.readFileSync(file, 'utf8');
    const mount = mounts.get(path.basename(file, '.js')) || '';
    for (const m of src.matchAll(/router\.(get|post|patch|put|delete)\(\s*'([^']+)'/g)) {
      const full = (mount + m[2]).replace(/\/+$/, '') || mount;
      routes.add(m[1].toUpperCase() + ' ' + full);
    }
  }
  const missing = [];
  for (const m of apiSrc.matchAll(/request\(\s*'(GET|POST|PATCH|PUT|DELETE)'\s*,\s*'([^']+)'/g)) {
    const method = m[1].toUpperCase();
    const raw = m[2];
    // A literal that ends in '/' is the front of a dynamic build
    // ('/api/users/' + id); its shape is covered by the pattern routes, and
    // comparing the bare prefix would only manufacture false alarms.
    if (raw.endsWith('/')) continue;
    // Query strings are built dynamically ('?'+params); the route is the path
    // in front of the question mark.
    const [pathOnly] = raw.split('?');
    const hit = [...routes].some((r) => {
      const [rm, rp] = r.split(' ');
      if (rm !== method) return false;
      return new RegExp('^' + rp.replace(/:[^/]+/g, '[^/]+') + '$').test(pathOnly);
    });
    if (!hit) missing.push(method + ' ' + raw);
  }
  assert.deepEqual(missing, [], 'requested paths with no backend route:\n' + missing.join('\n'));
});

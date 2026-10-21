#!/usr/bin/env node
'use strict';

// Does every path the client asks for exist on the server?
//
// The two halves of the product are written by different hands: the client
// has an address for every call it makes, and the server has a route for
// every call it answers. Nothing checked that the two agree, so a call could
// name a route that was never registered, and the answer would be a 404 that
// reads like a permission problem.
//
// The SDK had that fault: `client.commands()` asked for
// `/applications/:id/commands`, which is not a route - the commands of an
// application live under its community - and every bot that asked for its own
// commands got a 404.
//
// So this reads the server's own source for the routes it registers, reads
// the client's own API module for the paths it asks for, and compares.
//
//   node scripts/check-api-contract.mjs
//
// It exits non-zero when the two disagree.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const BACKEND = path.join(ROOT, 'backend', 'src');
const CLIENT = path.join(ROOT, 'frontend', 'packages', 'api.js');

// The parser is a development tool, so it is found where it is installed.
let acorn;
try {
  acorn = createRequire(path.join(ROOT, 'backend', 'package.json'))('acorn');
} catch {
  acorn = createRequire(path.join(ROOT, 'frontend', 'package.json'))('acorn');
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'del', 'head', 'options'];

// -- the server's routes --------------------------------------------------------

/**
 * Every route a file registers, and the routers it mounts.
 *
 * @param {string} file
 * @returns {{routes: Array<{method: string, path: string}>, mounts: Array<{prefix: string, target: string}>}}
 */
function routesOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const routes = [];
  const mounts = [];

  // router.get('/path' ... and app.get('/path'
  for (const m of text.matchAll(/\b(router|app)\.(get|post|put|patch|delete|del)\(\s*'([^']*)'/g)) {
    routes.push({ method: m[2].toUpperCase() === 'DEL' ? 'DELETE' : m[2].toUpperCase(), path: m[3] });
  }

  // router.route('/path').get( ... and the other methods on it
  for (const m of text.matchAll(/\b(router|app)\.route\(\s*'([^']*)'\)\s*\.(get|post|put|patch|delete|del)\(/g)) {
    routes.push({ method: m[3].toUpperCase() === 'DEL' ? 'DELETE' : m[3].toUpperCase(), path: m[2] });
  }

  // The developer API is built from a list of definitions rather than from
  // router calls, so its routes are read from the definitions themselves.
  if (file.replace(/\\/g, '/').includes('/routes/developer/')) {
    for (const m of text.matchAll(/method:\s*'(get|post|put|patch|delete)'[\s\S]{0,200}?path:\s*'([^']*)'/g)) {
      routes.push({ method: m[1].toUpperCase(), path: m[2] });
    }
  }

  // router.use('/prefix', require('./x')) and router.use(require('./x'))
  for (const m of text.matchAll(/\b(router|app)\.use\(\s*(?:'([^']*)'\s*,\s*)?require\((['"])([^'"]+)\3\)/g)) {
    mounts.push({ prefix: m[2] || '', target: m[4] });
  }

  // A router that was required into a name and then mounted by that name:
  // `const register = require('./auth/register'); router.use(register);`
  const required = new Map();
  for (const m of text.matchAll(/\bconst\s+(\w+)\s*=\s*require\((['"])([^'"]+)\2\)/g)) {
    required.set(m[1], m[3]);
  }
  for (const m of text.matchAll(/\b(router|app)\.use\(\s*(?:'([^']*)'\s*,\s*)?(\w+)\s*\)/g)) {
    const target = required.get(m[3]);
    if (!target) continue;
    mounts.push({ prefix: m[2] || '', target });
  }

  return { routes, mounts };
}

// The routes of the whole server, with the prefixes they are mounted under.
function serverRoutes() {
  const seen = new Set();
  const out = [];

  const visit = (file, prefix) => {
    const key = path.resolve(file);
    if (seen.has(key + '|' + prefix)) return;
    seen.add(key + '|' + prefix);

    const { routes, mounts } = routesOf(file);
    for (const route of routes) out.push({ method: route.method, path: prefix + route.path });

    for (const mount of mounts) {
      let target = mount.target;
      if (!target.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), target);
      // A name may be a file beside this one, or a directory with an index.
      // `routes/auth` is the aggregator file, and `routes/developer` is the
      // directory - so the file beside it is tried first.
      let file2 = resolved + '.js';
      if (!fs.existsSync(file2)) {
        file2 = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
          ? path.join(resolved, 'index.js')
          : resolved;
      }
      if (!fs.existsSync(file2)) continue;
      visit(file2, prefix + mount.prefix);
    }

    // The developer API's routes are a list of definitions spread over several
    // files, and the file that serves them only requires them. So the files it
    // requires are read as well.
    if (file.replace(/\\/g, '/').includes('/routes/developer/')) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/require\((['"])(\.\/[^'"]+)\1\)/g)) {
        const resolved = path.resolve(path.dirname(file), m[2]);
        const file2 = fs.existsSync(resolved + '.js') ? resolved + '.js' : resolved;
        if (fs.existsSync(file2)) visit(file2, prefix);
      }
    }
  };

  visit(path.join(BACKEND, 'server.js'), '');
  return out;
}

// -- the client's paths ---------------------------------------------------------

/**
 * The path of a call, with the parts that are not literals turned into a
 * placeholder.
 *
 * `'/api/servers/' + encodeURIComponent(id) + '/channels'` becomes
 * `/api/servers/:x/channels`.
 */
function pathOf(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = pathOf(node.left);
    const right = pathOf(node.right);
    if (left === null || right === null) return null;
    return left + right;
  }
  if (node.type === 'TemplateLiteral') {
    let out = '';
    for (let i = 0; i < node.quasis.length; i++) {
      out += node.quasis[i].value.cooked;
      if (i < node.expressions.length) out += ':x';
    }
    return out;
  }
  // A variable that holds a path is not followed: the check is about the
  // paths that are written down.
  return null;
}

function clientCalls() {
  const source = fs.readFileSync(CLIENT, 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: 'module', locations: true });
  const calls = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    if (node.type === 'CallExpression'
      && node.callee.type === 'Identifier'
      && node.callee.name === 'request'
      && node.arguments.length >= 2) {
      const method = node.arguments[0];
      const path = pathOf(node.arguments[1]);
      if (method && method.type === 'Literal' && typeof method.value === 'string' && path) {
        calls.push({
          method: method.value.toUpperCase(),
          path: path.replace(/\?.*$/, ''),
          line: node.loc ? node.loc.start.line : 0,
        });
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range') continue;
      visit(node[key]);
    }
  };
  visit(ast);
  return calls;
}

// The SDK asks for its paths the same way, in an options object.
function sdkCalls() {
  const dir = path.join(ROOT, 'sdk', 'trycord-botjs', 'src');
  if (!fs.existsSync(dir)) return [];
  const calls = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.ts')) continue;
    const file = path.join(dir, name);
    const source = fs.readFileSync(file, 'utf8');
    // The path is written as one template literal or several joined with `+`.
    for (const m of source.matchAll(/method:\s*'(GET|POST|PUT|PATCH|DELETE)'[\s\S]{0,200}?path:\s*((?:`[^`]*`\s*\+?\s*)+)/g)) {
      const parts = m[2].match(/`[^`]*`/g) || [];
      let path = '';
      for (const part of parts) {
        path += part.slice(1, -1).replace(/\$\{[^}]*\}/g, ':x');
      }
      path = path.replace(/\?.*$/, '');
      // The SDK's REST base is the versioned root, so its paths start there.
      calls.push({
        method: m[1],
        path: '/api/v1' + path,
        line: source.slice(0, m.index).split('\n').length,
        file: 'sdk/trycord-botjs/src/' + name,
      });
    }
  }
  return calls;
}

// -- the comparison ------------------------------------------------------------

// A server path and a client path are the same when their literals agree and
// their placeholders agree in number.
function matches(serverPath, clientPath) {
  const a = serverPath.split('/');
  const b = clientPath.split('/');
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const server = a[i];
    const client = b[i];
    if (server.startsWith(':') || client.startsWith(':') || client === '*') continue;
    if (server !== client) return false;
  }
  return true;
}

function main() {
  const server = serverRoutes().map((route) => ({
    method: route.method === 'DEL' ? 'DELETE' : route.method,
    path: route.path.replace(/\/$/, '') || '/',
  }));
  const calls = [
    ...clientCalls().filter((call) => call.path.startsWith('/api/')),
    ...sdkCalls().filter((call) => call.path.startsWith('/api/')),
  ];

  const missing = [];
  for (const call of calls) {
    const found = server.some((route) => route.method === call.method && matches(route.path, call.path));
    if (!found) missing.push(call);
  }

  if (!missing.length) {
    console.log('every path the client and the SDK ask for is served: '
      + calls.length + ' call(s) against ' + server.length + ' route(s)');
    return 0;
  }

  console.log('these paths the client and the SDK ask for are not served:\n');
  for (const call of missing) {
    console.log('  ' + (call.file || 'frontend/packages/api.js') + ':' + call.line
      + '  ' + call.method + ' ' + call.path);
  }
  console.log('\n' + missing.length + ' of ' + calls.length + ' call(s) do not match a route.');
  return 1;
}

// The exit code is set rather than the process ended: ending it here would
// cut the last line off when the output is a pipe.
process.exitCode = main();

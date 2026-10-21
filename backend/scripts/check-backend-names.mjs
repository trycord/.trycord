#!/usr/bin/env node
'use strict';

// The backend, checked for the names it uses but does not have.
//
// The voice service had this fault and nobody knew: the encoder that writes a
// mapped address used a constant that was never defined, the packet handler
// caught the error and threw it away, and every message type in the switch
// was an identifier that did not exist. The service bound its port, received
// every request and answered nothing - and the diagnostics reported the port
// as open, which is exactly what a firewall problem looks like.
//
// So this walks every module, resolves every name that is read, and reports
// the ones that resolve to nothing.
//
//   node scripts/check-backend-names.mjs
//
// It exits non-zero when it finds something, so it can be a build step.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(HERE, '..');
// The parser is found where it is installed. It is a development tool, not
// a runtime dependency, so the backend does not carry it.
let require = createRequire(path.join(BACKEND, 'package.json'));
try {
  require('acorn');
} catch {
  require = createRequire(path.join(BACKEND, '..', 'frontend', 'package.json'));
}

const acorn = require('acorn');
const eslintScope = require('eslint-scope');

// The names the platform provides.
const PLATFORM = new Set([
  'console', 'process', 'Buffer', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'URL',
  'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController',
  'AbortSignal', 'structuredClone', 'atob', 'btoa', 'fetch', 'Headers',
  'Request', 'Response', 'FormData', 'Blob', 'File', 'crypto', 'performance',
  'globalThis', 'undefined', 'NaN', 'Infinity', 'require', 'module', 'exports',
  '__dirname', '__filename', 'Proxy', 'Reflect', 'Symbol', 'WeakMap', 'WeakSet',
  'Map', 'Set', 'JSON', 'Math', 'Date', 'Array', 'Object', 'String', 'Number',
  'Boolean', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Promise',
  'RegExp', 'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array',
  'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'ArrayBuffer',
  'DataView', 'BigInt', 'Intl', 'WebSocket', 'EventEmitter', 'EventTarget',
  'Node', 'Element', 'HTMLElement', 'MessageChannel', 'MessagePort',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'escape', 'unescape',
  'global', 'gc', 'Intl', 'WebAssembly', 'SharedArrayBuffer', 'Atomics',
  'BigInt64Array', 'BigUint64Array', 'FinalizationRegistry', 'WeakRef',
  'AggregateError', 'SuppressedError', 'navigator', 'location', 'window',
  'document', 'localStorage', 'sessionStorage', 'self', 'globalThis',
]);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function isReadReference(reference) {
  const node = reference.identifier;
  const parent = node.parent;
  if (parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return false;
  if (parent && parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) return false;
  if (parent && parent.type === 'VariableDeclarator' && parent.id === node) return false;
  if (parent && (parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression'
    || parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') && parent.id === node) return false;
  if (parent && parent.type === 'CatchClause' && parent.param === node) return false;
  if (parent && parent.type === 'LabeledStatement' && parent.label === node) return false;
  if (parent && parent.type === 'BreakStatement' && parent.label === node) return false;
  if (parent && parent.type === 'ContinueStatement' && parent.label === node) return false;
  return true;
}

const findings = [];
let checked = 0;

const files = [
  ...walk(path.join(BACKEND, 'src')),
  ...walk(path.join(BACKEND, 'scripts')),
];

for (const file of files) {
  let source = fs.readFileSync(file, 'utf8');
  // A script may start with a shebang, which the parser does not read.
  if (source.startsWith('#!')) source = '//' + source.slice(2);
  let ast;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: 2022,
      sourceType: 'script',
      locations: true,
      ranges: true,
      allowReturnOutsideFunction: true,
    });
  } catch (error) {
    findings.push({
      file: path.relative(BACKEND, file),
      line: error.loc ? error.loc.line : 0,
      name: '(the file does not parse)',
      message: error.message,
    });
    continue;
  }

  let scopeManager;
  try {
    scopeManager = eslintScope.analyze(ast, {
      ecmaVersion: 2022,
      sourceType: 'script',
      optimistic: true,
      ignoreEval: true,
      nodejsScope: true,
    });
  } catch (error) {
    findings.push({
      file: path.relative(BACKEND, file),
      line: 0,
      name: '(the scopes could not be worked out)',
      message: error.message,
    });
    continue;
  }

  const globalScope = scopeManager.globalScope;
  const moduleScope = globalScope.childScopes[0];
  const declared = new Set();
  if (moduleScope) {
    for (const variable of moduleScope.variables) declared.add(variable.name);
  }

  for (const reference of scopeManager.scopes.flatMap((scope) => scope.references)) {
    if (!isReadReference(reference)) continue;
    const name = reference.identifier.name;
    if (PLATFORM.has(name)) continue;
    if (reference.resolved) continue;
    if (declared.has(name)) continue;
    findings.push({
      file: path.relative(BACKEND, file),
      line: reference.identifier.loc ? reference.identifier.loc.start.line : 0,
      name,
      message: 'the name is not declared anywhere it can be seen',
    });
  }
  checked++;
}

// A relative require that points at nothing.
//
// The voice service read its saved relay address through
// `require('./settings')` from `services/voice/`, where there is no such
// file. The call sat inside a try/catch, so the error was swallowed, the
// address was never read, and the relay was published somewhere nobody had
// chosen. The job service asked for `./services/settings` from inside
// `services/`, so the operator's saved worker count was ignored too.
//
// A wrong path that fails quietly is worse than no path at all, so the path
// is checked here rather than left to the reader of the catch.
//
//   node scripts/check-backend-names.mjs

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  // The parse below already knows what is code and what is a comment, so the
  // calls are collected from the tree rather than from the text: an example
  // in a comment is not a call.
  let ast;
  try {
    ast = acorn.parse(source.startsWith('#!') ? '//' + source.slice(2) : source, {
      ecmaVersion: 2022,
      sourceType: 'script',
      locations: true,
      allowReturnOutsideFunction: true,
    });
  } catch {
    continue; // the parse is reported by the name check above.
  }
  const calls = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    if (node.type === 'CallExpression'
      && node.callee && node.callee.type === 'Identifier'
      && node.callee.name === 'require'
      && node.arguments.length === 1
      && node.arguments[0].type === 'Literal'
      && typeof node.arguments[0].value === 'string'
      && node.arguments[0].value.startsWith('.')) {
      calls.push({ request: node.arguments[0].value, line: node.loc ? node.loc.start.line : 0 });
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range') continue;
      visit(node[key]);
    }
  };
  visit(ast);

  for (const call of calls) {
    const base = path.resolve(path.dirname(file), call.request);
    const candidates = [
      base,
      base + '.js',
      base + '.json',
      path.join(base, 'index.js'),
      path.join(base, 'index.json'),
    ];
    if (candidates.some((candidate) => fs.existsSync(candidate))) continue;
    findings.push({
      file: path.relative(BACKEND, file),
      line: call.line,
      name: call.request,
      message: 'the path does not resolve to a file',
    });
  }
}
// An option a route definition does not read.
//
// The developer API is built from one list of definitions, and the router and
// the OpenAPI document are made from it. A definition that carries a field
// neither of them reads is a rule nobody enforces - and the field that looks
// like a rule is the one that matters: a scope that is spelled differently
// from the rest is a route with no scope check.
//
// The fields the two readers understand are listed here, and a definition
// that carries another one is reported.

const ROUTE_DEFINITION_FIELDS = new Set([
  'method', 'path', 'auth', 'bots', 'scopes', 'community', 'tags', 'summary',
  'description', 'parameters', 'requestBody', 'responses', 'handler',
]);

function routeDefinitionFindings() {
  const out = [];
  const dir = path.join(BACKEND, 'src', 'routes', 'developer');
  for (const file of walk(dir)) {
    const source = fs.readFileSync(file, 'utf8');
    let ast;
    try {
      ast = acorn.parse(source, {
        ecmaVersion: 2022,
        sourceType: 'script',
        locations: true,
      });
    } catch {
      continue; // the parse is reported by the name check.
    }
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const child of node) visit(child); return; }
      if (node.type === 'ObjectExpression') {
        const keys = node.properties
          .filter((property) => property.type === 'Property' && !property.computed)
          .map((property) => (property.key.type === 'Identifier' ? property.key.name : property.key.value));
        // A route definition is an object with a method and a path.
        if (keys.includes('method') && keys.includes('path')) {
          const unknown = keys.filter((key) => !ROUTE_DEFINITION_FIELDS.has(key));
          if (unknown.length) {
            out.push({
              file: path.relative(BACKEND, file),
              line: node.loc ? node.loc.start.line : 0,
              name: unknown.join(', '),
              message: 'the route definition is read by nobody, so the field does nothing',
            });
          }
        }
      }
      for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'range') continue;
        visit(node[key]);
      }
    };
    visit(ast);
  }
  return out;
}

findings.push(...routeDefinitionFindings());

if (!findings.length) {
  console.log('the backend uses no name it does not have: ' + checked + ' modules checked');
} else {
  console.log('these names are used and never declared:\n');
  for (const finding of findings) {
    console.log('  ' + finding.file + ':' + finding.line + '  ' + finding.name
      + '  (' + finding.message + ')');
  }
  console.log('\n' + findings.length + ' finding(s) in ' + checked + ' modules.');
  // The exit code is set rather than the process ended: ending it here would
  // cut the last line off when the output is a pipe.
  process.exitCode = 1;
}

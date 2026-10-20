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

if (!findings.length) {
  console.log('the backend uses no name it does not have: ' + checked + ' modules checked');
  process.exit(0);
}

console.log('these names are used and never declared:\n');
for (const finding of findings) {
  console.log('  ' + finding.file + ':' + finding.line + '  ' + finding.name
    + '  (' + finding.message + ')');
}
console.log('\n' + findings.length + ' finding(s) in ' + checked + ' modules.');
process.exit(1);

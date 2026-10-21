#!/usr/bin/env node
'use strict';

// The client, checked for the names it uses but does not have.
//
// A module that names something it does not have throws a ReferenceError the
// moment that line runs - and only if that line runs. A click handler that
// nobody clicks, a branch that only one kind of account reaches, a field that
// is only set in one of two ways: none of them is reached by a test that
// draws the screen and looks at it.
//
// The poll editor is the example. It named a `poll` that was not in scope,
// and every click on "New poll" threw. The workspace's whole poll surface was
// unreachable and the suite was green.
//
// So this walks every module in the client, resolves every identifier that is
// read, and reports the ones that resolve to nothing.
//
// The scope analysis is the platform's own: `acorn` parses and `eslint-scope`
// resolves. The platform's globals are listed, because a name the browser
// provides is not a name the module has to declare.
//
//   node scripts/check-client-names.mjs
//
// It exits non-zero when it finds something, so it can be a build step.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const require = createRequire(path.join(ROOT, 'frontend', 'package.json'));

const acorn = require('acorn');
const eslintScope = require('eslint-scope');

// The names the platform provides. A module does not have to declare them,
// and a check that said it had to would be wrong.
const PLATFORM = new Set([
  'window', 'document', 'console', 'fetch', 'navigator', 'location', 'history',
  'localStorage', 'sessionStorage', 'performance', 'globalThis', 'undefined',
  'NaN', 'Infinity', 'crypto', 'URL', 'URLSearchParams', 'TextEncoder',
  'TextDecoder', 'AbortController', 'AbortSignal', 'CustomEvent', 'Event',
  'FormData', 'Blob', 'File', 'FileReader', 'Headers', 'Request', 'Response',
  'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
  'clearImmediate', 'structuredClone', 'atob', 'btoa', 'Image', 'Proxy',
  'Reflect', 'Symbol', 'WeakMap', 'WeakSet', 'Map', 'Set', 'JSON', 'Math',
  'Date', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Error', 'TypeError',
  'RangeError', 'Promise', 'RegExp', 'Uint8Array', 'Int8Array', 'Uint16Array',
  'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'ArrayBuffer', 'DataView', 'Intl', 'Node', 'Element', 'HTMLElement',
  'IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'Buffer',
  'process', 'TextDecoderStream', 'ReadableStream', 'WritableStream',
  'TransformStream', 'BroadcastChannel', 'MessageChannel', 'MessagePort',
  'DOMParser', 'XMLHttpRequest', 'Notification', 'matchMedia', 'getComputedStyle',
  // The media classes a voice session names: the element a speaker is chosen
  // on, and the streams and tracks the call is made of.
  'HTMLMediaElement', 'HTMLAudioElement', 'HTMLVideoElement', 'MediaStream',
  'MediaStreamTrack', 'RTCPeerConnection', 'AudioContext',
  'scrollTo', 'scrollBy', 'alert', 'confirm', 'prompt', 'open', 'close',
  'isSecureContext', 'origin', 'parent', 'top', 'self', 'frames', 'name',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'escape', 'unescape', 'eval', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'escape', 'Uint8ClampedArray', 'BigInt', 'BigInt64Array', 'BigUint64Array',
  'WebSocket', 'SyntaxError', 'WebSocketStream', 'Crypto', 'CryptoKey',
  'AggregateError', 'FinalizationRegistry', 'WeakRef', 'Intl',
  'TextEncoderStream', 'ReadableStreamDefaultReader', 'WritableStreamDefaultWriter',
  'caches', 'clients', 'navigator', 'location', 'history', 'screen',
  'visualViewport', 'devicePixelRatio', 'innerWidth', 'innerHeight', 'outerWidth',
  'outerHeight', 'scrollX', 'scrollY', 'pageXOffset', 'pageYOffset',
]);

// The directories the client is made of.
const AREAS = [
  ['packages', path.join(ROOT, 'frontend', 'packages')],
  ['desktop', path.join(ROOT, 'frontend', 'js')],
  ['mobile', path.join(ROOT, 'frontend', 'mobile', 'js')],
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// The references that are reads rather than writes.
function isReadReference(reference) {
  const node = reference.identifier;
  const parent = reference.identifier.parent;
  // A property of something is not a name in this scope.
  if (parent && parent.type === 'MemberExpression' && parent.property === node
    && !parent.computed) return false;
  // A key in an object literal is not a name in this scope.
  if (parent && parent.type === 'Property' && parent.key === node && !parent.computed
    && !parent.shorthand) return false;
  // The name of a declaration is not a read.
  if (parent && (parent.type === 'VariableDeclarator' && parent.id === node)) return false;
  if (parent && (parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression'
    || parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') && parent.id === node) return false;
  if (parent && parent.type === 'CatchClause' && parent.param === node) return false;
  if (parent && parent.type === 'ImportSpecifier' && parent.imported === node) return false;
  if (parent && parent.type === 'ExportSpecifier' && parent.local === node) return false;
  if (parent && parent.type === 'LabeledStatement' && parent.label === node) return false;
  if (parent && parent.type === 'BreakStatement' && parent.label === node) return false;
  if (parent && parent.type === 'ContinueStatement' && parent.label === node) return false;
  return true;
}

const findings = [];
let checked = 0;

for (const [area, dir] of AREAS) {
  for (const file of walk(dir)) {
    const source = fs.readFileSync(file, 'utf8');
    let ast;
    try {
      ast = acorn.parse(source, {
        ecmaVersion: 2022,
        sourceType: 'module',
        locations: true,
        ranges: true,
      });
    } catch (error) {
      findings.push({
        file: path.relative(ROOT, file),
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
        sourceType: 'module',
        optimistic: true,
        ignoreEval: true,
      });
    } catch (error) {
      findings.push({
        file: path.relative(ROOT, file),
        line: 0,
        name: '(the scopes could not be worked out)',
        message: error.message,
      });
      continue;
    }

    const globalScope = scopeManager.globalScope;
    const moduleScope = globalScope.childScopes[0];
    if (!moduleScope) continue;

    for (const reference of scopeManager.scopes
      .flatMap((scope) => scope.references)) {
      if (!isReadReference(reference)) continue;
      const name = reference.identifier.name;
      if (PLATFORM.has(name)) continue;
      // Resolved: the name is declared somewhere it can be seen.
      if (reference.resolved) continue;
      // A name the module declares at the top level is resolved; anything
      // left over is a name the module uses and does not have.
      const declared = moduleScope.variables.some((variable) => variable.name === name);
      if (declared) continue;
      findings.push({
        file: path.relative(ROOT, file),
        line: reference.identifier.loc ? reference.identifier.loc.start.line : 0,
        name,
        message: 'the name is not declared anywhere it can be seen',
      });
    }
    checked++;
  }
}

if (!findings.length) {
  console.log('the client uses no name it does not have: '
    + checked + ' modules checked');
  process.exit(0);
}

console.log('these names are used and never declared:\n');
for (const finding of findings) {
  console.log('  ' + finding.file + ':' + finding.line + '  ' + finding.name
    + '  (' + finding.message + ')');
}
console.log('\n' + findings.length + ' finding(s) in ' + checked + ' modules.');
process.exit(1);

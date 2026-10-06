#!/usr/bin/env node
'use strict';

// The server-side counterpart to check-client-bindings.js: a name used in a module
// that the module neither requires nor defines.
//
// Nothing in the server checks this. A missing require is a ReferenceError on the line
// that uses it, which for a rarely-taken branch — an admin route, an S3 driver, a
// recovery email — is a production-only failure. The client's version of this check
// found three live ones on the first run.
//
// The same narrow rule keeps the noise down: only a name exactly one module exports is
// reportable, and the scanner in strip-comments.mjs does the reading.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// Node and web globals. A module may legitimately export a name that shadows one of
// these - services/threads.js exports a `fetch` helper - and using the global is then
// correct, so none of these are reportable.
const GLOBALS = new Set([
  'fetch', 'console', 'process', 'Buffer', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'setImmediate', 'queueMicrotask', 'URL', 'URLSearchParams',
  'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'FormData', 'Blob',
  'File', 'crypto', 'performance', 'structuredClone', 'atob', 'btoa', 'parseInt',
  'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'Intl',
  'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Symbol', 'Promise', 'Map', 'Set',
  'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'Headers', 'Request', 'Response', 'ReadableStream',
  'WritableStream', 'MessageChannel', 'EventTarget', 'Event', 'CompressionStream',
]);

(async () => {
  const { stripComments } = await import('./strip-comments.mjs');

  function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }

  const files = walk(SRC);
  const source = new Map();
  const stripped = new Map();
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    source.set(f, text);
    stripped.set(f, stripComments(text));
  }

  const owner = new Map();
  const claim = (name, file) => {
    if (!name) return;
    if (!owner.has(name)) owner.set(name, new Set());
    owner.get(name).add(file);
  };

  // Only real exports claim a name. Collecting every const and function declaration
  // here would make a module's own locals look like things other modules could borrow,
  // which is how `href`, `color` and `messages` ended up reported.
  for (const [file, code] of stripped) {
    for (const m of code.matchAll(/module\.exports\.(\w+)\s*=/g)) claim(m[1], file);
    for (const m of code.matchAll(/\bexports\.(\w+)\s*=/g)) claim(m[1], file);
    for (const m of code.matchAll(/module\.exports\s*=\s*\{([\s\S]*?)\}/g)) {
      for (const n of m[1].split(',')) {
        const name = n.trim().split(':')[0].trim();
        if (/^\w+$/.test(name)) claim(name, file);
      }
    }
  }

  const unique = new Map();
  for (const [name, homes] of owner) if (homes.size === 1) unique.set(name, [...homes][0]);

  const findings = [];

  for (const [file, code] of stripped) {
    const defined = new Set();

    for (const m of code.matchAll(/(?:const|let|var)\s*\{([\s\S]*?)\}\s*=/g)) {
      for (const n of m[1].split(',')) {
        const name = n.trim().split(':').pop().split(/\s+as\s+/).pop().trim();
        if (/^\w+$/.test(name)) defined.add(name);
      }
    }
    for (const m of code.matchAll(/(?:const|let|var)\s+([^;\n]+)/g)) {
      let depth = 0;
      let piece = '';
      const flush = () => {
        const name = piece.match(/^\s*(\w+)/);
        if (name) defined.add(name[1]);
        piece = '';
      };
      for (const ch of m[1]) {
        if ('{[('.includes(ch)) depth++;
        if ('}])'.includes(ch)) depth--;
        if (ch === ',' && depth === 0) flush();
        else piece += ch;
      }
      flush();
    }
    for (const re of [/\(([^()]*)\)\s*=>/g, /(?:function\s*\w*)\s*\(([^()]*)\)/g]) {
      for (const m of code.matchAll(re)) {
        // `function f({ status, limit } = {})` splits on the comma into "{ status"
        // and "limit }", so the plain split only recovers half. Pull the braces out
        // separately.
        for (const braces of m[1].matchAll(/\{([^{}]*)\}/g)) {
          for (const n of braces[1].split(',')) {
            const name = n.trim().split('=')[0].split(':').pop().split(/\s+as\s+/).pop().trim();
            if (/^\w+$/.test(name)) defined.add(name);
          }
        }
        for (const n of m[1].replace(/\{[^{}]*\}/g, ',').split(',')) {
          const name = n.trim().split('=')[0].split(':').pop().trim();
          if (/^\w+$/.test(name)) defined.add(name);
        }
      }
    }
    // Every destructuring target binds names, not only `const { x } = require(...)`:
    // there are bare assignments like `({ profile } = req.body)` all over the routes.
    for (const re of [
      /(?:const|let|var)\s*\{([\s\S]*?)\}\s*=/g,   // const { a, b } = anything
      /\(\s*\{([\s\S]*?)\}\s*\)\s*=/g,              // ({ a, b } = anything)
      /\(\s*\{([\s\S]*?)\}\s*\)\s*[;,)]/g,           // ({ a, b }) as a call argument
    ]) {
      for (const m of code.matchAll(re)) {
        for (const n of m[1].split(',')) {
          const name = n.trim().split(':').pop().split(/\s+as\s+/).pop().split('=')[0].trim();
          if (/^\w+$/.test(name)) defined.add(name);
        }
      }
    }
    for (const m of code.matchAll(/^\s*(?:async\s+)?function\s+(\w+)/gm)) defined.add(m[1]);

    for (const [name, home] of unique) {
      if (home === file || defined.has(name) || GLOBALS.has(name)) continue;
      const hit = new RegExp(`(?<![\\w.$'])${name}\\b`).exec(code);
      if (!hit) continue;
      if (/^\s*:/.test(code.slice(hit.index + name.length))) continue;
      findings.push({ file, name, home, line: code.slice(0, hit.index).split('\n').length });
    }
  }

  const rel = (f) => path.relative(ROOT, f);

  if (findings.length) {
    console.error(`server binding check FAILED - ${findings.length} name(s) used but neither required nor defined:`);
    for (const f of findings) {
      console.error(`  ${rel(f.file)}:${f.line}  ${f.name}  (exported by ${rel(f.home)})`);
    }
    process.exit(1);
  }

  console.log(`server binding check passed (${files.length} modules, every borrowed name is imported)`);
})();
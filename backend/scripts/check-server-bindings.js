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
// Words followed by an opening parenthesis that are not calls. `if (` captures
// "if", so this tests the captured name rather than the text in front of it.
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'delete',
  'void', 'in', 'of', 'do', 'else', 'yield', 'throw', 'case', 'with', 'import',
  'export', 'super', 'this', 'constructor', 'async', 'function', 'class', 'get', 'set',
]);

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
  'XMLHttpRequest', 'WebSocket', 'ReadableStream', 'CustomEvent', 'Image', 'Audio',
  'ArrayBuffer', 'Uint8Array', 'DataView', 'BigInt', 'WeakRef',
  'FinalizationRegistry', 'globalThis', 'exports', '__dirname', '__filename',
  'module', 'require', 'setImmediate', 'clearImmediate', 'unref', 'ref',
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
    for (const m of code.matchAll(/^\s*(?:async\s+)?function\s+(\w+)/gm)) defined.add(m[1])

    // Parameters of a method. `async transaction(fn) {` is a definition like any other, and
    // without this its parameter reads as a name nothing defines - which is how `fn` in
    // db/mysql.js and `read` in services/export.js were reported on the first run of the
    // zero-owner rule.
    for (const m of code.matchAll(/(?:^|[;{}\n])\s*(?:static\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/g)) {
      for (const n of m[2].split(',')) {
        const name = n.trim().split('=')[0].split(':').pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name);
      }
    }

    // A name bound by a destructured for-of head: `for (const [name, read] of Object
    // .entries(sections))` binds both, and the body calls `read()`.
    for (const m of code.matchAll(/for\s*\(\s*(?:const|let|var)\s*[\[{]([^\]}]*)[\]}]/g)) {
      for (const n of m[1].split(',')) {
        const name = n.trim().split(':').pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name);
      }
    };

    for (const [name, home] of unique) {
      if (home === file || defined.has(name) || GLOBALS.has(name)) continue;
      const hit = new RegExp(`(?<![\\w.$'])${name}\\b`).exec(code);
      if (!hit) continue;
      if (/^\s*:/.test(code.slice(hit.index + name.length))) continue;
      findings.push({ file, name, home, line: code.slice(0, hit.index).split('\n').length });
    }

    // A name nobody exports, and that this module calls.
    //
    // The loop above only looks at names exactly one module exports, which is what keeps
    // it quiet - and which makes it blind to the other half of the same fault. A function
    // defined here and removed by an edit leaves its call site behind; no module exports
    // that name any more, so there is nothing to compare it against.
    //
    // It is not hypothetical on the client, where the same rule found eight live faults:
    // five moderation buttons calling functions nobody exported, a friend-request action
    // calling a renderer that does not exist, and two helpers left behind in the parent
    // module of a split. Each threw a ReferenceError on the line that used it.
    for (const m of code.matchAll(/(?<![\w.$'`])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (defined.has(name) || owner.has(name) || GLOBALS.has(name)) continue;
      if (KEYWORDS.has(name)) continue;
      const before = code.slice(Math.max(0, m.index - 16), m.index);
      if (/\b(function|class)\s*$/.test(before)) continue;
      // An object literal's method has nothing in front of the name, so what tells a
      // definition from a use is whether a body follows the argument list.
      if (isDefinition(code, m.index)) continue;
      findings.push({ file, name, home: null, line: code.slice(0, m.index).split('\n').length });
    }
  }

  /**
   * Whether the `(` at `at` opens an argument list followed by a body.
   *
   * Walks the parentheses rather than matching the line, so a default value or a nested
   * call does not end the scan early.
   */
  function isDefinition(code, at) {
    let i = code.indexOf('(', at);
    if (i === -1) return false;
    let depth = 0;
    for (; i < code.length; i++) {
      const c = code[i];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) break; }
    }
    const after = code.slice(i + 1).match(/^\s*(.)/);
    return !!after && after[1] === '{';
  }

  const rel = (f) => path.relative(ROOT, f);

  if (findings.length) {
    console.error(`server binding check FAILED - ${findings.length} name(s) used but neither required nor defined:`);
    for (const f of findings) {
      console.error(`  ${rel(f.file)}:${f.line}  ${f.name}  (${f.home
        ? 'exported by ' + rel(f.home)
        : 'nothing exports this, and it is not bound here'})`);
    }
    process.exit(1);
  }

  console.log(`server binding check passed (${files.length} modules, every borrowed name is imported)`);
})();
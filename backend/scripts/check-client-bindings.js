#!/usr/bin/env node
'use strict';

// Catches a name used in a module that the module does not import and does not
// define.
//
// This is the failure the other client checks cannot see. They verify that a file
// parses, that its import paths resolve, and that its named imports exist in the
// target. None of that notices a name that is simply absent. A missing `toast` in
// view-states.js passed all four and broke every stale-refresh warning at runtime,
// because a ReferenceError thrown inside a .catch() handler is invisible until
// something calls it.
//
// The scanner in strip-comments.mjs is load-bearing, and so is the order things are
// collected in. Four earlier versions of this reported 98 findings, then 40, then 15,
// and only one was real:
//
//   - stripping line comments before string bodies turned 'https://x' into an
//     unterminated quote, which misaligned every string boundary after it
//   - a comment containing an apostrophe swallows the next quote when strings are
//     stripped first, which is the opposite failure
//   - multi-declarator `let a = 0, esc = false` only yielded its first name
//   - `import('./x.js').then(({ name }) => ...)` is a definition, not a use
//
// So comments and strings are removed by a character scanner that understands both,
// and everything below works on what is left. Narrow on purpose: it only reports a
// name that some *other* module exports exactly once, which is what removes the
// noise. A check that cries wolf does not get run.

const fs = require('fs');
const path = require('path');

const CLIENT = path.join(__dirname, '..', '..', 'frontend', 'js');

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

  const files = walk(CLIENT);
  const src = new Map();
  for (const f of files) src.set(f, fs.readFileSync(f, 'utf8'));

  // Which module defines each exported name.
  const owner = new Map();
  const claim = (name, file) => {
    if (!owner.has(name)) owner.set(name, new Set());
    owner.get(name).add(file);
  };
  for (const [file, text] of src) {
    for (const re of [/^export\s+(?:async\s+)?function\s+(\w+)/gm, /^export\s+(?:const|let|var|class)\s+(\w+)/gm]) {
      for (const m of text.matchAll(re)) claim(m[1], file);
    }
    for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
      for (const n of m[1].split(',')) {
        const name = n.trim().split(/\s+as\s+/).pop().trim();
        if (name) claim(name, file);
      }
    }
  }

  // Only names exactly one module exports. Six names are exported by more than one
  // module - leaveDm, icon, onCleanup and friends are re-exports - and a name with
  // two possible homes cannot be resolved to one answer.
  // Words that are followed by an opening parenthesis and are not calls.
  const KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'delete',
    'void', 'in', 'of', 'do', 'else', 'yield', 'throw', 'case', 'with', 'import',
    'export', 'super', 'this', 'constructor', 'async', 'function', 'class', 'get', 'set',
  ]);

  // Language and browser. Anything called by name that is not here, not bound in the
  // file, and not exported anywhere in the tree is a name that does not exist.
  const CALLED_OK = new Set([
    'require', 'import', 'fetch', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
    'requestAnimationFrame', 'cancelAnimationFrame', 'structuredClone', 'atob', 'boto',
    'console', 'alert', 'confirm', 'prompt', 'TextDecoder', 'TextEncoder', 'URL',
    'URLSearchParams', 'AbortController', 'FormData', 'Blob', 'File', 'Event',
    'EventTarget', 'CustomEvent', 'MessageChannel', 'Headers', 'Request', 'Response',
    'Symbol', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect',
    'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'RegExp',
    'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'Function',
    'Intl', 'ArrayBuffer', 'Uint8Array', 'DataView', 'crypto', 'performance', 'globalThis',
    'matchMedia', 'getComputedStyle', 'FileReader', 'IntersectionObserver',
    'MutationObserver', 'ResizeObserver', 'localStorage', 'sessionStorage', 'history',
    'location', 'navigator', 'screen', 'Notification', 'IntersectionObserverEntry',
    'XMLHttpRequest', 'PopStateEvent', 'CustomEvent', 'Image', 'Audio', 'Option',
    'WebSocket', 'CSSStyleSheet', 'MediaQueryList', 'ShadowRoot', 'ReadableStream',
  ]);

  // Every exported name, with the modules that export it - not only the ones with a single
  // home.
  //
  // Restricting this to exactly one owner was how the check kept quiet, and it hid every
  // re-export from it: renderContextHeader is defined in shell/context-header.js and
  // re-exported by shell.js, so it had two homes, so it was never on the list, so a module
  // that called it without importing it from either passed. Which module owns a name does
  // not change the question this loop asks - does this file bind it - so the ambiguity is
  // carried into the message rather than used to skip the check.
  const unique = new Map();
  for (const [name, homes] of owner) unique.set(name, [...homes]);

  const findings = [];

  for (const [file, text] of src) {
    const imports = [...text.matchAll(/^import\s+([\s\S]*?)\s+from\s+'[^']+';/gm)];
    const bodyStart = imports.length ? imports[imports.length - 1].index + imports[imports.length - 1][0].length : 0;
    const code = stripComments(text.slice(bodyStart));

    const defined = new Set();
    const reexportedOnly = new Set();

    for (const m of imports) {
      const clause = m[1];
      const asDefault = clause.match(/^\s*(\w+)/);
      if (asDefault) defined.add(asDefault[1]);
      for (const braces of clause.matchAll(/\{([\s\S]*?)\}/g)) {
        for (const n of braces[1].split(',')) {
          const name = n.trim().split(/\s+as\s+/).pop().trim();
          if (name) defined.add(name);
        }
      }
    }

    // `export { a, b } from './x.js'` re-exports without creating a local binding. A
    // module that re-exports a name and then uses it is reading a variable that does not
    // exist in its own scope, which is a ReferenceError the moment that line runs - and
    // invisible to the check above, because the name really is exported, just not from
    // here. ui.js did exactly this: it re-exported esc and el, then named both in its
    // own default export, and the application failed to start.
    //
    // Checked directly rather than through `unique`, because a re-exported name has two
    // homes and is excluded from that map by design.
    for (const m of text.matchAll(/^export\s*\{([^}]*)\}\s*from\s*'[^']+';/gm)) {
      for (const n of m[1].split(',')) {
        const name = n.trim().split(/\s+as\s+/).pop().trim();
        if (!name || defined.has(name)) continue;
        if (!new RegExp(`(?<![\\w.$])${name}\\b`).test(code)) continue;
        findings.push({
          file,
          name,
          home: 're-exported from another module without a local binding',
          line: bodyStart + code.slice(0, code.search(new RegExp(`(?<![\\w.$])${name}\\b`))).split('\n').length,
        });
      }
    }

    // A dynamic import destructures its names, which defines them here. The scanner
    // blanks string bodies to spaces, so the module path is whitespace by now and
    // only the shape of the call is left to match.
    const DYN = /import\(\s*\)\s*\.then\(\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
    for (const m of code.matchAll(DYN)) {
      for (const n of m[1].split(',')) {
        const name = n.trim().split(':').pop().split(/\s+as\s+/).pop().trim();
        if (name) defined.add(name);
      }
    }

    for (const m of code.matchAll(/(?:^|[\s;,{(])(?:async\s+)?function\s*\*?\s*(\w+)/g)) defined.add(m[1]);

    // `let a = 0, b = false, esc = false` - every declarator, not just the first.
    // Split on commas that are not inside brackets, then take the name each piece
    // starts with.
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
        for (const n of m[1].split(',')) {
          const name = n.trim().split('=')[0].split(':').pop().trim();
          if (/^\w+$/.test(name)) defined.add(name);
        }
        // A destructured parameter binds every name in its braces, and splitting the
        // argument list on commas recovers only the pieces either side of them -
        // `renderAdminPages(container, { route } = {})` yields "{ route } = {}" and
        // "route" was being reported as an unbound borrow of nav.js's route().
        for (const braces of m[1].matchAll(/\{([^{}]*)\}/g)) {
          for (const n of braces[1].split(',')) {
            const name = n.trim().split('=')[0].split(':').pop().trim();
            if (/^\w+$/.test(name)) defined.add(name);
          }
        }
      }
    }

    for (const m of code.matchAll(/(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g)) {
      for (const n of m[1].split(',')) {
        const name = n.trim().split(':').pop().trim();
        if (/^\w+$/.test(name)) defined.add(name);
      }
    }

    for (const [name, homes] of unique) {
      if (homes.includes(file) || defined.has(name)) continue;
      // A definition, not a use. realtime.js owns `leaveDm()` and was reported for it until
      // this loop got the same body-follows-the-arguments test the zero-owner loop has.
      if (isDefinition(code, code.indexOf(name + '('))) continue;
      const hit = new RegExp(`(?<![\\w.$])${name}\\b`).exec(code);
      if (!hit) continue;
      // `route: ctx.rest[0]` is an object key, not a reference to the router's route().
      if (/^\s*:/.test(code.slice(hit.index + name.length))) continue;
      findings.push({
        file, name, homes,
        line: bodyStart + code.slice(0, hit.index).split('\n').length,
      });
    }

    // A name that nobody exports, and that this module calls.
    //
    // The loop above only looks at names exactly one module exports, which is what keeps it
    // quiet - and which makes it blind to the other half of the same fault. A function
    // defined here and removed by an edit leaves its call site behind; no module exports
    // that name any more, so there is nothing to compare it against and the check passes.
    // It happened: moving the grouping block out of renderChannel took newNonce with it and
    // left `pendingNonce || newNonce()` in the send path, which is a ReferenceError on every
    // message anyone sends, and the whole suite was green.
    //
    // Narrow on purpose. Only a *call* counts, so prose and property reads do not, and the
    // language and the browser are listed rather than guessed at.
    for (const m of code.matchAll(/(?<![\w.$'`])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (defined.has(name) || owner.has(name) || CALLED_OK.has(name)) continue;
      // The match *is* the keyword where there is one - `if (` captures "if" - so this
      // tests the captured name, not the text before it.
      if (KEYWORDS.has(name)) continue;
      const before = code.slice(Math.max(0, m.index - 16), m.index);
      if (/\b(function|class)\s*$/.test(before)) continue;
      // A definition, not a use. `function send(` has the keyword before it, but an object
      // literal's method has nothing in front of the name: `TrycordConfig` holds `wsUrl(
      // ticket) {` and every one of those looked like a call to a name that did not exist.
      // The thing that tells them apart is what follows the argument list: a definition has
      // a body, a call has not.
      if (isDefinition(code, m.index)) continue;
      findings.push({
        file, name, home: null,
        line: bodyStart + code.slice(0, m.index).split('\n').length,
      });
    }
  }

  /**
   * Whether the `(` at `at` opens an argument list that is followed by a body.
   *
   * Walks the parentheses rather than pattern-matching the line, so a default value or a
   * nested call does not end the scan early. This is the difference between a method in an
   * object literal and a call to something undefined, and the two look identical until you
   * read what comes after the closing bracket.
   */
  function isDefinition(code, at) {
    let i = code.indexOf('(', at);
    if (i === -1) return false;
    let depth = 0;
    for (; i < code.length; i++) {
      const c = code[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const after = code.slice(i + 1).match(/^\s*(.)/);
    return !!after && after[1] === '{';
  }

  const rel = (f) => path.relative(path.join(__dirname, '..', '..'), f);

  if (findings.length) {
    console.error(`client binding check FAILED - ${findings.length} name(s) used but neither imported nor defined:`);
    for (const f of findings) {
      console.error(`  ${rel(f.file)}:${f.line}  ${f.name}  (${f.homes
        ? 'exported by ' + f.homes.map((h) => path.basename(h)).join(', ')
        : 'nothing exports this, and it is not bound here'})`);
    }
    process.exit(1);
  }

  console.log(`client binding check passed (${files.length} modules, every borrowed name is imported)`);
})();
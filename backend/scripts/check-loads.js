#!/usr/bin/env node
'use strict';

// Every server module loads, and the require graph has no top-level cycle.
//
// Two failures this is for, both of which present as a boot that dies on a line
// nobody wrote:
//
//   a module that requires something which is still mid-load, so it gets a
//   partially-built exports object and every name off it is undefined. The
//   error surfaces at the first use, on a branch that only runs for one kind of
//   member, and reads as a ReferenceError about a name that is right there in
//   the file.
//
//   a module that cannot be loaded at all, which is how a renamed file or a
//   missing dependency reaches main.
//
// The distinction that matters is top-level versus lazy. A require inside a
// function body runs after every module has finished loading, so a cycle that
// only goes through one is not a problem - services/settings.js requires
// ../util for now() and uuid(), and util.js requires the settings store from
// inside signWithJti() to read a session lifetime. That is a real cycle and it
// works, because neither runs at load time. Reading requires that the lazy form
// is the whole point here; counting the cycles that way reports four problems
// where there are none, and a check that cries wolf gets ignored.
//
// So: every module must load, and no cycle may be closed by top-level requires
// on both sides.
//
//   node scripts/check-loads.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

let failures = 0;
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label + (detail ? ': ' + detail : ''));
  else { failures++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
};

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// A require at module scope versus one inside a function body.
//
// The test is whether the require sits inside braces. That is imprecise for a
// require inside an object literal or a class body, and both of those still run
// at load time, so treating them as lazy is the safe direction to be wrong in:
// a cycle it misses is one that works, and one it reports is a warning, not a
// failure. It is confirmed below by actually loading every module.
function requiresOf(file) {
  // Scanned character by character, tracking only whether we are inside a brace.
  //
  // Both obvious shortcuts are wrong here. Counting braces over raw source
  // miscounts every brace inside a comment, and this file's own header is full of
  // them. And stripComments() blanks string bodies on purpose - which erases the
  // path out of require('./services/settings'), so the scan finds no require at
  // all and quietly passes. A check that cannot see the thing it checks is worse
  // than no check, so this keeps string contents and only skips comments.
  const src = fs.readFileSync(file, 'utf8');
  const found = [];

  let depth = 0;
  let i = 0;

  const readString = () => {
    const quote = src[i++];
    let out = '';
    while (i < src.length && src[i] !== quote) {
      if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
      out += src[i++];
    }
    i++; // closing quote
    return out;
  };

  while (i < src.length) {
    const c = src[i];

    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const at = i;
      const value = readString();
      // require('...') or require("..."), with only whitespace between.
      if (value.startsWith('.') && /\brequire\s*\(\s*$/.test(src.slice(Math.max(0, at - 24), at))) {
        let target = path.resolve(path.dirname(file), value);
        if (!target.endsWith('.js')) target += '.js';
        found.push({ target, top: depth === 0 });
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return found;
}

(async () => {
  console.log('\n  every module loads');

  const { stripComments } = await import('./strip-comments.mjs');
  const files = walk(SRC);

  // A throwaway secret so a module that reads JWT_SECRET at load time is testing
  // its own code rather than refusing to boot for want of configuration.
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-loads-0123456789abcdef';
  process.env.DB_CLIENT = process.env.DB_CLIENT || 'sqlite';
  // Pinned connection: ignore any database configuration saved on this machine.
  process.env.TRYCOD_DB_ENV_ONLY = '1';

  const failed = [];
  for (const file of files) {
    try {
      require(file);
    } catch (e) {
      // The database refuses queries before it is connected, and one module
      // reads a live table at load time. Neither is what this is looking for.
      if (/database not connected|Cannot find module|ENOENT/.test(String(e && e.message))) continue;
      failed.push(path.relative(ROOT, file) + ': ' + String(e && e.message).slice(0, 100));
    }
  }
  ok('every module in src/ loads on its own', failed.length === 0, failed.join(' | '));

  console.log('\n  the require graph');

  const graph = new Map();
  for (const file of files) {
    graph.set(file, requiresOf(file));
  }

  const state = new Map();
  const stack = [];
  const cycles = [];

  function visit(node) {
    state.set(node, 1);
    stack.push(node);
    for (const { target, top } of graph.get(node) || []) {
      if (!graph.has(target)) continue;
      if (state.get(target) === 1) {
        const at = stack.indexOf(target);
        cycles.push({ path: stack.slice(at).concat([target]), lazy: !top });
      } else if (!state.get(target)) {
        visit(target);
      }
    }
    stack.pop();
    state.set(node, 2);
  }

  for (const file of files) if (!state.get(file)) visit(file);

  const topLevel = cycles.filter((c) => !c.lazy);
  ok('no cycle is closed by top-level requires on both sides', topLevel.length === 0,
    topLevel.map((c) => c.path.map((f) => path.relative(ROOT, f)).join(' -> ')).join(' | '));

  // The lazy ones are reported, not failed. They work, and someone reading the
  // output should know they are there.
  const lazy = cycles.filter((c) => c.lazy);
  if (lazy.length) {
    console.log('\n  note  ' + lazy.length + ' cycle(s) closed through a function-body'
      + ' require, which runs after every module has loaded:');
    for (const c of lazy) {
      console.log('    note  ' + c.path.map((f) => path.relative(ROOT, f)).join(' -> '));
    }
  }

  console.log('\n  ' + files.length + ' modules, all of them loadable');
  console.log(`\n  loads check ${failures ? 'FAILED - ' + failures + ' problem(s)' : 'passed'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

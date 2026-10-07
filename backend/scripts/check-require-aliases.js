#!/usr/bin/env node
'use strict';

// A service called under a name it was not bound to, or called at all without being
// imported.
//
// Both shapes shipped live bugs:
//
//   src/routes/auth/sessions.js  const sessionsService = require('../../services/sessions')
//                                ... sessions.revokeOthers(req.user.id)
//   src/routes/auth/email.js     nothing required at all, calling recovery.verifyEmail()
//
// Neither was caught by the binding check, which only asks about names this repository
// exports and which appear bare - not as `service.member`, which is how every service in
// this codebase is called. Nor by the flow assertions, which do not reach these routes.
// Both were found by the render check, one per fifteen-minute cycle.
//
// Two questions, and they need different evidence:
//
//   1. Bound to one name, called by another. The module's basename is used as a value and
//      the bound name is not used anywhere.
//   2. Called but never imported. `name.member` where name is the basename of a module
//      elsewhere in src/ and nothing in this file binds it.
//
// A require bound to a name the file does use is fine. A basename differing from the
// variable is fine too - an index, an acronym - because then the basename is not used as
// an identifier either.
//
// Two things this got wrong first, both worth recording.
//
// "Built-ins" was excluded with /^(node:)?[a-z_]+$/, which matches any lowercase word -
// sessions, db, auth, events - so it skipped exactly the modules it was written for.
//
// Then it stripped comments and strings with its own regexes, which is the third time
// this repository has been bitten by that. strip-comments.mjs exists because
// src.replace(/\/\*[\s\S]*?\*\//g) ate 84% of pages/registry.js, and because a regex
// literal's quotes once opened a string that blanked 130 lines. The same failure here
// deleted `let gateway = { disconnectUser: () => {} };` from routes/admin.js, and the
// check reported a missing import in a line that is present in the file.
//
// So the reading is done by strip-comments.mjs, which is the third implementation and
// the only one that has not been wrong.
//
// node scripts/check-require-aliases.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const BUILTIN = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events',
  'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path',
  'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream',
  'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util',
  'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

// Modules that are not services, or that are legitimately used unimported.
const NOT_A_SERVICE = new Set([
  'index', 'core', 'db', 'router', 'server', 'app', 'config', 'util', 'errors',
  'logger', 'constants', 'types', 'schema',
]);


function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const usesAsValue = (code, name) =>
  new RegExp('(?<![\\w$.])' + name + '\\s*\\.').test(code);

async function main() {
const { stripComments } = await import('./strip-comments.mjs');

const files = walk(SRC);
const sources = new Map();
const moduleBasenames = new Map();

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  sources.set(file, { raw, code: stripComments(raw) });
  const base = path.basename(file).replace(/\.js$/, '');
  if (BUILTIN.has(base) || NOT_A_SERVICE.has(base)) continue;
  if (!moduleBasenames.has(base)) moduleBasenames.set(base, new Set());
  moduleBasenames.get(base).add(path.relative(ROOT, file));
}

// Everything one file has bound, from any of the ways JavaScript binds a name.
function boundNames(code) {
  const bound = new Set();
  const add = (n) => {
    const name = String(n || '').trim().split(':').pop().split('=')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) bound.add(name);
  };
  for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^{}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) add(part);
  }
  for (const m of code.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]\s*=/g)) {
    for (const part of m[1].split(',')) add(part);
  }
  // Parameters, plain and destructured. createFrames({ rooms, registry }) is how the
  // socket layer receives its dependencies, and a name bound only there is bound.
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const brace of m[1].matchAll(/\{([^{}]*)\}/g)) {
      for (const part of brace[1].split(',')) add(part);
    }
    for (const part of m[1].replace(/\{[^{}]*\}/g, ',').split(',')) add(part);
  }
  // catch (e), and every other single-identifier parameter form.
  for (const m of code.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) bound.add(m[1]);
  return bound;
}

const findings = [];

// A third question, and the one that let a broken sign-in ship: does the thing this file
// destructures out of a require actually exist? `const { issued } = require('./issued')`
// resolves to a real module whether or not that module exports anything, and
// issued.js defined `issued` without exporting it, so every successful login answered 500
// with nothing in the log but `issued is not a function`. The client has had this check
// since check-client-modules.js was written; the server did not.
function exportsOf(src) {
  const names = new Set();
  const add = (list) => {
    for (const raw of list.split(',')) {
      const part = raw.trim().replace(/^type\s+/, '');
      if (!part) continue;
      const as = /\bas\s+([A-Za-z0-9_$]+)$/.exec(part);
      names.add(as ? as[1] : part);
    }
  };
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) add(m[1]);
  for (const m of src.matchAll(/^module\.exports\s*=\s*\{/gm)) {
    // The block runs to the matching brace; good enough for a list of short names.
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    add(src.slice(start, i - 1));
  }
  if (/^module\.exports\s*=\s*[A-Za-z_$][\w$]*\s*;/m.test(src)) names.add('__default_fn__');
  if (/^module\.exports\s*=\s*\{/m.test(src)) names.add('__default_obj__');
  return names;
}

const exportedBy = new Map();
for (const [file, { raw }] of sources) exportedBy.set(file, exportsOf(raw));

for (const [file, { raw, code }] of sources) {
  // Question 0: names destructured out of a require that the target does not export.
  for (const m of raw.matchAll(
    /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*require\(\s*'([^']+)'\s*\)/g)) {
    const spec = m[2];
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
    const target = path.resolve(path.dirname(file), spec);
    const available = exportedBy.get(target);
    if (!available) continue; // question 1/2 covers a module that is not there at all
    for (const part of m[1].split(',')) {
      const raw_name = part.trim().split(':')[0].split('=')[0].trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(raw_name)) continue;
      if (available.has(raw_name)) continue;
      if (raw_name.startsWith('__')) continue;
      findings.push({
        file,
        line: raw.slice(0, m.index).split('\n').length,
        head: `${raw_name} is imported from '${spec}', which does not export it`,
        detail: `${path.relative(ROOT, target)} has no such export. Destructuring gets undefined, `
          + 'so this is a runtime failure on the line that uses it rather than a load error.',
      });
    }
  }

  const bound = boundNames(code);

  // Question 1: bound to one name, called by another.
  for (const m of raw.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*'([^']+)'\s*\)/g)) {
    const name = m[1];
    const spec = m[2];
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
    const base = path.basename(spec).replace(/\.js$/, '');
    if (!base || BUILTIN.has(base) || NOT_A_SERVICE.has(base) || base === name) continue;
    // The bound name has to be unused everywhere, not merely unused as a value.
    // createRooms is a factory: `const rooms = createRooms({ registry })` uses it, and
    // flagging that as a mismatch is how the first version reported four working lines
    // in ws.js.
    const boundNameUsed = new RegExp('(?<![\\w$.])' + name + '(?![\\w$])').test(code);
    if (usesAsValue(code, base) && !boundNameUsed) {
      findings.push({
        file, line: raw.slice(0, m.index).split('\n').length,
        head: `require('${spec}') is bound to ${name}, but the code calls ${base}`,
        detail: 'One of the two names is wrong. Nothing at load time would notice.',
      });
    }
  }

  // Question 2: called, and nothing in this file binds it.
  //
  // Both shapes, because both shipped. `recovery.verifyEmail(...)` is a service method;
  // `issued(res, user, req)` is a bare call to a function another module in this
  // directory exports - and that one is how login came to answer 500 on every successful
  // sign-in, from a module that did define `issued` and simply never exported it. A
  // method-call pattern alone cannot see it.
  const seen = new Set();
  const CALLS = [
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\.\s*[A-Za-z_$][\w$]*\s*\(/g,
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g,
  ];
  for (const re of CALLS) for (const m of code.matchAll(re)) {
    const name = m[1];
    if (seen.has(name) || bound.has(name)) continue;
    if (BUILTIN.has(name) || NOT_A_SERVICE.has(name) || !moduleBasenames.has(name)) continue;
    seen.add(name);
    const homes = [...moduleBasenames.get(name)];
    findings.push({
      file,
      line: raw.slice(0, m.index).split('\n').length,
      head: `${name} is called but never bound in this file`,
      detail: `${homes.slice(0, 2).join(', ')}${homes.length > 2 ? `, and ${homes.length - 2} more` : ''} declare it. `
        + 'A missing require is a ReferenceError on the line that uses it, not at load.',
    });
  }
}

if (findings.length) {
  console.error(`\n  require alias check FAILED - ${findings.length} unbound or misnamed service call(s)\n`);
  for (const f of findings) {
    console.error(`  ${path.relative(ROOT, f.file)}:${f.line}  ${f.head}`);
    console.error(`        ${f.detail}\n`);
  }
  process.exit(1);
}

console.log(`require alias check passed (${files.length} modules, ${moduleBasenames.size} services, every call reaches an import)`);
}

main().catch((e) => {
  console.error('\n  require alias check could not run: ' + (e && e.message) + '\n');
  process.exit(2);
});
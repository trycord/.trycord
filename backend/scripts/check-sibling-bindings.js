#!/usr/bin/env node
'use strict';

// Every name one sibling module exports must be imported by the sibling that uses it.
//
// This exists because of a specific, repeated failure. Splitting the shell and the theme
// engine into modules left seven references to a name that lived in the next file along
// and was not imported: `homeRefreshAt`, `DEFAULT_CUSTOM_TOKENS`, `applyCustomPalette`,
// `validateCustomCss`, `DEFAULT_THEME`, `recovery`, `sessions`.
//
// None of them was caught by the binding check, which only asks about names this
// repository exports and which are used as `service.name`. They were all caught by the
// render check, which found them one at a time by rendering forty routes - about twenty
// minutes of work to find a missing import that a targeted read of two files would find
// in two seconds.
//
// The scope is deliberately narrow. An earlier attempt at a general unbound-identifier
// check reported 3371 findings and was deleted at 275, because it did not strip comments
// and could not see a declaration it did not have a pattern for. This one only looks at
// names a sibling module in the same directory exports, which is a set it can compute
// exactly, and it reports nothing at all on a tree that is correct.
//
// node scripts/check-sibling-bindings.js [dir ...]
//   defaults to every directory under js/ that has more than one module in it

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const JS = path.join(ROOT, 'frontend', 'js');

function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    // Module specifiers are paths, not code. Without this, `from '../resolve.js'` matches
    // a name called `resolve` and the check reports a binding that does not exist - which
    // is how it found three on its first run, all of them false.
    .replace(/(?:from|import)\s*\(?\s*'[^']*'\s*\)?/g, "from ''")
    .replace(/'[^']*'/g, "''");
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Directories holding more than one module: a single-module directory has no siblings to
// disagree with, and treating the whole of js/ as one set produces noise from unrelated
// files that happen to share a name.
//
// js/ itself is excluded for the same reason. Its top level holds sixty unrelated modules
// that were never split from one file; `api.js` does not "use" `avatar` because
// components.js exports it and they happen to share a directory. The directories this
// check is for are the ones a single file was divided into.
function targetDirs(explicit) {
  if (explicit.length) return explicit.map((d) => path.resolve(ROOT, d));
  const dirs = [];
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      const files = fs.readdirSync(full).filter((f) => f.endsWith('.js'));
      if (files.length > 1) dirs.push(full);
      visit(full);
    }
  };
  visit(JS);
  return dirs;
}

const findings = [];
const dirCount = targetDirs(process.argv.slice(2)).length;

for (const dir of targetDirs(process.argv.slice(2))) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  if (files.length < 2) continue;

  const sources = {};
  const exported = new Map();
  for (const f of files) {
    const code = strip(fs.readFileSync(path.join(dir, f), 'utf8'));
    sources[f] = code;
    for (const m of code.matchAll(/^export (?:async )?(?:function|const|let|class) ([A-Za-z_$][\w$]*)/gm)) {
      if (!exported.has(m[1])) exported.set(m[1], f);
    }
    for (const m of code.matchAll(/^export \{([^}]*)\}/gm)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(':')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name) && !exported.has(name)) exported.set(name, f);
      }
    }
  }

  for (const [file, code] of Object.entries(sources)) {
    const bound = new Set();
    for (const m of code.matchAll(/import \{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) bound.add(part.trim().split(/\s+as\s+/).pop().trim());
    }
    for (const m of code.matchAll(/^(?:export )?(?:async )?function ([A-Za-z_$][\w$]*)/gm)) bound.add(m[1]);
    for (const m of code.matchAll(/^(?:export )?(?:const|let) ([A-Za-z_$][\w$]*)/gm)) bound.add(m[1]);
    // Destructuring binds names too, and it is how a page renderer receives most of what
    // it uses: `const { region, parts, onCleanup } = ctx`. Without this the check reports
    // every name a handler pulls out of its context as a cross-module reference.
    for (const m of code.matchAll(/(?:const|let)\s*\{([^{}]*)\}\s*=/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(':').pop().split('=')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) bound.add(name);
      }
    }

    for (const [name, home] of exported) {
      if (home === file || bound.has(name)) continue;
      const m = new RegExp('(?<![\\w.$])' + name + '\\b').exec(code);
      if (!m) continue;
      findings.push({
        file: path.join(path.relative(ROOT, dir), file),
        name,
        home: path.join(path.relative(ROOT, dir), home),
        line: code.slice(0, m.index).split('\n').length,
      });
    }
  }
}

if (findings.length) {
  console.error(`\n  sibling binding check FAILED - ${findings.length} unbound cross-module reference(s)\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.name}  (exported by ${f.home})`);
  }
  process.exit(1);
}
console.log(`sibling binding check passed (${dirCount} module directories, no reference to a sibling's export is unbound)`);

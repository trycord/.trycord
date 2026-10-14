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
// Comments, strings and regex literals are removed by strip-comments.mjs, the scanner
// every binding check shares. A local regex strip had been written here, and it read the
// '/*' inside `accept: 'image/*'` as the start of a block comment, blanked the twelve
// hundred lines to the next real '*/', and reported a page of names from the fragments.
// That is the failure strip-comments.mjs documents at length, so the rules for what
// counts as bound are handled here and the reading of the source is not.
//
// node scripts/check-sibling-bindings.js [dir ...]
//   defaults to every directory under js/ that has more than one module in it

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const JS = path.join(ROOT, 'frontend', 'js');

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

// A comma-separated list of names, as it appears in a parameter list, a destructuring
// pattern or a declarator run. Keys and defaults are dropped and the name is what is
// left, so `{ route } = {}` binds `route` and `a: alias` binds `alias`.
function addNames(target, list) {
  for (const part of list.split(',')) {
    const name = part.trim().split('=')[0].split(':').pop().trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) target.add(name);
  }
}

// Everything the file binds for itself: imports, declarations at any depth, function and
// arrow parameters, and destructuring. A file may use a name it binds even when a sibling
// exports one with the same name, and the declaration itself is what tells the two apart.
function boundNames(code) {
  const bound = new Set();

  for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) bound.add(m[1]);
  for (const m of code.matchAll(/import\s*\{([^}]*)\}/g)) addNames(bound, m[1]);

  // `function name`, and `const name`, wherever they are. The declaration does not have
  // to start the line: `reactionRow` holds a `const row` two levels in, and a for loop
  // holds `const row of`.
  for (const m of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
  // `let a = 0, b = false, c = false` declares three names, not one. Split the run on the
  // commas that are not inside brackets.
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([^;\n]+)/g)) {
    let depth = 0;
    let piece = '';
    const flush = () => {
      const name = piece.match(/^\s*([A-Za-z_$][\w$]*)/);
      if (name) bound.add(name[1]);
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

  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) addNames(bound, m[1]);
  for (const m of code.matchAll(/\bfunction\s*\*?\s*[A-Za-z_$][\w$]*\s*\(([^()]*)\)/g)) addNames(bound, m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s*[{[][^}\]]*[}\]]\s*=/g)) addNames(bound, m[0].slice(m[0].indexOf('const') + 5));

  return bound;
}

function ownerOf(code) {
  const exported = new Map();
  for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (!exported.has(m[1])) exported.set(m[1], true);
  }
  for (const m of code.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) exported.set(name, true);
    }
  }
  return new Set(exported.keys());
}

(async () => {
  const { stripComments } = await import('./strip-comments.mjs');

  const findings = [];
  const dirs = targetDirs(process.argv.slice(2));

  for (const dir of dirs) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    if (files.length < 2) continue;

    const sources = {};
    const exported = new Map();
    for (const f of files) {
      const code = stripComments(fs.readFileSync(path.join(dir, f), 'utf8'));
      sources[f] = code;
      for (const name of ownerOf(code)) if (!exported.has(name)) exported.set(name, f);
    }

    for (const [file, code] of Object.entries(sources)) {
      const bound = boundNames(code);
      for (const [name, home] of exported) {
        if (home === file || bound.has(name)) continue;
        // The first use that is a reference. A name followed by a colon is a property key
        // or a label, which is not a reference to anything.
        const re = new RegExp('(?<![\\w.$])' + name + '\\b', 'g');
        let m;
        let at = -1;
        while ((m = re.exec(code))) {
          if (code[m.index + name.length] === ':') continue;
          at = m.index;
          break;
        }
        if (at < 0) continue;
        findings.push({
          file: path.join(path.relative(ROOT, dir), file),
          name,
          home: path.join(path.relative(ROOT, dir), home),
          line: code.slice(0, at).split('\n').length,
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
  console.log(`sibling binding check passed (${dirs.length} module directories, no reference to a sibling's export is unbound)`);
})();

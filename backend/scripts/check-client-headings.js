#!/usr/bin/env node
'use strict';

// One h1 per surface, and the page is the one that draws it.
//
// The workspace shell wraps every in-app surface. A heading drawn there would sit on
// top of the page's own, and the page would answer to two names. The shell therefore
// draws none: a page names itself, either in the body - through the shared heading()
// furniture, or its own title - or, for a conversation, in the stage head.
//
// A raw surface - the sign-in screens, the legal documents, /support - replaces the
// shell instead of filling it, so it is the one place a module *must* draw its own h1:
// there is no shell left to name it.
//
// This reads the author of the heading, not the count. Whether a page draws two is a
// runtime question, and check-render.js answers it by rendering every route; what can
// be read from source is whether a heading belongs to a page at all.

const fs = require('fs');
const path = require('path');

const CLIENT = path.join(__dirname, '..', '..', 'frontend', 'js');

// The page furniture: the one shared place a page heading is built. The
// views live in features/ now, and their furniture is ui/page.js.
const FURNITURE = new Set(['ui/page.js']);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const findings = [];
let modules = 0;
let rawSurfaces = 0;

for (const file of walk(CLIENT)) {
  modules++;
  const rel = path.relative(CLIENT, file).split(path.sep).join('/');
  const source = fs.readFileSync(file, 'utf8');
  const hasHeading = /el\(\s*['"]h1['"]/.test(source);
  const isView = rel.startsWith('views/');
  // The view modules are features/ now; among them, only the raw surfaces -
  // the gates and the documents that replace the shell wholesale - may name
  // their own h1, because there is no shell left above them to compete with.
  const declaresRaw = /\braw\s*:\s*true\b/.test(source) && /\bnode\s*:/.test(source);
  const allowed = isView || FURNITURE.has(rel) || (rel.startsWith('features/') && declaresRaw);

  if (hasHeading && !allowed) {
    findings.push(
      `${rel}: an h1 outside a view - the shell wraps every surface, so a heading here`
      + ' is drawn on top of the page\'s own'
    );
  }
  // A raw surface is a page descriptor the router can read: { raw: true, node }. The
  // same two words appear in a request option - { raw: true } asks for a buffer - so the
  // node field is what tells a surface from a fetch.
  if (/\braw\s*:\s*true\b/.test(source) && /\bnode\s*:/.test(source)) {
    rawSurfaces++;
    if (!hasHeading) {
      findings.push(
        `${rel}: a raw surface with no h1 - it replaces the shell, so this module is the`
        + ' only place the surface can be named'
      );
    }
  }
}

if (findings.length) {
  console.error(`\n  heading check FAILED - ${findings.length} problem(s):\n`);
  for (const f of findings) console.error('    ' + f);
  console.error(
    '\n  A view names its own surface; the shell and every other shared module draw no'
    + ' heading.\n'
  );
  process.exit(1);
}

console.log(
  `  heading check passed (${modules} modules; no heading in the shell or another`
  + ` shared module, ${rawSurfaces} raw surface module(s) name themselves)`
);

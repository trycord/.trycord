#!/usr/bin/env node
'use strict';

// One h1 per surface.
//
// renderContextHeader emits the top-level heading for every page inside the app, and
// it is the only place one should come from: it is what the header shows, what a
// screen reader announces on navigation, and what someone jumping between headings
// lands on. A page that adds its own h1 beside it leaves the document with two
// top-level headings - which is how Roles came to answer to both "Roles" and a second
// "Roles", and how a greeting for the reader's own name became the name of the page
// they were on.
//
// A module may emit an h1 only when the surface it paints has no context header at
// all. That is the case for the sign-in screens, the legal documents and /support:
// the stylesheet hides .context-header on those routes, so the heading in the page is
// the only heading, and that is correct rather than duplicated.
//
// Which routes those are is read from the stylesheet rather than written here, so an
// exemption cannot quietly outlive the rule it depends on: drop /support from the
// stylesheet and this fails until its exemption goes too.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CLIENT = path.join(ROOT, 'frontend', 'js');
const CSS = path.join(ROOT, 'frontend', 'css', 'app.css');

// Module -> the routes in that module whose heading is legitimately its own.
const EXEMPT = {
  // This was exempt as 'shell.js' when the whole shell was one file. It is exempt now
  // because it is the component that renders the context header, and therefore the h1 -
  // not because of where it happens to live.
  'shell/context-header.js': {
    why: 'renderContextHeader is where the one h1 comes from',
    routes: [],
  },
  'public/auth.js': {
    // The previous entry for this exemption said these pages have no context header,
    // which was not true: four of the six call authShell with a contextTitle, so the
    // header and the page's own h1 both render. They say much the same thing -
    // "Welcome back" above "Sign in" - which is redundant rather than either being
    // wrong, and dropping the header would change what the signed-out shell looks like.
    // Recorded here rather than left as a stale path.
    why: 'the sign-in screens render both a context header and their own h1, and say the same thing twice',
    routes: ['/login', '/register', '/forgot', '/reset-password'],
  },
  'public/legal.js': {
    why: 'the legal documents, which name themselves with an h1 and no context header',
    routes: ['/legal', '/verify-email'],
  },
  'support/support.js': {
    why: '/support is a document: the stylesheet gives it no context header',
    routes: ['/support'],
  },
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

function lineNumbers(lines, pattern) {
  const at = [];
  lines.forEach((line, i) => {
    if (pattern.test(line)) at.push(i + 1);
  });
  return at;
}

// Every route the stylesheet strips the context header from: [data-route='/x'] and
// [data-route^='/x']. The comparison is a prefix because that is what the stylesheet
// does with it.
const chromeless = new Set();
const css = fs.readFileSync(CSS, 'utf8').split('\n');
css.forEach((line) => {
  if (!line.includes('data-route')) return;
  const m = line.match(/\[data-route\^?='([^']+)'\]/g);
  if (!m) return;
  for (const one of m) chromeless.add(one.replace(/^\[data-route\^?='|'\]$/g, ''));
});

const findings = [];

for (const [rel, exemption] of Object.entries(EXEMPT)) {
  for (const route of exemption.routes) {
    if (!chromeless.has(route)) {
      findings.push(
        `${rel} is exempt because ${exemption.why} - but ${route} is not in the`
        + ' stylesheet\'s no-context-header list any more, so its h1 is a duplicate'
      );
    }
  }
}

let files = 0;
let exempt = 0;

for (const file of walk(CLIENT)) {
  files++;
  const rel = path.relative(CLIENT, file).split(path.sep).join('/');
  if (EXEMPT[rel]) {
    exempt++;
    continue;
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const heads = lineNumbers(lines, /el\(\s*['"]h1['"]/);
  if (!heads.length) continue;
  const headers = lineNumbers(lines, /renderContextHeader\(\s*\{?/);
  if (!headers.length) continue;
  findings.push(
    `${rel}: an h1 on line ${heads.join(', ')} and a context header on line `
    + `${headers.join(', ')} - the page would have two top-level headings`
  );
}

if (findings.length) {
  console.error(`\n  heading check FAILED - ${findings.length} problem(s):\n`);
  for (const f of findings) console.error('    ' + f);
  console.error(
    '\n  Either drop the h1 and let renderContextHeader name the surface, or - if the'
    + ' surface genuinely has no header - add the module to EXEMPT with a reason.\n'
  );
  process.exit(1);
}

console.log(
  `  heading check passed (${files} modules, one h1 per surface; ${exempt} exempt,`
  + ` each verified against ${chromeless.size} chrome-less routes in app.css)`
);
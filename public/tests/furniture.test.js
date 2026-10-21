// The shared furniture.
//
// Every page carries the same masthead and the same footer. They were copied
// into each page by hand, and they drifted: five of the pages had a different
// masthead, one had lost a whole navigation group, and two had links the
// others did not.
//
// So the furniture is written down once and put into the pages by a script,
// and this test is what says the pages still carry it. A page edited by hand
// without the script fails here rather than shipping a different masthead.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');

test('every page carries the shared masthead and footer', () => {
  let output = '';
  let failed = false;
  try {
    output = execFileSync(
      process.execPath,
      [path.join(PUBLIC, 'scripts', 'build-site.mjs'), '--check'],
      { encoding: 'utf8', cwd: PUBLIC }
    );
  } catch (error) {
    failed = true;
    output = String(error.stdout || '') + String(error.stderr || '');
  }
  assert.equal(failed, false, 'the pages do not all carry the shared furniture:\n' + output);
});

test('the masthead and the footer are the same on every page', () => {
  const pages = fs.readdirSync(PUBLIC).filter((name) => name.endsWith('.html'));
  const region = (text, start, end) => {
    const from = text.indexOf(start);
    if (from === -1) return null;
    const to = text.indexOf(end, from);
    if (to === -1) return null;
    return text.slice(from, to + end.length);
  };

  const headers = new Map();
  const footers = new Map();
  for (const name of pages) {
    const text = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
    const header = region(text, '<header class="site-header">', '</header>');
    const footer = region(text, '<footer class="site-footer">', '</footer>');
    assert.ok(header, name + ' has no masthead');
    assert.ok(footer, name + ' has no footer');
    headers.set(name, header);
    footers.set(name, footer);
  }

  const first = pages[0];
  for (const name of pages.slice(1)) {
    assert.equal(headers.get(name), headers.get(first),
      name + ' has a different masthead from ' + first);
    assert.equal(footers.get(name), footers.get(first),
      name + ' has a different footer from ' + first);
  }
});

test('every link in the masthead and the footer points at a page that exists', () => {
  const { serverRoutes } = require('./helpers');
  const routes = serverRoutes();
  const text = fs.readFileSync(path.join(PUBLIC, 'about.html'), 'utf8');
  const region = (start, end) => {
    const from = text.indexOf(start);
    const to = text.indexOf(end, from);
    return text.slice(from, to + end.length);
  };
  const furniture = region('<header class="site-header">', '</header>')
    + region('<footer class="site-footer">', '</footer>');

  const known = new Set(routes.keys());
  for (const match of furniture.matchAll(/href="(\/[^"#]*)"/g)) {
    const href = match[1].replace(/\/$/, '') || '/';
    // The front door is the homepage, which is served from the root.
    if (href === '/') continue;
    // A link into the application is not a page of the site: the application
    // has its own routes and its own mount.
    if (href.startsWith('/app')) continue;
    assert.ok(known.has(href),
      'the furniture links to ' + match[1] + ', which is not a page');
  }
});

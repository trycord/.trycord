// Every internal link on the public site has to point at something that
// exists.
//
// A public site is edited by hand, one file at a time, and a link to a page
// that was renamed is invisible until somebody clicks it. This walks every
// page, pulls out every href and src, and checks each internal target
// against the files on disk and against the routes the server mounts.
//
// External links are reported and not failed: the site cannot know whether
// somebody else's server is up, and a dead link elsewhere is not a defect in
// this repository.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  PUBLIC_DIR,
  SERVER_ONLY_ROUTES,
  APP_PREFIX,
  assetExists,
  serverRoutes,
  htmlFiles,
  read,
  references,
} = require('./helpers');

const ROUTES = serverRoutes();

function isExternal(value) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value);
}

// The path part of a reference, without its query or its fragment.
function targetPath(value) {
  return value.split('#')[0].split('?')[0];
}

test('every internal link and asset on the public site resolves', (t) => {
  const external = new Set();
  const failures = [];

  for (const file of htmlFiles()) {
    const name = path.basename(file);
    const html = read(file);
    const base = path.dirname(file);

    for (const ref of references(html)) {
      const raw = ref.value.trim();
      if (!raw) continue;
      if (raw.startsWith('#')) continue;
      if (isExternal(raw)) {
        if (/^https?:/i.test(raw)) external.add(raw);
        continue;
      }

      const target = targetPath(raw);
      if (!target) continue;

      if (target.startsWith('/')) {
        // The application, mounted at a prefix. The site cannot check it, but
        // the mount has to be resolved by the instance rather than written
        // into the markup, so the link must carry the marker.
        if (target === APP_PREFIX || target.startsWith(APP_PREFIX + '/')) {
          const element = elementFor(html, raw);
          if (!element || !/data-app-link/.test(element)) {
            failures.push(name + ': link into the application without data-app-link: ' + raw);
          }
          continue;
        }
        if (SERVER_ONLY_ROUTES.has(target)) continue;
        const routed = ROUTES.get(target);
        if (routed) {
          if (!fs.existsSync(path.join(PUBLIC_DIR, routed))) {
            failures.push(name + ': link to a route whose file is missing: ' + raw + ' -> ' + routed);
          }
          continue;
        }
        // Anything else is a static file the server serves from this
        // directory: a stylesheet, a script, an image.
        const asset = path.join(PUBLIC_DIR, target.replace(/^\//, ''));
        if (fs.existsSync(asset)) continue;
        // The site has no assets of its own: the icons and the fonts are the
        // client's library, published at the root of the site.
        if (target.startsWith('/assets/') && assetExists(target)) continue;
        failures.push(name + ': link to a file that does not exist: ' + raw);
        continue;
      }

      // A relative reference resolves against the file that carries it.
      const resolved = path.resolve(base, target);
      if (!fs.existsSync(resolved)) {
        failures.push(name + ': relative link to a file that does not exist: ' + raw);
      }
    }
  }

  if (external.size) {
    t.diagnostic('external links found (not checked): ' + [...external].sort().join(', '));
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

// The element a reference came out of, so a check can look at its attributes.
function elementFor(html, value) {
  const index = html.indexOf('"' + value + '"');
  if (index === -1) return null;
  const open = html.lastIndexOf('<', index);
  if (open === -1) return null;
  const close = html.indexOf('>', open);
  if (close === -1) return null;
  return html.slice(open, close + 1);
}

test('the pages the server routes are all present in public/', () => {
  for (const [route, file] of ROUTES) {
    assert.ok(
      fs.existsSync(path.join(PUBLIC_DIR, file)),
      'route ' + route + ' is served from ' + file + ', which is not in public/'
    );
  }
});

test('no page hardcodes an application path without resolving the mount', () => {
  const failures = [];
  for (const file of htmlFiles()) {
    const name = path.basename(file);
    const html = read(file);
    for (const ref of references(html)) {
      if (ref.attribute !== 'href') continue;
      const raw = ref.value.trim();
      if (!raw.startsWith(APP_PREFIX + '/') && raw !== APP_PREFIX) continue;
      const element = elementFor(html, raw);
      if (!element || !/data-app-link/.test(element)) {
        failures.push(name + ': ' + raw);
      }
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('every page carries the scripts it needs and no page loads a script twice', () => {
  const failures = [];
  for (const file of htmlFiles()) {
    const name = path.basename(file);
    const html = read(file);
    const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
    const seen = new Set();
    for (const src of scripts) {
      if (seen.has(src)) failures.push(name + ': loads ' + src + ' twice');
      seen.add(src);
      if (!src.startsWith('/')) continue;
      const resolved = path.join(PUBLIC_DIR, src.replace(/^\//, ''));
      if (!fs.existsSync(resolved)) failures.push(name + ': loads a script that does not exist: ' + src);
    }
    if (!seen.has('/js/site.js')) failures.push(name + ': does not load site.js');
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('the pages that need the API resolver load it', () => {
  const failures = [];
  for (const file of htmlFiles()) {
    const name = path.basename(file);
    const html = read(file);
    // Every page links into the application, so every page needs the
    // resolver that knows where the application is.
    if (/data-app-link/.test(html) && !html.includes('/js/public-api.js')) {
      failures.push(name + ': has application links but does not load public-api.js');
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

// Elements that never have a closing tag.
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'line',
  'polyline', 'polygon', 'ellipse',
]);

test('every page is one well-formed document', () => {
  const failures = [];
  for (const file of htmlFiles()) {
    const name = path.basename(file);
    const html = read(file);

    for (const tag of ['html', 'head', 'body']) {
      const opens = (html.match(new RegExp('<' + tag + '(\\s|>)', 'g')) || []).length;
      const closes = (html.match(new RegExp('</' + tag + '>', 'g')) || []).length;
      if (opens !== 1 || closes !== 1) {
        failures.push(name + ': has ' + opens + ' <' + tag + '> and ' + closes + ' </' + tag + '>');
      }
    }

    const stack = [];
    const pattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
    let match;
    while ((match = pattern.exec(html))) {
      const closing = match[1] === '/';
      const tag = match[2].toLowerCase();
      if (VOID_ELEMENTS.has(tag) || match[3] === '/') continue;
      if (!closing) {
        stack.push(tag);
      } else {
        const open = stack.pop();
        if (open !== tag) {
          failures.push(name + ': </' + tag + '> closes <' + open + '>');
          break;
        }
      }
    }
    if (stack.length) failures.push(name + ': unclosed ' + stack.join(', '));
    if (!html.trimEnd().endsWith('</html>')) {
      failures.push(name + ': does not end with </html>');
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

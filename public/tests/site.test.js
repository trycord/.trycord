// The site's own behaviour, checked against the source.
//
// Four things the site promises and that are easy to break by accident:
// the reveal animation degrades when the browser cannot observe, the contents
// list is generated from the document rather than written by hand, the
// current page is marked for a screen reader, and motion is optional.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PUBLIC_DIR, read, functionBody } = require('./helpers');

const SITE = path.join(PUBLIC_DIR, 'js', 'site.js');
const CSS = path.join(PUBLIC_DIR, 'css', 'site.css');

test('the reveal degrades when the browser cannot observe', () => {
  const source = read(SITE);
  const body = functionBody(source, 'mount') || source;
  // The class that hides the reveal is only added when the observer exists,
  // so a browser without it shows the content rather than hiding it.
  const block = /if \(reveals\.length && 'IntersectionObserver' in window\) \{([\s\S]*?)\n  \}/.exec(source);
  assert.ok(block, 'the reveal observer is not guarded by a feature check');
  assert.match(block[1], /classList\.add\('js'\)/,
    'the class that hides the reveal is added outside the feature check');
  assert.ok(source.indexOf("'IntersectionObserver' in window") < source.indexOf("classList.add('js')"),
    'the js class is added before the observer is checked for');
});

test('the contents list is generated from the document', () => {
  const source = read(SITE);
  assert.match(source, /querySelectorAll\('h2, h3'\)/,
    'the contents list is not built from the page\'s own headings');
  assert.match(source, /toc\.appendChild\(list\)/,
    'the generated contents list is never put on the page');
  // Each heading gets an id, and each entry links to it.
  assert.match(source, /h\.id = /, 'headings are not given ids to link to');
  assert.match(source, /a\.href = '#' \+ h\.id/, 'the entries do not link to the headings');
});

test('the current page is marked for assistive technology', () => {
  const source = read(SITE);
  assert.match(source, /setAttribute\('aria-current', 'page'\)/,
    'the current page is not marked with aria-current');
});

test('the navigation menus are operable from the keyboard', () => {
  const source = read(SITE);
  assert.match(source, /aria-expanded/, 'the menu triggers do not report their state');
  assert.match(source, /e\.key === 'Escape'/, 'the menus cannot be dismissed with Escape');
  // The markup carries the relationship: the button names the region it
  // opens, and the region is the navigation.
  const home = read(path.join(PUBLIC_DIR, 'home.html'));
  assert.match(home, /data-menu-toggle[^>]*aria-controls="site-nav"|aria-controls="site-nav"/,
    'the menu button does not name what it controls');
  assert.match(home, /id="site-nav"/, 'the navigation has no id to control');
});

test('focus is visible', () => {
  const css = read(CSS);
  assert.match(css, /:focus-visible/, 'there is no focus-visible style');
  assert.match(css, /outline:\s*2px solid var\(--color-accent\)/,
    'the focus outline is not drawn');
});

test('motion is optional', () => {
  const css = read(CSS);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/,
    'there is no reduced-motion rule');
  assert.match(css, /transition-duration: 0\.01ms !important/,
    'reduced motion does not switch the transitions off');
  // The reveal animation itself is inside a no-preference query, so a
  // reduced-motion reader never gets it in the first place.
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\)[\s\S]*?\.js \.reveal/,
    'the reveal animation is not guarded by the motion preference');
});

test('the stylesheet the pages load is the one that is shipped', () => {
  for (const name of ['design-tokens.css', 'site.css']) {
    assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'css', name)), 'css/' + name + ' is missing');
  }
  // The generated bundle is the one the pages ask for, and the semantic layer
  // is what it is generated from.
  const bundle = read(path.join(PUBLIC_DIR, 'css', 'design-tokens.css'));
  assert.match(bundle, /--color-accent/, 'the generated bundle has no accent colour');
  const tokens = read(path.join(PUBLIC_DIR, 'css', 'tokens.css'));
  assert.match(tokens, /--color-accent/, 'the semantic layer has no accent colour');
});

test('the brand palette is the one the project uses', () => {
  // The generated bundle carries the brand colour; the semantic layer refers
  // to it by name rather than repeating a raw value.
  const bundle = read(path.join(PUBLIC_DIR, 'css', 'design-tokens.css'));
  assert.match(bundle, /--tc-brand:\s*#FF4D24/i, 'the brand flame orange is missing');
  const tokens = read(path.join(PUBLIC_DIR, 'css', 'tokens.css'));
  assert.match(tokens, /--color-accent:\s*var\(--tc-brand\)/,
    'the semantic layer does not point at the brand colour');
  // The brand faces, in the generated bundle and in the site's own sheet.
  assert.match(bundle, /Manrope/, 'the brand face is missing');
  assert.match(bundle, /JetBrains Mono/, 'the brand mono face is missing');
  const site = read(CSS);
  assert.match(site, /@font-face[\s\S]{0,120}Manrope/, 'the brand face is not loaded');
  assert.match(site, /@font-face[\s\S]{0,120}JetBrains Mono/, 'the brand mono face is not loaded');
});

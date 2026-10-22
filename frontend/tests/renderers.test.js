// Every page in the registry has a renderer.
//
// The registry is the one place that says what a page is. A page with no
// renderer is a page the router cannot open, and the router says so by
// throwing - which reads as a fault box rather than as a missing screen.
//
// The check imports both renderer tables, so it is the tables themselves that
// are read, not a reading of them. Two pages were bound in the mobile module
// and not in the desktop one, and this is the test that says so.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.js';

installDomStub();

const { PAGES, pageById, bind, rendererFor, renderPage, matchRoute } = await import('../packages/registry.js');
const { RENDERERS: DESKTOP } = await import('../js/features/index.js');
const { RENDERERS: MOBILE } = await import('../mobile/js/views/index.js');

test('the registry declares pages', () => {
  assert.ok(PAGES.length > 0, 'the registry declares no pages');
});

test('every page in the registry has a desktop renderer', () => {
  const missing = PAGES.filter((page) => typeof DESKTOP[page.id] !== 'function')
    .map((page) => page.id);
  assert.deepEqual(missing, [], 'pages with no desktop renderer:\n' + missing.join('\n'));
});

test('every page in the registry has a mobile renderer', () => {
  const missing = PAGES.filter((page) => typeof MOBILE[page.id] !== 'function')
    .map((page) => page.id);
  assert.deepEqual(missing, [], 'pages with no mobile renderer:\n' + missing.join('\n'));
});

test('the two renderer tables cover exactly the pages of the registry', () => {
  const known = new Set(PAGES.map((page) => page.id));
  const desktopExtra = Object.keys(DESKTOP).filter((id) => !known.has(id));
  const mobileExtra = Object.keys(MOBILE).filter((id) => !known.has(id));
  assert.deepEqual(desktopExtra, [], 'desktop renderers for pages that do not exist');
  assert.deepEqual(mobileExtra, [], 'mobile renderers for pages that do not exist');
});

test('the registry resolves a renderer for every page', () => {
  // The registry holds one table, and each module binds its own at boot. The
  // two documents never run at once, so the table is bound here the way each
  // module binds it.
  bind(DESKTOP);
  const missingDesktop = PAGES.filter((page) => !rendererFor(page)).map((page) => page.id);
  assert.deepEqual(missingDesktop, [], 'pages the desktop registry cannot resolve:\n' + missingDesktop.join('\n'));

  bind(MOBILE);
  const missingMobile = PAGES.filter((page) => !rendererFor(page)).map((page) => page.id);
  assert.deepEqual(missingMobile, [], 'pages the mobile registry cannot resolve:\n' + missingMobile.join('\n'));
});

test('rendering a page does not fail for want of a renderer', () => {
  // A renderer may refuse the context it is given - a page that needs a
  // community is told so - but it must never be the registry saying it has
  // nothing to draw. That was the fault two admin pages produced.
  bind(DESKTOP);
  for (const page of PAGES) {
    try {
      renderPage(page, { page, params: {}, rest: [] });
    } catch (error) {
      const message = String((error && error.message) || '');
      assert.ok(
        message.indexOf('No renderer for page') === -1,
        'rendering ' + page.id + ' failed for want of a renderer',
      );
    }
  }
});

test('the pages that were unbound are bound', () => {
  // The two pages the audit named: they existed in the registry, and their
  // renderers existed, but the desktop table did not name them.
  for (const id of ['admin.approvals', 'admin.diagnostics']) {
    const page = pageById(id);
    assert.ok(page, id + ' is not in the registry');
    assert.equal(typeof DESKTOP[id], 'function', id + ' has no desktop renderer');
    assert.equal(typeof MOBILE[id], 'function', id + ' has no mobile renderer');
  }
});

test('the sections of the developer console answer to addresses of their own', () => {
  // /developer opens the console; /developer/applications opens the same
  // console on the applications section, so a link can name the place it
  // means. The bare address is still the bare page: no name in it, no
  // section forced by it.
  const cases = [
    ['/developer/keys', 'keys'],
    ['/developer/applications', 'applications'],
    ['/developer/documentation', 'documentation'],
  ];
  for (const [route, wanted] of cases) {
    const match = matchRoute(route);
    assert.ok(match, route + ' resolves to a page');
    assert.equal(match.page.id, 'developer.' + wanted, route + ' is the ' + wanted + ' page');
    assert.equal(typeof DESKTOP[match.page.id], 'function', route + ' has no desktop renderer');
    assert.equal(typeof MOBILE[match.page.id], 'function', route + ' has no mobile renderer');
  }
  const bare = matchRoute('/developer');
  assert.equal(bare.page.id, 'developer', 'the bare address is still the bare page');
});

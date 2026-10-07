#!/usr/bin/env node
'use strict';

// The page contract, and the navigation built from it.
//
// Two rules, checked together because they are the same rule seen from two sides.
//
// The contract: a page is { id, route, scope, render } plus whatever that page genuinely
// needs. The brief is explicit that the definition must not grow a field for every
// conceivable concern - mobileLayout, hooks, middleware, analytics, data, state - unless
// something reads it. A registry that accumulates fields nothing consumes is one nobody
// can hold in their head, and the first field added for one page becomes an obligation
// for the next forty.
//
// The navigation: rail and phone tab bar both come from this one file, so a destination
// that is offered must be a page that exists, and a page that is offered must not be
// hidden. A nav entry pointing at nothing is a dead control, and one pointing at a page
// marked hidden is the same thing wearing a different hat.
//
// The registry is imported and its real page objects inspected. An earlier version read
// the source with a regular expression and matched 37 of the 44 literal definitions -
// which is a worse outcome than no check, because the pages it silently skipped were
// exactly the ones it would have complained about.

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const CLIENT = path.join(__dirname, '..', '..', 'frontend', 'js');
const REGISTRY = path.join(CLIENT, 'pages', 'registry.js');

// Fields the contract is allowed to have. Every one is read by something; the comment
// says by what, because a permitted field nothing reads is what this check exists to
// stop.
const ALLOWED = {
  id: 'the key renderers are bound by',
  route: 'the address the matcher uses',
  scope: 'which navigation tree the page belongs to',
  access: "'session', 'public' or 'guest' - the router's gate",
  layout: "which of the shell's shapes the page needs; layout.js owns the measurements",
  sidebar: 'which sidebar, for the pages whose layout has one',
  nav: 'rail and phone tab bar membership, icon and label',
  label: 'the settings and admin navigation name',
  blurb: 'the one line under that name',
  tabs: 'which section of the scope this page is, for settings and admin',
  hidden: 'a page that exists but is never offered in navigation',
  aliasOf: 'a second address for a page that already exists',
  order: 'position inside its group',
  group: 'the group heading a page is listed under',
  icon: 'the settings and admin navigation glyph; nav.icon is the rail and tab bar one',
  guestTo: 'where a signed-in visitor to a guest page is sent instead',
};

let passed = 0;
const failures = [];
function ok(label, condition, detail) {
  if (condition) {
    passed++;
    console.log('    ok   ' + label);
  } else {
    failures.push(label + (detail ? ' <- ' + detail : ''));
    console.log('    FAIL ' + label + (detail ? '  <- ' + detail : ''));
  }
}

(async () => {
  const registry = await import(pathToFileURL(REGISTRY).href);
  const PAGES = registry.PAGES;
  const { mobilePages, railPages } = registry;

  console.log('\n  the page contract');
  console.log(`    ${PAGES.length} pages, read from the module rather than the source`);

  ok('every page has an id', PAGES.every((p) => typeof p.id === 'string' && p.id),
    PAGES.filter((p) => !p.id).length + ' without one');

  const ids = PAGES.map((p) => p.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  ok('no two pages share an id', dupes.length === 0, [...new Set(dupes)].join(', '));

  // The contract discipline: nothing outside the allowed set, on any page.
  const unknown = new Map();
  for (const page of PAGES) {
    for (const field of Object.keys(page)) {
      if (ALLOWED[field]) continue;
      if (!unknown.has(field)) unknown.set(field, []);
      unknown.get(field).push(page.id);
    }
  }
  ok('every field a page defines is one the contract allows', unknown.size === 0,
    [...unknown].map(([f, ids2]) => f + ' (on ' + ids2.length + ' pages, e.g. '
      + ids2[0] + ')').join('; '));

  // A field the contract permits but no page sets is only dead if nothing reads it
  // either - which is a question about the rest of the client.
  const unused = Object.keys(ALLOWED).filter((f) => !PAGES.some((p) => f in p));
  const readSomewhere = (field) => {
    const re = new RegExp('\\.' + field + '\\b');
    return walk(CLIENT).some((file) => file !== REGISTRY
      && re.test(fs.readFileSync(file, 'utf8')));
  };
  const trulyDead = unused.filter((f) => !readSomewhere(f));
  ok('no permitted field is dead weight', trulyDead.length === 0,
    trulyDead.join(', ') || (unused.length ? unused.length + ' unused by pages but read elsewhere' : ''));

  // Longest-prefix matching means two pages cannot share a path, or one is unreachable.
  const paths = PAGES.filter((p) => p.route).map((p) => p.route);
  const dupePaths = paths.filter((x, i) => paths.indexOf(x) !== i);
  ok('no two pages claim the same route', dupePaths.length === 0, [...new Set(dupePaths)].join(', '));

  console.log('\n  navigation built from the registry');

  const withNav = PAGES.filter((p) => p.nav);
  const hiddenInNav = withNav.filter((p) => p.hidden);
  ok('no navigation entry points at a hidden page', hiddenInNav.length === 0,
    hiddenInNav.map((p) => p.id).join(', '));

  // A nav entry has to resolve. The rail and the tab bar both go through the matcher, so
  // a path in nav that no page declares is a control that navigates nowhere.
  const known = new Set(paths);
  const dangling = withNav.filter((p) => p.route && !known.has(p.route));
  ok('every navigation destination is a page that exists', dangling.length === 0,
    dangling.map((p) => p.id + ' -> ' + p.route).join(', '));

  const rail = railPages();
  const tabs = mobilePages();
  ok('the rail is not empty', rail.length > 0, rail.length + ' destinations');
  ok('the phone tab bar is not empty', tabs.length > 0, tabs.length + ' destinations');

  // A page in no navigation at all is either reached by circumstance or orphaned, and the
  // two are worth telling apart.
  //
  // Reached by circumstance: the signed-out screens and the public documents, which a
  // reader meets because they followed a link or because they are not signed in. Those
  // carry access 'guest' or 'public' rather than nav, and that is the answer, not an
  // omission. Also the sub-pages that hang off a destination with an id of their own -
  // /dms/:id under /dms, /server/:id/channel/:cid under the community - which are reached
  // by choosing something inside the parent, not by picking a nav entry.
  //
  // Orphaned would be a page with a session access, no nav, no tabs and no parent, which
  // nothing links to.
  const inNavigation = new Set([...rail, ...tabs].map((p) => p.id));
  const isSubPage = (p) => p.route.split('/').filter(Boolean)
    .some((segment, i, all) => i > 0 && segment.startsWith(':')
      && all.slice(0, i).join('/') !== '');
  const reachedSomehow = (p) => inNavigation.has(p.id) || p.access === 'guest'
    || p.access === 'public' || isSubPage(p) || p.scope === 'community';
  const orphaned = PAGES.filter((p) => (p.hidden || p.nav || p.tabs || p.scope)
    ? false
    : !reachedSomehow(p));
  ok('no page is orphaned from every way in', orphaned.length === 0,
    orphaned.map((p) => p.id + ' (access=' + (p.access || 'session') + ')').join(', '));

  // Tab order is what puts Friends before Alerts on a phone and the other way round in
  // the rail. A tab with no order silently falls back to registry order, which looks
  // deliberate and is not.
  const inTabs = PAGES.filter((p) => p.nav && p.nav.mobile);
  const unordered = inTabs.filter((p) => p.nav.tabOrder == null);
  ok('every phone tab says where it goes', unordered.length === 0,
    unordered.map((p) => p.id).join(', ') + ' fall back to registry order');

  const ordered = inTabs.filter((p) => p.nav.tabOrder != null);
  const orders = ordered.map((p) => p.nav.tabOrder);
  ok('no two phone tabs claim the same position', new Set(orders).size === orders.length,
    orders.join(', '));

  // A tab with a label but no icon renders a blank button.
  const noIcon = withNav.filter((p) => !p.nav.icon);
  ok('every navigation entry has an icon', noIcon.length === 0,
    noIcon.map((p) => p.id).join(', '));

  console.log(`\n  registry check ${failures.length ? 'FAILED - ' + failures.length + ' problem(s)' : 'passed'}`
    + ` - ${passed} assertions over ${PAGES.length} pages\n`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('\n  the registry could not be read: ' + e.message + '\n');
  process.exit(1);
});

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}
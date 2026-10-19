// The studios: the admin console and the account settings.
//
// Both are dispatchers: a page id names a section, and the section draws the
// page. A page that the dispatcher does not know is a page that opens empty -
// the rail still offers it, and the reader is left in front of nothing. The
// rail comes from the registry, so every page in the registry that the rail
// offers has to be answered here.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { installDomStub } from './helpers/dom-stub.js';
import { MODULES, read } from './helpers/source.js';

installDomStub();

const { PAGES, scopeNav } = await import('../packages/registry.js');
const { renderAdmin } = await import('../js/features/admin.js');
const { renderSettings } = await import('../js/features/settings.js');

function pageOf(id) {
  return PAGES.find((page) => page.id === id) || null;
}

test('every page the admin rail offers opens a section', () => {
  const offered = scopeNav('admin').flatMap((group) => group.items.map((item) => item.id));
  assert.ok(offered.length > 0, 'the admin rail offers nothing');
  for (const id of offered) {
    const page = pageOf(id);
    assert.ok(page, id + ' is offered by the rail but is not in the registry');
    const result = renderAdmin({ page, params: {}, rest: [] });
    assert.ok(result, id + ' opens nothing');
    assert.ok(result.node, id + ' opens a page with no content');
    assert.ok(String(result.node.textContent || '').length > 0, id + ' opens an empty page');
  }
});

test('every page the settings rail offers opens a section', () => {
  const offered = scopeNav('account').flatMap((group) => group.items.map((item) => item.id));
  assert.ok(offered.length > 0, 'the settings rail offers nothing');
  for (const id of offered) {
    const page = pageOf(id);
    assert.ok(page, id + ' is offered by the rail but is not in the registry');
    const result = renderSettings({ page, params: {}, rest: [] });
    assert.ok(result, id + ' opens nothing');
    assert.ok(result.node, id + ' opens a page with no content');
    assert.ok(String(result.node.textContent || '').length > 0, id + ' opens an empty page');
  }
});

test('the admin studio names every section it draws', () => {
  // The pages the audit named: two of them existed in the registry and had
  // renderers, but the desktop table never bound them, so they answered with
  // a fault. The dispatcher had the same shape of fault for one more.
  for (const id of ['admin.users', 'admin.approvals', 'admin.diagnostics']) {
    const page = pageOf(id);
    assert.ok(page, id + ' is not in the registry');
    const result = renderAdmin({ page, params: {}, rest: [] });
    assert.ok(result && result.node, id + ' has no section');
  }
});

test('the mobile admin names every section the strip offers', () => {
  // The mobile strip is built from the registry, so every page it offers has
  // to have a body: a page with no body answers with the overview, which is
  // a different page wearing its name.
  const source = read(path.join(MODULES.mobile, 'views', 'admin.js'));
  const match = /const bodies = \{([\s\S]*?)\n  \};/.exec(source);
  assert.ok(match, 'the mobile admin has no section table');
  const named = [];
  const re = /^\s*'([^']+)':|^\s*([a-zA-Z][\w]*):/gm;
  let entry;
  while ((entry = re.exec(match[1]))) named.push(entry[1] || entry[2]);

  const offered = scopeNav('admin').flatMap((group) => group.items.map((item) => item.id));
  const missing = offered.filter((id) => !named.includes(id));
  assert.deepEqual(missing, [], 'admin pages the mobile module has no section for:\n' + missing.join('\n'));
});

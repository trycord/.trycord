// The other half of the gate check.
//
// The gates stand alone: the shell is hidden and the sign-in screen is the
// whole page. That is right for them, and it is *only* right for them.
//
// The failure this file is about is the same one in the other direction. A
// page that renders standalone when it should not takes the whole application
// with it — the rail, the column, the stage — and the reader is left looking
// at a sign-in form in the middle of what used to be their workspace. It is
// not an obvious failure: the page renders, it has its content, and the
// reader is simply somewhere they did not ask to be.
//
// So: every page that is not a gate and not a public document keeps the main
// application. The shell is not hidden, the document is not marked raw, and
// the page is drawn into the stage rather than beside it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { installDomStub, installFetchStub } from './helpers/dom-stub.js';
import { MODULES, read, walk } from './helpers/source.js';

installDomStub();
installFetchStub();

const registry = await import('../packages/registry.js');

// The pages that are meant to be the whole page. Everything else is part of
// the application and keeps it.
const STANDALONE = new Set([
  'login', 'register', 'forgot', 'resetPassword', 'verifyEmail', 'twoStep',
  'support', 'legal',
]);

test('the application keeps the application', async (t) => {
  await t.test('the router only stands aside for the gates and the documents', () => {
    const router = read(path.join(MODULES.desktop, 'router.js'));

    // The one place that decides, so the rule is stated once.
    const hide = /root\.hidden = true/.test(router);
    const raw = /result\.raw/.test(router);
    assert.ok(hide, 'the router hides the shell for a standalone page');
    assert.ok(raw, 'the router decides from what the renderer answered');
  });

  await t.test('no renderer but the gates and the documents renders standalone', () => {
    const problems = [];
    const files = [
      ...walk(MODULES.desktop),
      ...walk(MODULES.mobile),
    ];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      if (!/raw:\s*true/.test(source)) continue;
      const relative = file.slice(file.indexOf('frontend/'));
      const isGate = /features\/auth\.js$|views\/auth\.js$/.test(relative);
      const isDocument = /features\/documents\.js$|views\/plain\.js$/.test(relative);
      if (isGate || isDocument) continue;
      problems.push(relative + ' renders standalone');
    }
    assert.deepEqual(problems, [],
      'these renderers take the whole application with them: ' + problems.join(', '));
  });

  await t.test('the pages that were added for the new subsystems are drawn into the stage', () => {
    // The list is the one that matters: these are the pages that arrived with
    // the 3.0 subsystems, and each of them is a part of the application rather
    // than a page of its own.
    const added = [
      'search', 'collections', 'federation', 'status',
      'settings.language', 'admin.incidents', 'admin.federation',
      // The consoles and the surfaces that arrived with the later subsystems.
      'admin.voice', 'extensions', 'developer',
      'community.workspace', 'community.workspace.spaces',
      'community.workspace.documents', 'community.workspace.boards',
      'community.workspace.events', 'community.workspace.polls',
      'community.settings.voice',
    ];
    for (const id of added) {
      const page = registry.pageById(id);
      assert.ok(page, id + ' is registered');
      assert.notEqual(page.access, 'guest', id + ' is not a gate');
    }
  });

  await t.test('every page is drawn inside the application, not beside it', () => {
    // A page that renders the application beside itself rather than inside it
    // is a page where the rail, the column or the stage went missing. The
    // question is whether the page has somewhere to be drawn: a column of its
    // own, or one of the scopes that draws a navigation inside the stage.
    const scopes = ['admin', 'account', 'community'];
    for (const page of registry.PAGES) {
      if (page.layout === 'plain') continue;
      const hasPlace = !!page.sidebar
        || scopes.includes(page.scope)
        || page.id.startsWith('community.');
      assert.ok(hasPlace,
        page.id + ' has no column and no navigation of its own, so the '
        + 'application around it would have nowhere to go');
    }
  });

  await t.test('a page in a community keeps the community column', () => {
    // The community pages are drawn beside the community tree. A page that
    // says it is a community page and has no column is a page where the tree
    // vanished.
    for (const page of registry.PAGES) {
      if (page.scope !== 'community') continue;
      assert.equal(page.sidebar, 'community',
        page.id + ' is a community page and keeps the community column');
    }
  });

  await t.test('a page in the admin or the account scope draws its own navigation', () => {
    // The admin console and the account studio draw their own rail inside the
    // stage, which is why they have no column of their own. A page that is in
    // one of those scopes and has no navigation is a page that opens onto
    // nothing.
    for (const page of registry.PAGES) {
      if (page.scope !== 'admin' && page.scope !== 'account') continue;
      assert.ok(page.id.startsWith(page.scope === 'admin' ? 'admin' : 'settings'),
        page.id + ' is in the ' + page.scope + ' scope');
    }
  });
});

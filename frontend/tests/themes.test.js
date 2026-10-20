// The theme packages.
//
// A theme is values with a schema version, not code. A package this build does
// not know is refused, and refused before it is sent. A package that is
// accepted is previewed - the colours that would move are shown - before it
// is applied, and the theme that was in force can be put back.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub, waitFor } from './helpers/dom-stub.js';

installDomStub();

const { setToken } = await import('../packages/api.js');
const theme = await import('../packages/theme.js');
const { themePackages } = await import('../js/features/settingsThemes.js');

function find(node, predicate, found = []) {
  if (!node) return found;
  if (Array.isArray(node)) {
    for (const entry of node) find(entry, predicate, found);
    return found;
  }
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return find.length ? found : found;
}

function classed(word) {
  return (node) => {
    const value = node.getAttribute && node.getAttribute('class');
    return !!value && value.split(/\s+/).indexOf(word) !== -1;
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A shell that measures. The rule is that a theme that breaks the shell is
// refused, and a shell that measures nothing is a shell that broke.
function withShell() {
  const shell = document.createElement('div');
  shell.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 });
  document.getElementById = (id) => (id === 'shell' ? shell : null);
  return shell;
}

const PACKAGE = {
  schemaVersion: 1,
  name: 'Ember',
  version: '1.0.0',
  tokens: { accent: '#00AAFF', pg: '#101014', base: '#181820', txt: '#F4F5F7' },
};

test('a package this build does not know is refused', () => {
  const checked = theme.validateThemePackage(Object.assign({}, PACKAGE, { schemaVersion: 99 }));
  assert.equal(checked.theme, null, 'a package of an unknown version was accepted');
  assert.ok(checked.problems.some((problem) => /not known to this build/.test(problem)),
    'the refusal did not name the version');
});

test('a package that carries something else is refused', () => {
  const checked = theme.validateThemePackage(Object.assign({}, PACKAGE, { script: 'alert(1)' }));
  assert.equal(checked.theme, null);
  assert.ok(checked.problems.some((problem) => /not a field/.test(problem)));
});

test('the preview says what the package would change', () => {
  const preview = theme.previewThemePackage(PACKAGE, theme.DEFAULT_CUSTOM_TOKENS);
  assert.equal(preview.ok, true, 'a good package was refused');
  assert.ok(preview.changes.length, 'the preview said nothing would change');
  const accent = preview.changes.find((change) => change.key === 'accent');
  assert.equal(accent.to, '#00AAFF');
  assert.equal(accent.from, theme.DEFAULT_CUSTOM_TOKENS.accent);
});

test('a package is previewed before it is applied, and then it is applied', async () => {
  setToken('reader-a');
  withShell();
  const calls = installFetchStub({
    'http://localhost/api/themes': {
      json: {
        schema: { knownSchemaVersions: [1], tokenKeys: ['accent', 'pg', 'base', 'txt'] },
        active: { id: 'th1', name: 'Ember', version: '1.0.0', schemaVersion: 1, tokens: { accent: '#FF4D24' } },
        themes: [{ id: 'th1', name: 'Ember', version: '1.0.0', schemaVersion: 1, state: 'active' }],
      },
    },
    'http://localhost/api/themes/rollback': {
      json: { id: 'th1', name: 'Ember', version: '1.0.0', tokens: { accent: '#FF4D24' } },
    },
  });

  const view = themePackages();
  await view.onMount();

  const importButton = await waitFor(() => find(view.node, (node) => node.tagName === 'BUTTON'
    && String(node.textContent).indexOf('Import a package') !== -1)[0]);
  assert.ok(importButton, 'there is no way to import a package');
  importButton.click();

  const dialog = await waitFor(() => find(document.body, classed('dialog'))
    .filter((node) => String(node.textContent).indexOf('Import a theme package') !== -1)[0]);
  assert.ok(dialog, 'the import opened no dialog');
  const area = find(dialog, (node) => node.tagName === 'TEXTAREA')[0];
  area.value = JSON.stringify(PACKAGE);

  const previewButton = find(dialog, (node) => node.tagName === 'BUTTON'
    && String(node.textContent).indexOf('Preview it') !== -1)[0];
  assert.ok(previewButton, 'there is no way to preview a package');
  previewButton.click();

  // The preview is drawn before anything is sent.
  const previewed = await waitFor(() => String(dialog.textContent || '').indexOf('would change') !== -1);
  assert.ok(previewed, 'the preview was not shown');
  assert.equal(calls.filter((call) => call.url.indexOf('/api/themes/import') !== -1).length, 0,
    'the package was sent before it was previewed');

  const form = find(dialog, (node) => node.tagName === 'FORM')[0];
  form.submit();

  const posted = await waitFor(() => calls.find((call) => call.url.indexOf('/api/themes/import') !== -1));
  assert.ok(posted, 'the package was never sent');
  assert.deepEqual(posted.body, { theme: PACKAGE });
});

test('a package this build does not know is never sent', async () => {
  setToken('reader-a');
  withShell();
  const calls = installFetchStub({
    'http://localhost/api/themes': {
      json: { schema: { knownSchemaVersions: [1], tokenKeys: [] }, active: null, themes: [] },
    },
  });

  const view = themePackages();
  await view.onMount();

  const importButton = await waitFor(() => find(view.node, (node) => node.tagName === 'BUTTON'
    && String(node.textContent).indexOf('Import a package') !== -1)[0]);
  assert.ok(importButton, 'there is no way to import a package');
  importButton.click();

  const dialog = await waitFor(() => find(document.body, classed('dialog'))
    .filter((node) => String(node.textContent).indexOf('Import a theme package') !== -1)[0]);
  assert.ok(dialog, 'the import opened no dialog');
  const area = find(dialog, (node) => node.tagName === 'TEXTAREA')[0];
  area.value = JSON.stringify(Object.assign({}, PACKAGE, { schemaVersion: 99 }));

  const form = find(dialog, (node) => node.tagName === 'FORM')[0];
  form.submit();

  const refused = await waitFor(() => String(dialog.textContent || '').indexOf('refused') !== -1);
  assert.ok(refused, 'the refusal was not shown');
  assert.equal(calls.filter((call) => call.url.indexOf('/api/themes/import') !== -1).length, 0,
    'a package of an unknown version was sent');
});

test('the theme in force can be put back', async () => {
  setToken('reader-a');
  withShell();
  const calls = installFetchStub({
    'http://localhost/api/themes': {
      json: { schema: { knownSchemaVersions: [1], tokenKeys: [] }, active: null, themes: [] },
    },
    'http://localhost/api/themes/rollback': {
      json: { id: 'th1', name: 'Ember', version: '1.0.0', tokens: { accent: '#FF4D24' } },
    },
  });

  const view = themePackages();
  await view.onMount();

  const rollback = await waitFor(() => find(view.node, (node) => node.tagName === 'BUTTON'
    && String(node.textContent).indexOf('Roll back') !== -1)[0]);
  assert.ok(rollback, 'there is no way to roll back');
  rollback.click();

  const posted = await waitFor(() => calls.find((call) => call.url.indexOf('/api/themes/rollback') !== -1));
  assert.ok(posted, 'the rollback was never sent');
  assert.equal(posted.options.method, 'POST');
});

// A route change is a page change.
//
// The client swaps the stage without reloading the document. Nothing about that
// tells a screen reader the page under the reader changed, and nothing moves a
// keyboard reader off the link they followed. The page's own heading is the
// name of where they are, so that is what receives focus. A screen without a
// heading falls back to the stage.
//
// The phone has the same duty, and the document title has to follow the screen
// as well: it is the name the tab, the history entry and the screen reader all
// read before the page itself is reached.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { installDomStub } from './helpers/dom-stub.js';
import { MODULES, read } from './helpers/source.js';

installDomStub();

const { focusStage } = await import('../js/shell.js');
const { setTitle } = await import('../mobile/js/shell.js');

test('the desk moves focus to the heading of the page it just painted', () => {
  const root = document.createElement('div');
  root.setAttribute('id', 'view-root');
  root.setAttribute('tabindex', '-1');
  const heading = document.createElement('h1');
  heading.textContent = 'Home';
  root.appendChild(heading);
  document.body.appendChild(root);

  assert.equal(focusStage(), true, 'there was no stage to focus');
  assert.equal(document.activeElement, heading, 'the page heading was not announced');
  assert.equal(heading.getAttribute('tabindex'), '-1',
    'the heading cannot receive focus without joining the tab order');

  root.remove();
});

test('a page that focused its own field keeps it', () => {
  const root = document.createElement('div');
  root.setAttribute('id', 'view-root');
  root.setAttribute('tabindex', '-1');
  const heading = document.createElement('h1');
  heading.textContent = 'Search';
  const field = document.createElement('input');
  field.setAttribute('type', 'search');
  root.appendChild(heading);
  root.appendChild(field);
  document.body.appendChild(root);
  field.focus();

  assert.equal(focusStage(), true);
  assert.equal(document.activeElement, field, 'the page\'s own focus was taken away');
  assert.equal(heading.getAttribute('tabindex'), null,
    'the heading was made focusable even though the page had a landing place');

  root.remove();
});

test('a page without a heading falls back to the stage', () => {
  const root = document.createElement('div');
  root.setAttribute('id', 'view-root');
  root.setAttribute('tabindex', '-1');
  document.body.appendChild(root);

  assert.equal(focusStage(), true);
  assert.equal(document.activeElement, root, 'the stage was not focused');

  root.remove();
});

test('the phone names the document for the screen it is on', () => {
  setTitle('Home');
  assert.equal(document.title, 'Home - Trycord');

  setTitle('');
  assert.equal(document.title, 'Trycord');
});

test('the phone focuses the screen heading, not only the container', () => {
  const shell = read(path.join(MODULES.mobile, 'shell.js'));
  assert.match(shell, /refs\.view\.querySelector\('h1'\)/,
    'the phone does not look for the screen heading');
  assert.match(shell, /const target = heading \|\| refs\.view/,
    'the phone does not fall back to the view when there is no heading');
});

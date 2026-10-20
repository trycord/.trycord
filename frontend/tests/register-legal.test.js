// The registration form and the acceptance of the documents.
//
// The acceptance is the one control on the registration form a reader cannot
// do without, and it used to be the last line of a long form: a checkbox
// below five fields, with the submit button disabled and nothing saying why.
// On a phone that is below the fold, so the form looked broken - and the
// deployment that served the old client had no control at all.
//
// The checks here are that the control is there, that it is before the
// fields rather than after them, that the documents are named and linked, and
// that the button says why it is closed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub, installFetchStub } from './helpers/dom-stub.js';

installDomStub();

const { registerGate } = await import('../js/features/auth.js');
const { State } = await import('../packages/store.js');

function find(node, predicate, found = []) {
  if (!node) return found;
  if (node.tagName && predicate(node)) found.push(node);
  for (const child of node.children || []) find(child, predicate, found);
  return found;
}

function byText(node, text) {
  const found = find(node, (candidate) => (candidate.textContent || '').indexOf(text) !== -1);
  let deepest = found[0] || null;
  for (const candidate of found) {
    if (!deepest) { deepest = candidate; continue; }
    if ((candidate.textContent || '').length < (deepest.textContent || '').length) deepest = candidate;
  }
  return deepest;
}

function byClass(node, name) {
  return find(node, (candidate) => candidate.classList && candidate.classList.contains(name))[0] || null;
}

test('the registration form asks for the documents before the fields', async () => {
  installFetchStub({
    'http://localhost/api/legal': { json: { termsVersion: '1.0', privacyVersion: '1.0', updated: '2026-09-20' } },
  });
  State.legal = { termsVersion: '1.0', privacyVersion: '1.0', updated: '2026-09-20' };

  const view = registerGate();
  const form = [].concat(view).find((node) => node && node.tagName === 'FORM');
  assert.ok(form, 'the registration form was not drawn');

  // The acceptance.
  const checkbox = find(form, (node) => node.tagName === 'INPUT'
    && node.getAttribute('type') === 'checkbox')[0];
  assert.ok(checkbox, 'the registration form has no acceptance control');

  // The two documents, named and linked.
  const links = find(form, (node) => node.tagName === 'A');
  const hrefs = links.map((link) => link.getAttribute('href') || '');
  assert.ok(hrefs.some((href) => href.indexOf('/terms') !== -1), 'the Terms of Service are not linked');
  assert.ok(hrefs.some((href) => href.indexOf('/privacy') !== -1), 'the Privacy Policy is not linked');
  assert.match(form.textContent, /Terms of Service/, 'the Terms of Service are not named');
  assert.match(form.textContent, /Privacy Policy/, 'the Privacy Policy is not named');

  // The versions in force are stated, because the server records exactly
  // those and refuses a registration whose versions have moved on.
  assert.match(form.textContent, /1\.0/, 'the versions in force are not stated');

  // The control comes before the fields. A reader asked to accept something
  // after a form is asked to accept it after the form.
  const fields = find(form, (node) => node.classList && node.classList.contains('field'));
  assert.ok(fields.length, 'the form has no fields');
  const firstField = fields[0];
  const order = [];
  const walk = (node) => {
    if (node === checkbox || node === firstField) order.push(node === checkbox ? 'checkbox' : 'field');
    for (const child of node.children || []) walk(child);
  };
  walk(form);
  assert.deepEqual(order.slice(0, 2), ['checkbox', 'field'],
    'the acceptance is not before the fields: ' + order.join(', '));
});

test('the button says why it is closed', async () => {
  installFetchStub({
    'http://localhost/api/legal': { json: { termsVersion: '1.0', privacyVersion: '1.0' } },
  });
  State.legal = { termsVersion: '1.0', privacyVersion: '1.0' };

  const view = registerGate();
  const form = [].concat(view).find((node) => node && node.tagName === 'FORM');
  const submit = find(form, (node) => node.tagName === 'BUTTON'
    && node.getAttribute('type') === 'submit')[0];
  assert.ok(submit, 'the form has no submit button');
  assert.equal(submit.disabled, true, 'the button is not closed until the documents are accepted');

  const note = byClass(form, 'gate-submit-note');
  assert.ok(note, 'nothing says why the button is closed');
  assert.match(note.textContent, /Accept the Terms of Service/i,
    'the note does not say what to do: ' + note.textContent);

  // Accepting them opens the button and the note goes away.
  const checkbox = find(form, (node) => node.tagName === 'INPUT'
    && node.getAttribute('type') === 'checkbox')[0];
  checkbox.checked = true;
  checkbox.dispatch('change');
  assert.equal(submit.disabled, false, 'the button stayed closed after the documents were accepted');
  assert.equal(note.textContent, '', 'the note is still there after the documents were accepted');
});

test('the acceptance says whether it has been accepted', async () => {
  installFetchStub({
    'http://localhost/api/legal': { json: { termsVersion: '1.0', privacyVersion: '1.0' } },
  });
  State.legal = { termsVersion: '1.0', privacyVersion: '1.0' };

  const view = registerGate();
  const form = [].concat(view).find((node) => node && node.tagName === 'FORM');
  assert.match(form.textContent, /Not accepted yet/i, 'the form does not say the documents are unaccepted');

  const checkbox = find(form, (node) => node.tagName === 'INPUT'
    && node.getAttribute('type') === 'checkbox')[0];
  checkbox.checked = true;
  checkbox.dispatch('change');
  assert.match(form.textContent, /Accepted/i, 'the form does not say the documents were accepted');
});

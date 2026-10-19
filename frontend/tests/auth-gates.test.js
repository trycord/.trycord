// The gates: the screens a reader meets before there is a workspace.
//
// Three things are checked here, and they are the three that broke.
//
//   - the screens stand alone: the shell is hidden and the gate is the whole
//     page, not a panel inside the application;
//   - a registration carries the versions of the documents the reader
//     accepted, and cannot be sent before they are accepted;
//   - the recovery path asks for what the server reads, so a reset link
//     works.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { installDomStub, installFetchStub } from './helpers/dom-stub.js';
import { CLIENT, MODULES, read } from './helpers/source.js';

installDomStub();

const { renderAuth } = await import('../js/features/auth.js');
const { State } = await import('../packages/store.js');
const registry = await import('../packages/registry.js');

function gateFor(id, params) {
  const page = registry.pageById(id);
  return renderAuth(page, params || {});
}

// The form's fields, by the name they carry.
function fieldsOf(form) {
  const byName = {};
  for (const input of form.querySelectorAll('input')) {
    byName[input.getAttribute('name')] = input;
  }
  return byName;
}

test('the gates stand alone', () => {
  for (const id of ['login', 'register', 'forgot', 'resetPassword', 'verifyEmail', 'twoStep']) {
    const result = gateFor(id, { token: 'abc' });
    assert.equal(result.raw, true, id + ' is not a standalone page');
    assert.ok(result.node, id + ' has no node');
    assert.ok(result.node.className.includes('auth-page'), id + ' is not an auth page');
  }
});

test('the shell is hidden under a standalone page, and the rule that hides it is in the stylesheet', () => {
  const router = read(path.join(MODULES.desktop, 'router.js'));
  assert.match(router, /root\.hidden = true/, 'the router does not hide the shell');
  assert.match(router, /dataset\.raw = 'true'/, 'the router does not mark the document as raw');

  const css = fs.readFileSync(path.join(CLIENT, 'css', 'app.css'), 'utf8');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/,
    'the stylesheet does not let the hidden attribute win over a component display');
});

test('a registration cannot be sent before the documents are accepted', async () => {
  const result = gateFor('register');
  const form = result.node.querySelector('form');
  assert.ok(form, 'the registration form is not there');

  const checkbox = form.querySelector('input[name="legal"]');
  assert.ok(checkbox, 'the registration form has no acceptance control');

  const submit = form.querySelector('button[type="submit"]');
  assert.ok(submit, 'the registration form has no submit button');
  assert.equal(submit.disabled, true, 'the form can be sent before the documents are accepted');

  checkbox.checked = true;
  checkbox.dispatch('change');
  assert.equal(submit.disabled, false, 'the form stays closed after the documents are accepted');
});

test('a registration carries the versions the instance published', async () => {
  State.legal = { termsVersion: '2.0', privacyVersion: '3.1', updated: '2026-10-01' };
  const calls = installFetchStub({});

  const result = gateFor('register');
  const form = result.node.querySelector('form');
  const byName = fieldsOf(form);

  byName.username.value = 'ada';
  byName.password.value = 'a-long-enough-password';
  byName.confirm.value = 'a-long-enough-password';
  byName.legal.checked = true;
  byName.legal.dispatch('change');
  form.dispatch('submit');
  await new Promise((resolve) => setTimeout(resolve, 10));

  const registration = calls.find((call) => call.url.indexOf('/api/auth/register') !== -1);
  assert.ok(registration, 'the registration was never sent');
  assert.equal(registration.body.termsVersion, '2.0');
  assert.equal(registration.body.privacyVersion, '3.1');
  assert.equal(registration.body.username, 'ada');

  State.legal = null;
});

test('a registration is not sent when the instance has not said which documents are in force', async () => {
  State.legal = null;
  const calls = installFetchStub({});

  const result = gateFor('register');
  const form = result.node.querySelector('form');
  const byName = fieldsOf(form);

  byName.username.value = 'ada';
  byName.password.value = 'a-long-enough-password';
  byName.confirm.value = 'a-long-enough-password';
  byName.legal.checked = true;
  byName.legal.dispatch('change');
  form.dispatch('submit');
  await new Promise((resolve) => setTimeout(resolve, 10));

  const registration = calls.find((call) => call.url.indexOf('/api/auth/register') !== -1);
  assert.equal(registration, undefined, 'a registration was sent without the versions');
  const error = form.querySelector('.form-error');
  assert.ok(error, 'the form has no place to say why');
  assert.equal(error.hidden, false, 'the form did not say why');
  assert.match(error.textContent, /did not say which terms/);
});

test('the recovery path asks for what the server reads', () => {
  const forgot = read(path.join(MODULES.desktop, 'features', 'auth.js'));
  assert.match(forgot, /Api\.forgotPassword\(\{\s*email:/,
    'the desktop does not send the address the endpoint reads');
  assert.match(forgot, /Api\.resetPassword\(\{[\s\S]*?newPassword:/,
    'the desktop does not send the new password the endpoint reads');
  assert.match(forgot, /confirmPassword:/,
    'the desktop does not send the confirmation the endpoint reads');
});

test('the mobile recovery path asks for what the server reads', () => {
  const forgot = read(path.join(MODULES.mobile, 'views', 'auth.js'));
  assert.match(forgot, /Api\.forgotPassword\(\{\s*email:/,
    'the mobile does not send the address the endpoint reads');
  assert.match(forgot, /Api\.resetPassword\(\{[\s\S]*?newPassword:/,
    'the mobile does not send the new password the endpoint reads');
});

test('the standalone pages are the ones the registry names', () => {
  for (const id of ['login', 'register', 'forgot', 'resetPassword', 'verifyEmail', 'twoStep']) {
    const page = registry.pageById(id);
    assert.ok(page, id + ' is not in the registry');
    assert.equal(page.access, id === 'verifyEmail' || id === 'twoStep' ? 'public' : 'guest');
  }
});

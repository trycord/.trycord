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

import { installDomStub, installFetchStub, waitFor } from './helpers/dom-stub.js';
import { CLIENT, MODULES, read } from './helpers/source.js';

installDomStub();

const { renderAuth } = await import('../js/features/auth.js');
const { State } = await import('../packages/store.js');
const registry = await import('../packages/registry.js');
const TrycordConfig = (await import('../packages/config.js')).default;

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

// -- what a refusal says ------------------------------------------------------

// The helper for driving the sign-in form: fill the two fields, send it.
async function signInWith(form, username, password, wait) {
  const byName = fieldsOf(form);
  byName.username.value = username;
  byName.password.value = password;
  form.dispatch('submit');
  await (wait || waitFor)(() => {
    const error = form.querySelector('.form-error');
    return error && error.hidden === false && error.textContent;
  });
  return form.querySelector('.form-error');
}

test('a wrong-password sign-in is answered with a next step, and what was typed stays', async () => {
  const loginUrl = TrycordConfig.backendUrl() + '/api/auth/login';
  const calls = installFetchStub({
    [loginUrl]: {
      ok: false, status: 401,
      json: { error: { code: 'AUTH_REQUIRED', message: 'We could not sign you in. Check the details and try again.' } },
    },
  });

  const result = gateFor('login');
  const form = result.node.querySelector('form');
  const error = await signInWith(form, 'ada', 'not-the-password');

  assert.match(String(error && error.textContent), /could not sign you in/i,
    'the refusal did not say what to do next');
  const byName = fieldsOf(form);
  assert.equal(byName.username.value, 'ada', 'the form emptied the name the reader typed');
  assert.equal(byName.password.value, 'not-the-password', 'the form emptied the password field');
});

test('the login refusal never says which factor was wrong', async () => {
  const loginUrl = TrycordConfig.backendUrl() + '/api/auth/login';
  const calls = installFetchStub({
    [loginUrl]: { ok: false, status: 401, json: { error: { code: 'AUTH_REQUIRED', message: 'refused' } } },
  });

  const result = gateFor('login');
  const form = result.node.querySelector('form');
  const error = await signInWith(form, 'nobody-here', 'not-the-password');
  const said = String(error && error.textContent);
  // The server withholds which of the two details failed (that difference is
  // how an account is confirmed to exist), and the form does not invent the
  // answer back: no sentence may name one of the fields as the wrong one.
  assert.doesNotMatch(said, /username/i);
  assert.doesNotMatch(said, /password/i);
  assert.match(said, /could not sign you in/i);
});

test('a locked-out sign-in names the wait the server reports', async () => {
  const loginUrl = TrycordConfig.backendUrl() + '/api/auth/login';
  const calls = installFetchStub({
    [loginUrl]: {
      ok: false, status: 429,
      json: { error: { code: 'ACCOUNT_LOCKED', message: 'Too many tries in a row. Wait a little, then try again.', details: { retryAfterSeconds: 120 } } },
    },
  });

  const result = gateFor('login');
  const form = result.node.querySelector('form');
  const error = await signInWith(form, 'ada', 'whatever');
  assert.match(String(error && error.textContent), /2 minutes/,
    'a lock with a server-stated wait did not state it');
});

test('a second-factor code that arrives too late offers the way back, and keeps what was typed', async () => {  const base = TrycordConfig.backendUrl();
  installFetchStub({
    [base + '/api/auth/login']: {
      json: { mfaRequired: true, challengeToken: 'tok', expiresInSeconds: 300 },
    },
    [base + '/api/auth/2fa/verify']: {
      ok: false, status: 401,
      json: { error: { code: 'CHALLENGE_EXPIRED', message: 'The code window closed. Start the sign-in again to get a fresh code.' } },
    },
  });

  const result = gateFor('login');
  const form = result.node.querySelector('form');
  const byName = fieldsOf(form);
  byName.username.value = 'ada';
  byName.password.value = 'the-real-one';
  byName.code.value = '000000';

  form.dispatch('submit');
  const codeLabel = Array.from(form.querySelectorAll('.field'))
    .find((label) => String(label.textContent).includes('Two-step code'));
  const alive = await waitFor(() => !codeLabel.hidden);
  assert.ok(alive, 'the code field never appeared for the challenge');

  form.dispatch('submit');
  const error = await waitFor(() => {
    const box = form.querySelector('.form-error');
    return box && box.hidden === false ? box : null;
  });
  assert.match(String(error && error.textContent), /window closed|again/i,
    'the stale-code refusal did not say what to do');
  const again = error.querySelector('button');
  assert.ok(again, 'the stale-code refusal offered no way to restart');

  again.dispatch('click');
  await waitFor(() => codeLabel.hidden);
  assert.equal(byName.code.value, '', 'the restart kept the stale code');
  assert.equal(byName.username.value, 'ada', 'the restart threw away the name');
  assert.equal(byName.password.value, 'the-real-one', 'the restart threw away the password');
});

// -- what the form asks before the server has to -------------------------------

test('the registration fields say their shape before the server refuses it', () => {
  const result = gateFor('register');
  const form = result.node.querySelector('form');
  const hints = form.querySelectorAll('.field-hint')
    .map((n) => String(n.textContent)).join(' | ');
  assert.match(hints, /2 to 32 characters/, 'the username field does not say its shape');
  assert.match(hints, /At least 8 characters/, 'the password field does not say its floor');
});

test('a passphrase over the ceiling is refused without spending the registration', async () => {
  State.legal = { termsVersion: '2.0', privacyVersion: '3.1' };
  const calls = installFetchStub({});

  const result = gateFor('register');
  const form = result.node.querySelector('form');
  const byName = fieldsOf(form);
  byName.username.value = 'ada';
  byName.password.value = 'x'.repeat(80);
  byName.confirm.value = byName.password.value;
  byName.legal.checked = true;
  byName.legal.dispatch('change');
  form.dispatch('submit');
  await waitFor(() => {
    const error = form.querySelector('.form-error');
    return error && error.hidden === false && error.textContent;
  });

  assert.equal(calls.find((call) => String(call.url).indexOf('/api/auth/register') !== -1), undefined,
    'the registration was sent with a passphrase no server can keep');
  const error = form.querySelector('.form-error');
  assert.match(String(error.textContent), /longer than passwords here can be/);
  State.legal = null;
});

test('an approval-gated instance shows the waiting screen, not a workspace that will refuse it', async () => {
  State.legal = { termsVersion: '2.0', privacyVersion: '3.1' };
  const registerUrl = TrycordConfig.backendUrl() + '/api/auth/register';
  const calls = installFetchStub({
    [registerUrl]: { json: { token: 'tok', user: { id: 'u1', username: 'ada' }, pendingApproval: true } },
  });

  const result = gateFor('register');
  const form = result.node.querySelector('form');
  const byName = fieldsOf(form);
  byName.username.value = 'ada';
  byName.password.value = 'a-long-enough-passphrase';
  byName.confirm.value = 'a-long-enough-passphrase';
  byName.legal.checked = true;
  byName.legal.dispatch('change');
  form.dispatch('submit');
  await waitFor(() => String(form.textContent).includes('approval'));

  assert.ok(calls.find((call) => String(call.url).indexOf('/api/auth/register') !== -1),
    'the registration was never sent');
  // The waiting screen is the form's replacement, and the sign-out it offers
  // is how a reader leaves a workspace they never got into.
  assert.match(String(form.textContent), /administrator to approve/);
  assert.match(String(form.textContent), /Sign out/);
  assert.equal(form.querySelector('input[name="password"]'), null,
    'the old form stayed on screen under the waiting text');
  State.legal = null;
});



// The phone's password field has the same two controls as the desk's: a way
// to read what was typed, and a reading of the phrase that is guidance rather
// than a gate. The two modules draw them separately, so both are checked.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.js';

installDomStub();

const { renderAuth } = await import('../mobile/js/views/auth.js');
const registry = await import('../packages/registry.js');

function registerForm() {
  const result = renderAuth(registry.pageById('register'), {});
  return result.node.querySelector('form');
}

test('the phone registration password can be revealed', () => {
  const form = registerForm();
  const password = form.querySelector('input[name="password"]');
  const toggle = form.querySelector('.m-password-toggle');
  assert.ok(password, 'the phone registration has no password field');
  assert.ok(toggle, 'the phone password cannot be revealed');

  assert.equal(password.getAttribute('type'), 'password');
  toggle.dispatch('click');
  assert.equal(password.getAttribute('type'), 'text', 'the reveal did not change the field');
  assert.equal(toggle.textContent, 'Hide');
  toggle.dispatch('click');
  assert.equal(password.getAttribute('type'), 'password', 'the field did not hide again');
});

test('the phone meter follows the phrase and the confirmation', () => {
  const form = registerForm();
  const password = form.querySelector('input[name="password"]');
  const confirm = form.querySelector('input[name="confirm"]');
  const meter = form.querySelector('.m-password-meter');

  assert.ok(meter, 'the phone registration has no strength reading');
  assert.equal(meter.hidden, true, 'the empty meter is shown');

  password.value = 'correct horse battery staple';
  password.dispatch('input');
  assert.equal(meter.hidden, false, 'the meter stayed hidden with a phrase typed');
  assert.ok(Number(meter.dataset.score) >= 3, 'a long passphrase did not move the meter');

  confirm.value = 'correct horse';
  confirm.dispatch('input');
  assert.equal(confirm.getAttribute('aria-invalid'), 'true',
    'a mismatch was not marked while typing');
  confirm.value = 'correct horse battery staple';
  confirm.dispatch('input');
  assert.equal(confirm.getAttribute('aria-invalid'), 'false',
    'a match was still marked invalid');
});

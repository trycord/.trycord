// The phone's password field has the same two controls as the desk's: a way
// to read what was typed, and a reading of the phrase that is guidance rather
// than a gate. The two modules draw them separately, so both are checked.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.js';

installDomStub();

const { renderAuth } = await import('../mobile/js/views/auth.js');

// The register screen, as the reader sees it: raw, with a form in it.
function registerForm() {
  const answer = renderAuth({ screen: 'register' });
  return answer.node.querySelector('form');
}

test('the phone registration password can be revealed', () => {
  const form = registerForm();
  const password = form.querySelector('input[name="password"]');
  const toggle = [...form.querySelectorAll('button')].find((b) => /^(Show|Hide)$/.test(b.textContent));
  assert.ok(password, 'the phone registration has no password field');
  assert.ok(toggle, 'the phone password cannot be revealed');

  assert.equal(password.getAttribute('type'), 'password');
  toggle.dispatch('click');
  assert.equal(password.getAttribute('type'), 'text', 'the reveal did not change the field');
  assert.equal(toggle.textContent, 'Hide');

  toggle.dispatch('click');
  assert.equal(password.getAttribute('type'), 'password', 'the reveal did not hide it again');
});

test('the phone reads the phrase as guidance, not as a gate', () => {
  const form = registerForm();
  const password = form.querySelector('input[name="password"]');
  const reading = form.querySelector('.m-auth__strength');
  assert.ok(reading, 'the phone registration has no reading of the phrase');

  password.value = 'short';
  password.dispatch('input');
  assert.ok(/Short/.test(reading.textContent), 'a short phrase is not warned about');

  password.value = 'a long enough phrase of words';
  password.dispatch('input');
  assert.ok(!/Short/.test(reading.textContent), 'a long phrase is still warned about');
});

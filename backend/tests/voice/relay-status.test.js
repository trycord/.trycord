'use strict';

// The relay, as anyone may ask about it.
//
// The voice process's own page is on the loopback, where the operator can
// reach it and nobody else can. That is the right place for the page that
// changes things, but it means a reader cannot ask whether calls work.
//
// So the instance answers the same question over its own API: the relay's
// address is already public - it is in the configuration the clients are
// given - and whether it answers is a fact about the instance, not a secret.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance } = require('../helpers/instance');

test('anyone can ask whether the relay answers', async (t) => {
  const instance = await startInstance({ jobs: false });
  t.after(() => instance.stop());

  const answer = await fetch(instance.baseUrl + '/api/voice/relay');
  assert.equal(answer.status, 200, 'the relay route did not answer');
  const body = await answer.json();

  // The answer is a yes or a no, with the address it asked about and what it
  // found. Which one it is depends on whether the relay is running, and the
  // test does not care: it cares that the answer is honest in its shape.
  assert.equal(typeof body.ok, 'boolean', 'the route did not say whether the relay answers');
  assert.ok(body.address, 'the route did not say which address it asked about');
  assert.ok(body.detail, 'the route did not say what it found');

  // The answer carries nothing that is not already public.
  const text = JSON.stringify(body);
  assert.equal(/password|credential|stunkey|secret/i.test(text), false,
    'the relay route says something it should not: ' + text);
});

// The voice process's own interface.
//
// The process answers on the loopback, and what it answers with is a page
// that says one word: WORKING or NOT WORKING. It is the page an operator
// opens when a call will not connect, and a page that says "not working"
// without saying why is a page that has to be read twice.
//
// Two things are checked here:
//
//   the verdict    WORKING only when every part of the stack is working, and
//                  the reason for a "no" is on the page;
//   the binding    the interface is on the loopback, and the process refuses
//                  to start on any other address.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// The address the relay is published at is read from the environment, and the
// checks in the test would go out to the internet. The environment is set
// before the module is loaded, because the module reads it when it loads.
process.env.TRYCORD_VOICE_PUBLIC_URL = 'voice.example.test';
process.env.TRYCORD_TURN_HOST = '127.0.0.1';
process.env.TRYCORD_TURN_STUNKEY = 'a-stunkey-for-the-test-only';

const voice = require('../../src/voice/index');

test('the address of the interface is the loopback, and only the loopback', () => {
  for (const address of ['127.0.0.1', '127.0.0.53', 'localhost', '::1', '[::1]']) {
    assert.equal(voice.isLoopback(address), true, address + ' is not on the loopback');
  }
  for (const address of ['0.0.0.0', '::', '[::]', '10.0.0.4', '192.168.1.10', '2a02:2f0e::1', '']) {
    assert.equal(voice.isLoopback(address), false, address + ' was taken for the loopback');
  }
});

test('a stack that answers says WORKING', () => {
  const state = {
    at: '2026-01-01T00:00:00.000Z',
    process: { ok: true, detail: 'The voice process is running.' },
    configuration: { ok: true, detail: 'The configuration is usable.' },
    engine: { ok: true, detail: 'The STUN and TURN service is listening on 127.0.0.1:3478.' },
    service: { ok: true, detail: 'The service answers a binding request on this host.' },
    published: { ok: null, detail: 'The published address is the local one.' },
    reachability: { ok: null, detail: 'Not answered from inside.' },
  };
  const verdict = voice.verdictOf(state);
  assert.equal(verdict.working, true, 'a stack that answers was called broken');
  assert.deepEqual(verdict.reasons, []);

  const page = voice.renderPage(state);
  assert.match(page, /WORKING/);
  assert.ok(page.indexOf('NOT WORKING') === -1, 'the page said both things');
});

test('a stack that does not answer says NOT WORKING, and says why', () => {
  const state = {
    at: '2026-01-01T00:00:00.000Z',
    process: { ok: true, detail: 'The voice process is running.' },
    configuration: { ok: false, detail: 'TRYCORD_TURN_STUNKEY is not set.' },
    engine: { ok: true, detail: 'The STUN and TURN service is listening.' },
    service: { ok: false, detail: 'Nothing answered a binding request at 127.0.0.1:3478.' },
    published: { ok: false, detail: 'The published address does not answer from this host.' },
    reachability: { ok: null, detail: 'Not answered from inside.' },
  };
  const verdict = voice.verdictOf(state);
  assert.equal(verdict.working, false, 'a stack that does not answer was called working');
  assert.equal(verdict.reasons.length, 3, 'not every reason was reported');

  const page = voice.renderPage(state);
  assert.match(page, /NOT WORKING/);
  assert.match(page, /TRYCORD_TURN_STUNKEY is not set\./,
    'the page did not carry the reason');
  assert.match(page, /Nothing answered a binding request/,
    'the page did not carry the reason');
});

test('the page is served at the root of the interface', async () => {
  const request = { url: '/' };
  let head = null;
  let body = '';
  const response = {
    writeHead(status, headers) { head = { status, headers }; },
    end(text) { body = text; },
  };
  voice.handler(request, response);
  // The check is made when the page is asked for, so the answer comes a
  // moment later.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.ok(head, 'the page was not answered');
  assert.equal(head.status, 200);
  assert.match(head.headers['Content-Type'], /text\/html/);
  assert.match(body, /WORKING|NOT WORKING/,
    'the page did not say whether the stack is working');
});

test('the page says where it is served from, so nobody looks for it outside', () => {
  const page = voice.renderPage({
    at: '2026-01-01T00:00:00.000Z',
    process: { ok: true, detail: 'The voice process is running.' },
    configuration: { ok: true, detail: 'The configuration is usable.' },
    engine: { ok: true, detail: 'The service is listening.' },
    service: { ok: true, detail: 'The service answers.' },
    published: { ok: null, detail: 'The published address is the local one.' },
    reachability: { ok: null, detail: 'Not answered from inside.' },
  });
  assert.match(page, /loopback/,
    'the page did not say it is served on the loopback');
});

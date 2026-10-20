// What a failure says.
//
// A reader who is told "Forbidden" learns that something went wrong and
// nothing about what to do about it. The server's own message is used
// whenever there is one - it knows more than a status code does - and the
// status is the last resort, and then it says what happened and what the
// next step is.

import test from 'node:test';
import assert from 'node:assert/strict';

import { request } from '../packages/api.js';

// The client's own request path, with the network replaced by an answer.
//
// The whole path is exercised - the fetch, the status, the reading of the
// body - so what is checked is what a reader would actually be shown.
function answering(status, body) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    status,
    statusText: 'Status text',
    headers: { get: () => null },
    ok: status >= 200 && status < 300,
    async json() {
      if (body === undefined) throw new Error('not json');
      return body;
    },
  });
  return () => { globalThis.fetch = original; };
}

test('a failure says what a person can do about it', async (t) => {
  await t.test("the server's own message is used when there is one", async () => {
    const restore = answering(403, { error: { code: 'PERMISSION_DENIED', message: 'You are not a member of that community.' } });
    t.after(restore);
    await assert.rejects(
      () => request('GET', '/api/thing'),
      (error) => {
        assert.equal(error.code, 'PERMISSION_DENIED');
        assert.equal(error.message, 'You are not a member of that community.');
        return true;
      },
    );
  });

  await t.test('a status with no message of its own says what to do', async () => {
    const cases = [
      [401, /sign in again/i],
      [403, /permission/i],
      [404, /no longer there/i],
      [409, /someone else/i],
      [413, /too large/i],
      [429, /too many/i],
      [500, /went wrong on our side/i],
      [503, /not available right now/i],
    ];
    for (const [status, wanted] of cases) {
      const restore = answering(status, undefined);
      try {
        await assert.rejects(
          () => request('GET', '/api/thing'),
          (error) => {
            assert.equal(error.status, status);
            assert.match(error.message, wanted,
              'the message for ' + status + ' does not say what to do: ' + error.message);
            return true;
          },
        );
      } finally { restore(); }
    }
  });

  await t.test('a status nobody has a message for still says something', async () => {
    const restore = answering(418, undefined);
    t.after(restore);
    await assert.rejects(
      () => request('GET', '/api/thing'),
      (error) => {
        assert.ok(error.message && error.message.length > 0, 'the failure said nothing');
        return true;
      },
    );
  });

  await t.test("a failure that is not about the status keeps the server's code", async () => {
    const restore = answering(400, {
      error: { code: 'VALIDATION_ERROR', message: 'That name is already taken.' },
    });
    t.after(restore);
    await assert.rejects(
      () => request('GET', '/api/thing'),
      (error) => {
        assert.equal(error.code, 'VALIDATION_ERROR');
        assert.equal(error.message, 'That name is already taken.');
        return true;
      },
    );
  });
});

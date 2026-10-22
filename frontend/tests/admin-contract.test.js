// The console's decisions travel in the server's own vocabulary.
//
// The appeals review sends APPROVED or DENIED. It used to send "approve"
// and "deny", which the server uppercases to words it does not know - so
// every appeal decision was refused at the server, and the console read the
// refusal as a network problem. The words below are the server's, and this
// file pins them so the vocabulary cannot drift again.

import test from 'node:test';
import assert from 'node:assert/strict';

import Api from '../packages/api.js';

test("an appeal decision travels in the server's vocabulary", async () => {
  let seen = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    seen = {
      url: String(url),
      body: options && options.body ? JSON.parse(options.body) : null,
    };
    return {
      status: 200, statusText: 'ok',
      headers: { get: () => null }, ok: true,
      async json() { return { ok: true }; },
    };
  };
  try {
    await Api.adminDecideAppeal('appeal-1', 'APPROVED');
    assert.match(seen.url, /admin\/appeals\/appeal-1$/);
    assert.equal(seen.body.decision, 'APPROVED',
      'the decision is the server\u2019s word, not a client shorthand');
  } finally {
    globalThis.fetch = original;
  }
});

test('a report move travels in the server\u2019s vocabulary', async () => {
  let seen = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    seen = {
      url: String(url),
      body: options && options.body ? JSON.parse(options.body) : null,
    };
    return {
      status: 200, statusText: 'ok',
      headers: { get: () => null }, ok: true,
      async json() { return { ok: true }; },
    };
  };
  try {
    await Api.adminUpdateReport('report-7', { status: 'INVESTIGATING' });
    assert.equal(seen.body.status, 'INVESTIGATING',
      'the move is one of the statuses the server reports, uppercased');
  } finally {
    globalThis.fetch = original;
  }
});

test('a deletion review travels in the server\u2019s vocabulary', async () => {
  let seen = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    seen = {
      url: String(url),
      body: options && options.body ? JSON.parse(options.body) : null,
    };
    return {
      status: 200, statusText: 'ok',
      headers: { get: () => null }, ok: true,
      async json() { return { ok: true }; },
    };
  };
  try {
    await Api.adminReviewGdprRequest('request-2', 'REJECT', 'Rejected by an administrator');
    assert.equal(seen.body.decision, 'REJECT',
      'the review is APPROVE or REJECT, never a word the server does not know');
  } finally {
    globalThis.fetch = original;
  }
});

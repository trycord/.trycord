// The voice session's states, and the words for them.
//
// A call that cannot be made used to sit on "Connecting" for as long as the
// reader looked at it, because the row that said it had failed was taken
// away before the state was read. A room with nobody else in it said the
// same thing.
//
// These are the checks that keep the states honest: every state the
// session can be in has a word, both shells read the same words, and a
// failed connection keeps its row.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONNECTION_STATES } from '../../packages/voiceSession.js';

const FRONTEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the states of a call', async (t) => {
  await t.test('every state has a word, and the word is a sentence', () => {
    for (const [state, word] of Object.entries(CONNECTION_STATES)) {
      assert.ok(word && word.length > 2, state + ' has a word');
      assert.equal(word, word.trim(), state + "'s word is not padded");
    }
  });

  await t.test('the states a room can be in are all spoken for', () => {
    for (const state of ['idle', 'joining', 'connecting', 'connected', 'reconnecting', 'failed', 'leaving']) {
      assert.ok(CONNECTION_STATES[state], state + ' has a word');
    }
  });

  await t.test('a room with nobody else in it is not a connection being made', () => {
    assert.ok(CONNECTION_STATES.alone, 'the empty room has a word of its own');
    assert.notEqual(CONNECTION_STATES.alone, CONNECTION_STATES.connecting,
      'an empty room is not a call that is still connecting');
  });

  await t.test('a failed connection keeps its row, so the state can say so', () => {
    const source = fs.readFileSync(path.join(FRONTEND, 'packages', 'voiceSession.js'), 'utf8');
    assert.ok(/function failPeer/.test(source), 'there is a way to fail a peer');
    // The row must not be dropped: a dropped row says nothing.
    const fail = /function failPeer[\s\S]*?\n}/.exec(source);
    assert.ok(fail, 'the failing peer is found');
    assert.ok(!/dropRow/.test(fail[0]),
      'a failed peer keeps its row, because a dropped row says nothing');
  });

  await t.test('both shells read the same words', () => {
    for (const rel of ['js/voice/dock.js', 'mobile/js/views/voiceCall.js']) {
      const source = fs.readFileSync(path.join(FRONTEND, rel), 'utf8');
      assert.ok(/CONNECTION_STATES/.test(source), rel + ' reads the shared words');
      assert.ok(!/connecting: 'Connecting'/.test(source),
        rel + ' does not keep its own copy of the words');
    }
  });
});

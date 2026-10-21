// The drafts.
//
// What somebody has written and not sent.
//
// A draft belongs to a conversation, not to a page: a reader who starts a
// sentence, goes to another conversation and comes back finds the sentence
// where they left it. The same is true of a page that reloads.
//
// The desk and the phone write their own composers, and they are two
// implementations of the same thing. This is the part of it that must not
// differ, so it lives in one place and both of them use it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.js';

installDomStub();

const { draftFor, saveDraft, clearDraft, restoreDraft } = await import('../packages/drafts.js');

test('the drafts', async (t) => {
  await t.test('a draft belongs to a conversation', () => {
    saveDraft('c1', 'the first one');
    saveDraft('c2', 'the second one');
    assert.equal(draftFor('c1'), 'the first one');
    assert.equal(draftFor('c2'), 'the second one');
    clearDraft('c1');
    clearDraft('c2');
  });

  await t.test('a conversation with no draft has none', () => {
    assert.equal(draftFor('nothing-here'), '');
  });

  await t.test('an empty draft is forgotten rather than kept', () => {
    // A draft that is only spaces is not a draft, and keeping it would put
    // an empty box in the reader's way.
    saveDraft('c3', 'something');
    saveDraft('c3', '   ');
    assert.equal(draftFor('c3'), '');
    clearDraft('c3');
  });

  await t.test('a draft is put back into the box', () => {
    saveDraft('c4', 'half a sentence');
    const box = { value: '' };
    assert.equal(restoreDraft('c4', box), 'half a sentence');
    assert.equal(box.value, 'half a sentence');
    clearDraft('c4');
  });

  await t.test('a reader who is typing keeps what they are typing', () => {
    // The box is only filled when it is empty: opening a conversation again
    // must not throw away what is being written.
    saveDraft('c5', 'the old draft');
    const box = { value: 'what I am writing now' };
    restoreDraft('c5', box);
    assert.equal(box.value, 'what I am writing now');
    clearDraft('c5');
  });
});

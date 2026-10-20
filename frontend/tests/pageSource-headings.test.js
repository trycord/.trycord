// A document with ordinary headings.
//
// The editor refused a Terms of Service document with "a heading is written
// with two or three #" - against a document whose headings used a single
// hash. The message accused the writer of using two or three when they had
// used one, and the document could not be saved.
//
// A single hash is the most ordinary heading there is. The source mode
// accepted two and three and refused one, and the server turned anything
// that was not two or three into two - so the source and the stored document
// disagreed about what the writer had typed.
//
// So the check is the document that was refused, and the round trip: the
// source reads it, the blocks carry the levels, and the source writes it
// back.

import test from 'node:test';
import assert from 'node:assert/strict';

import { sourceToBlocks, blocksToSource, blockToSource } from '../js/features/pageSource.js';

// The Terms of Service, as a person would write it.
const TERMS = [
  '# Terms of Service',
  '',
  'These terms govern your use of this instance. By making an account you',
  'agree to them.',
  '',
  '## Your account',
  '',
  'You are responsible for what happens under your account. Keep your',
  'password to yourself, and tell an administrator if you think somebody',
  'else has it.',
  '',
  '### Changing these terms',
  '',
  'We may change these terms. When we do, the version in force is the one',
  'on this page, and it is dated.',
  '',
  '## Your content',
  '',
  'What you write is yours. You give us the right to show it to the people',
  'you send it to, and to keep it as long as your account exists.',
].join('\n');

test('a document with ordinary headings is read', () => {
  const parsed = sourceToBlocks(TERMS);

  assert.deepEqual(parsed.errors, [],
    'the document was refused:\n' + JSON.stringify(parsed.errors, null, 1));

  const headings = parsed.blocks.filter((block) => block.type === 'heading');
  assert.equal(headings.length, 4, 'the headings were not read');
  assert.equal(headings[0].level, 1, 'the first heading is not level one');
  assert.equal(headings[0].text, 'Terms of Service');
  assert.equal(headings[1].level, 2, 'the second heading is not level two');
  assert.equal(headings[2].level, 3, 'the third heading is not level three');
  assert.equal(headings[3].level, 2, 'the fourth heading is not level two');
});

test('a single hash is a heading and not a mistake', () => {
  const parsed = sourceToBlocks('# One\n\nText.');
  assert.deepEqual(parsed.errors, [], 'a single-hash heading was refused');
  assert.equal(parsed.blocks[0].type, 'heading');
  assert.equal(parsed.blocks[0].level, 1);
});

test('four hashes are still a mistake', () => {
  const parsed = sourceToBlocks('#### Four\n\nText.');
  assert.equal(parsed.errors.length, 1, 'four hashes were accepted');
  assert.match(parsed.errors[0].message, /one, two or three/);
});

test('the source writes the levels back', () => {
  const parsed = sourceToBlocks(TERMS);
  const written = blocksToSource(parsed.blocks);
  assert.match(written, /^# Terms of Service$/m, 'the level-one heading was not written back');
  assert.match(written, /^## Your account$/m, 'the level-two heading was not written back');
  assert.match(written, /^### Changing these terms$/m, 'the level-three heading was not written back');

  // And the round trip is stable: reading it back gives the same blocks.
  const again = sourceToBlocks(written);
  assert.deepEqual(again.errors, [], 'the document could not be read back');
  assert.deepEqual(again.blocks, parsed.blocks, 'the round trip changed the document');
});

test('one block writes one line', () => {
  assert.equal(blockToSource({ type: 'heading', level: 1, text: 'Title' }), '# Title');
  assert.equal(blockToSource({ type: 'heading', level: 2, text: 'Title' }), '## Title');
  assert.equal(blockToSource({ type: 'heading', level: 3, text: 'Title' }), '### Title');
});

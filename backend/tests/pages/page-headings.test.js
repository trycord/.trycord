// A document with ordinary headings, on the server.
//
// The editor refused a Terms of Service document with "a heading is written
// with two or three #" - against a document whose headings used a single
// hash. The message accused the writer of using two or three when they had
// used one.
//
// The server had the same fault underneath: a heading's level was two or
// three, and anything else was quietly turned into two. A document written
// with a single hash was therefore stored as a different document - and the
// source and the stored blocks disagreed about what the writer had typed.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const content = require('../../src/services/pageContent');
const bbcode = require('../../src/services/bbcode');

test('a heading carries the level it was written with', () => {
  for (const level of [1, 2, 3]) {
    const blocks = content.normalise([{ type: 'heading', level, text: 'Title' }]);
    assert.equal(blocks[0].level, level,
      'a level ' + level + ' heading was stored as level ' + blocks[0].level);
  }
});

test('a level-one heading is accepted', () => {
  const blocks = content.normalise([
    { type: 'heading', level: 1, text: 'Terms of Service' },
    { type: 'paragraph', text: 'These terms govern your use of this instance.' },
  ]);
  assert.equal(blocks[0].type, 'heading');
  assert.equal(blocks[0].level, 1);
});

test('a level-one heading is drawn largest', () => {
  const one = content.toBBCode([{ type: 'heading', level: 1, text: 'Title' }]);
  const two = content.toBBCode([{ type: 'heading', level: 2, text: 'Title' }]);
  const three = content.toBBCode([{ type: 'heading', level: 3, text: 'Title' }]);
  assert.match(one, /\[size=7\]/, 'a level-one heading is not the largest: ' + one);
  assert.match(two, /\[size=6\]/, 'a level-two heading is not the middle: ' + two);
  assert.match(three, /\[size=4\]/, 'a level-three heading is not the smallest: ' + three);
});

test('the rendered document keeps the level', () => {
  // The renderer draws a heading as the heading element it is, which is what
  // a reader's screen reader and their browser's outline both want.
  for (const [level, tag] of [[1, 'h1'], [2, 'h2'], [3, 'h3']]) {
    const html = content.toHtml([
      { type: 'heading', level, text: 'Terms of Service' },
      { type: 'paragraph', text: 'These terms govern your use of this instance.' },
    ]);
    assert.match(html, new RegExp('<' + tag + '>'),
      'a level-' + level + ' heading was not drawn as a ' + tag + ': '
      + html.slice(0, 160));
  }
});

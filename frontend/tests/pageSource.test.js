// The content model of a page, and the source mode that writes it.
//
// A page body is a list of typed blocks, and the server accepts nothing else.
// The editor writes that list two ways - as blocks and as source - and the
// two are the same model, so this checks that the source is a faithful
// projection of the blocks: what one writes, the other reads back.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sourceToBlocks, blocksToSource, blockErrors, linkProblem, blockToSource,
  inlineToBBCode, bbcodeToInline, LIMITS,
} from '../js/features/pageSource.js';

test('a heading is a heading', () => {
  const { blocks, errors } = sourceToBlocks('## What this covers');
  assert.deepEqual(errors, []);
  assert.deepEqual(blocks, [{ type: 'heading', level: 2, text: 'What this covers' }]);
});

test('three hashes are a lower heading', () => {
  const { blocks } = sourceToBlocks('### And this part');
  assert.equal(blocks[0].level, 3);
});

test('a standfirst is a lead', () => {
  const { blocks } = sourceToBlocks('! The sentence under the title.');
  assert.deepEqual(blocks, [{ type: 'lead', text: 'The sentence under the title.' }]);
});

test('a quotation is a paragraph carrying a quote', () => {
  const { blocks } = sourceToBlocks('> What they said.');
  assert.equal(blocks[0].type, 'paragraph');
  assert.equal(blocks[0].text, '[quote]What they said.[/quote]');
});

test('a note and a warning are notes', () => {
  const { blocks } = sourceToBlocks('~ Something worth knowing.\n\n~! Something urgent.');
  assert.equal(blocks[0].kind, 'info');
  assert.equal(blocks[1].kind, 'warn');
});

test('a rule is a rule', () => {
  const { blocks } = sourceToBlocks('---');
  assert.deepEqual(blocks, [{ type: 'rule' }]);
});

test('dashes make a list and numbers make another', () => {
  const { blocks } = sourceToBlocks('- one\n- two\n\n1. first\n2. second');
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: 'list', ordered: false, items: ['one', 'two'] });
  assert.deepEqual(blocks[1], { type: 'list', ordered: true, items: ['first', 'second'] });
});

test('a line that is only a link is a link', () => {
  const { blocks, errors } = sourceToBlocks('[Read the policy](https://example.org/policy)');
  assert.deepEqual(errors, []);
  assert.deepEqual(blocks, [{ type: 'link', text: 'Read the policy', href: 'https://example.org/policy' }]);
});

test('a link to a target the server refuses is refused here too, with its line', () => {
  const { blocks, errors } = sourceToBlocks('Fine.\n\n[bad](javascript:alert(1))');
  assert.equal(blocks.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 3);
  assert.match(errors[0].message, /http, https, mailto/);
});

test('a link inside a line is checked as well', () => {
  const { errors } = sourceToBlocks('Read [this](javascript:alert(1)) today.');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 1);
  assert.match(errors[0].message, /http, https, mailto/);
});

test('a line holding two links is a paragraph, not a link', () => {
  const { blocks, errors } = sourceToBlocks('[one](https://example.org/1) and [two](https://example.org/2)');
  assert.deepEqual(errors, []);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'paragraph');
});

test('an image cannot be stored in a page body, and says so', () => {
  const { errors } = sourceToBlocks('![a picture](https://example.org/x.png)');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /image/);
});

test('a table cannot be stored in a page body, and says so', () => {
  const { errors } = sourceToBlocks('| a | b |');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /table/);
});

test('lines that are not a block are a paragraph', () => {
  const { blocks } = sourceToBlocks('A paragraph that\nruns over two lines.');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, 'A paragraph that runs over two lines.');
});

test('the source reads back the blocks it was written from', () => {
  const blocks = [
    { type: 'heading', level: 2, text: 'What this covers' },
    { type: 'lead', text: 'The standfirst.' },
    { type: 'paragraph', text: 'A paragraph.' },
    { type: 'list', ordered: false, items: ['one', 'two'] },
    { type: 'note', kind: 'warn', text: 'Careful.' },
    { type: 'link', text: 'The policy', href: 'https://example.org/policy' },
    { type: 'rule' },
  ];
  const source = blocksToSource(blocks);
  const { blocks: read, errors } = sourceToBlocks(source);
  assert.deepEqual(errors, []);
  assert.deepEqual(read, blocks);
});

test('a quotation survives the round trip', () => {
  const blocks = [{ type: 'paragraph', text: '[quote]What they said.[/quote]' }];
  const source = blocksToSource(blocks);
  assert.equal(source, '> What they said.');
  const { blocks: read } = sourceToBlocks(source);
  assert.deepEqual(read, blocks);
});

test('inline formatting survives the round trip', () => {
  const blocks = [{ type: 'paragraph', text: '[b]bold[/b] and [i]italic[/i] and [code]code[/code]' }];
  const source = blocksToSource(blocks);
  assert.equal(source, '**bold** and *italic* and `code`');
  const { blocks: read } = sourceToBlocks(source);
  assert.deepEqual(read, blocks);
});

test('an inline link inside a paragraph reads back as a link block', () => {
  // The two render the same - one paragraph holding one link - so the model
  // changes shape but the page does not change.
  const blocks = [{ type: 'paragraph', text: '[url=https://example.org/x]here[/url]' }];
  const source = blocksToSource(blocks);
  assert.equal(source, '[here](https://example.org/x)');
  const { blocks: read } = sourceToBlocks(source);
  assert.deepEqual(read, [{ type: 'link', text: 'here', href: 'https://example.org/x' }]);
});

test('a shorthand asterisk on its own is not formatting', () => {
  assert.equal(inlineToBBCode('2 * 3 * 4'), '2 * 3 * 4');
  assert.equal(inlineToBBCode('**bold**'), '[b]bold[/b]');
});

test('a block with no rule is left as it was written', () => {
  // The server escapes a note rather than parsing it, so a note is not
  // converted on the way in either.
  assert.equal(blockToSource({ type: 'note', kind: 'info', text: '[b]not bold[/b]' }), '~ [b]not bold[/b]');
});

test('the validator says what the server would refuse', () => {
  const problems = blockErrors([
    { type: 'heading', level: 2, text: '' },
    { type: 'paragraph', text: 'x'.repeat(LIMITS.text + 1) },
    { type: 'list', ordered: false, items: [] },
    { type: 'link', text: 'x', href: 'javascript:alert(1)' },
    { type: 'nonsense' },
  ]);
  assert.equal(problems.length, 5);
  assert.match(problems[0].message, /heading needs text/);
  assert.match(problems[1].message, /paragraph may be at most/);
  assert.match(problems[2].message, /at least one item/);
  assert.match(problems[3].message, /http, https, mailto/);
  assert.match(problems[4].message, /unknown block type/);
});

test('a valid body has no problems', () => {
  const problems = blockErrors([
    { type: 'heading', level: 3, text: 'A heading' },
    { type: 'paragraph', text: 'A paragraph.' },
    { type: 'list', ordered: true, items: ['one'] },
    { type: 'note', kind: 'info', text: 'A note.' },
    { type: 'link', text: 'A link', href: '/terms' },
    { type: 'rule' },
  ]);
  assert.deepEqual(problems, []);
});

test('the link policy is the one the server applies', () => {
  assert.equal(linkProblem('https://example.org'), null);
  assert.equal(linkProblem('mailto:someone@example.org'), null);
  assert.equal(linkProblem('/terms'), null);
  assert.equal(linkProblem('#section'), null);
  assert.ok(linkProblem('javascript:alert(1)'));
  assert.ok(linkProblem('data:text/html,x'));
  assert.ok(linkProblem('relative/path'));
  assert.ok(linkProblem(''));
});

test('bbcode that has no shorthand is left alone', () => {
  assert.equal(bbcodeToInline('[u]underlined[/u]'), '[u]underlined[/u]');
});

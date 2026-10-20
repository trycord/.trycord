// The content model of a page, and the source mode that writes it.
//
// A page body is a list of typed blocks, and the server accepts nothing else.
// The editor writes that list two ways - as blocks and as source - and the
// two are the same model, so this checks that the source is a faithful
// projection of the blocks: what one writes, the other reads back.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  sourceToBlocks, blocksToSource, blockErrors, linkProblem, imageProblem,
  languageProblem, blockToSource, inlineToBBCode, bbcodeToInline, LIMITS,
} from '../js/features/pageSource.js';

// The server's own validator, so the editor's validator is compared with it
// rather than assumed to agree with it.
const require = createRequire(import.meta.url);
const serverContent = require('../../backend/src/services/pageContent.js');

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

test('a quotation is a quotation', () => {
  const { blocks, errors } = sourceToBlocks('> What they said.');
  assert.deepEqual(errors, []);
  assert.deepEqual(blocks, [{ type: 'quote', text: 'What they said.' }]);
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

test('an image is an image', () => {
  const { blocks, errors } = sourceToBlocks('![a picture](https://example.org/x.png)');
  assert.deepEqual(errors, []);
  assert.deepEqual(blocks, [{ type: 'image', src: 'https://example.org/x.png', alt: 'a picture' }]);
});

test('an image without alt text is refused, with its line', () => {
  const { blocks, errors } = sourceToBlocks('A line.\n\n![](https://example.org/x.png)');
  assert.equal(blocks.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 3);
  assert.match(errors[0].message, /alt text/);
});

test('an image the server would not fetch is refused here too', () => {
  const { errors } = sourceToBlocks('![a picture](javascript:alert(1))');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /http, https, or a path/);
});

test('a table is a table', () => {
  const { blocks, errors } = sourceToBlocks('| a | b |\n| --- | --- |\n| 1 | 2 |');
  assert.deepEqual(errors, []);
  assert.deepEqual(blocks, [{ type: 'table', headers: ['a', 'b'], rows: [['1', '2']] }]);
});

test('a table whose row is not as wide as its headings is refused, with its line', () => {
  const { errors } = sourceToBlocks('| a | b |\n| --- | --- |\n| 1 |');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 3);
  assert.match(errors[0].message, /same number of cells/);
});

test('a code block is a code block', () => {
  const { blocks, errors } = sourceToBlocks('```js\nconst x = 1;\n```');
  assert.deepEqual(errors, []);
  assert.deepEqual(blocks, [{ type: 'code', text: 'const x = 1;', language: 'js' }]);
});

test('a code block language the server refuses is refused here too', () => {
  const { blocks, errors } = sourceToBlocks('```two words\nconst x = 1;\n```');
  assert.equal(blocks.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /language/);
});

test('a code block without a closing fence is refused, with its line', () => {
  const { blocks, errors } = sourceToBlocks('```js\nconst x = 1;');
  assert.equal(blocks.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 1);
  assert.match(errors[0].message, /closing fence/);
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

test('every block type survives the round trip with every field it carries', () => {
  const blocks = [
    { type: 'heading', level: 3, text: 'What this covers' },
    { type: 'lead', text: 'The standfirst.' },
    { type: 'paragraph', text: 'A paragraph.' },
    { type: 'list', ordered: true, items: ['one', 'two'] },
    { type: 'note', kind: 'warn', text: 'Careful.' },
    { type: 'link', text: 'The policy', href: 'https://example.org/policy' },
    { type: 'rule' },
    { type: 'image', src: '/uploads/picture.png', alt: 'A picture', width: 320 },
    { type: 'quote', text: 'What they said.', attribution: 'Someone' },
    { type: 'code', text: 'const x = 1;\n  const y = 2;', language: 'js' },
    { type: 'table', headers: ['Name', 'Cost'], rows: [['Tea', '2']], caption: 'Prices' },
  ];
  const source = blocksToSource(blocks);
  const { blocks: read, errors } = sourceToBlocks(source);
  assert.deepEqual(errors, []);
  assert.deepEqual(read, blocks);
});

test('an image without a width says so, and one with a width keeps it', () => {
  assert.equal(blockToSource({ type: 'image', src: '/a.png', alt: 'A picture' }), '![A picture](/a.png)');
  assert.equal(
    blockToSource({ type: 'image', src: '/a.png', alt: 'A picture', width: 320 }),
    '![A picture](/a.png) "width=320"');
});

test('a quotation with an attribution carries it on the last line', () => {
  const source = blocksToSource([{ type: 'quote', text: 'What they said.', attribution: 'Someone' }]);
  assert.equal(source, '> What they said.\n> -- Someone');
  const { blocks } = sourceToBlocks(source);
  assert.deepEqual(blocks, [{ type: 'quote', text: 'What they said.', attribution: 'Someone' }]);
});

test('a quotation may say anything, including a line that looks like an attribution', () => {
  const blocks = [{ type: 'quote', text: 'A line\n-- that looks like an attribution' }];
  const source = blocksToSource(blocks);
  const { blocks: read, errors } = sourceToBlocks(source);
  assert.deepEqual(errors, []);
  assert.deepEqual(read, blocks);
});

test('a code block keeps its indentation through the round trip', () => {
  const code = 'function outer() {\n  if (true) {\n    return 1;\n  }\n}';
  const source = blocksToSource([{ type: 'code', text: code, language: 'js' }]);
  assert.match(source, /\n {2}if \(true\) \{/);
  const { blocks: read } = sourceToBlocks(source);
  assert.equal(read[0].text, code);
});

test('a code block that holds a fence is fenced longer', () => {
  const code = 'a\n```\nb';
  const source = blocksToSource([{ type: 'code', text: code }]);
  assert.match(source, /^````/);
  const { blocks: read } = sourceToBlocks(source);
  assert.equal(read[0].text, code);
});

test('a table keeps its caption and its cells', () => {
  const source = blocksToSource([{
    type: 'table', headers: ['Name', 'Cost'], rows: [['Tea', '2']], caption: 'Prices',
  }]);
  assert.equal(source, ': Prices\n| Name | Cost |\n| --- | --- |\n| Tea | 2 |');
  const { blocks: read, errors } = sourceToBlocks(source);
  assert.deepEqual(errors, []);
  assert.deepEqual(read, [{
    type: 'table', headers: ['Name', 'Cost'], rows: [['Tea', '2']], caption: 'Prices',
  }]);
});

test('a table cell may hold a pipe', () => {
  const blocks = [{ type: 'table', headers: ['A'], rows: [['one | two']] }];
  const source = blocksToSource(blocks);
  const { blocks: read, errors } = sourceToBlocks(source);
  assert.deepEqual(errors, []);
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
    { type: 'image', src: '/uploads/x.png', alt: 'A picture', width: 320 },
    { type: 'quote', text: 'What they said.', attribution: 'Someone' },
    { type: 'code', text: 'const x = 1;', language: 'js' },
    { type: 'table', headers: ['Name'], rows: [['Tea']], caption: 'Prices' },
  ]);
  assert.deepEqual(problems, []);
});

// The blocks the server refuses, and the reason it refuses them.
const BAD_BLOCKS = [
  { type: 'image', src: '/a.png' },
  { type: 'image', src: '', alt: 'A picture' },
  { type: 'image', src: 'javascript:alert(1)', alt: 'A picture' },
  { type: 'image', src: 'data:text/html,x', alt: 'A picture' },
  { type: 'image', src: '//elsewhere.example/x.png', alt: 'A picture' },
  { type: 'image', src: 'pictures/x.png', alt: 'A picture' },
  { type: 'image', src: '/a.png', alt: 'x'.repeat(LIMITS.imageAlt + 1) },
  { type: 'image', src: '/a.png', alt: 'A picture', width: 0 },
  { type: 'image', src: '/a.png', alt: 'A picture', width: LIMITS.imageWidth + 1 },
  { type: 'image', src: '/a.png', alt: 'A picture', width: 1.5 },
  { type: 'quote', text: '' },
  { type: 'quote', text: 'x'.repeat(LIMITS.quote + 1) },
  { type: 'quote', text: 'What they said.', attribution: 'y'.repeat(LIMITS.attribution + 1) },
  { type: 'code', text: '   ' },
  { type: 'code', text: 'x'.repeat(LIMITS.code + 1) },
  { type: 'code', text: 'const x = 1;', language: 'not a language' },
  { type: 'code', text: 'const x = 1;', language: 'x'.repeat(LIMITS.language + 1) },
  { type: 'table', headers: [], rows: [['a']] },
  { type: 'table', headers: ['a'], rows: [] },
  { type: 'table', headers: ['a', 'b'], rows: [['x']] },
  { type: 'table', headers: ['a'], rows: [['x', 'y']] },
  { type: 'table', headers: [''], rows: [['x']] },
  { type: 'table', headers: ['a'], rows: [['x'.repeat(LIMITS.cell + 1)]] },
  { type: 'table', headers: ['a'], rows: [['x']], caption: 'c'.repeat(LIMITS.caption + 1) },
  { type: 'table', headers: new Array(LIMITS.columns + 1).fill('a'), rows: [['x']] },
];

const GOOD_BLOCKS = [
  { type: 'image', src: '/a.png', alt: 'A picture' },
  { type: 'image', src: 'https://example.org/a.png', alt: 'A picture', width: LIMITS.imageWidth },
  { type: 'quote', text: 'What they said.' },
  { type: 'quote', text: 'What they said.', attribution: 'Someone' },
  { type: 'code', text: 'const x = 1;' },
  { type: 'code', text: 'const x = 1;', language: 'c++' },
  { type: 'table', headers: ['Name'], rows: [['']] },
  { type: 'table', headers: ['Name'], rows: [['Tea']], caption: 'Prices' },
];

// What the server makes of a block, and what the editor makes of it.
function verdict(block, check) {
  try {
    check([block]);
    return '';
  } catch (error) {
    return error.message;
  }
}

test('the editor refuses exactly what the server refuses', () => {
  const disagreements = [];
  for (const block of BAD_BLOCKS) {
    const server = verdict(block, (body) => serverContent.normalise(body));
    const editor = blockErrors([block]);
    if (!!server !== (editor.length > 0)) {
      disagreements.push(JSON.stringify(block)
        + ' — the server said "' + (server || 'nothing') + '" and the editor said '
        + JSON.stringify(editor.map((problem) => problem.message)));
    }
  }
  assert.deepEqual(disagreements, [], 'the editor and the server disagree:\n' + disagreements.join('\n'));
});

test('the editor accepts exactly what the server accepts', () => {
  const disagreements = [];
  for (const block of GOOD_BLOCKS) {
    const server = verdict(block, (body) => serverContent.normalise(body));
    const editor = blockErrors([block]);
    if (!!server !== (editor.length > 0)) {
      disagreements.push(JSON.stringify(block)
        + ' — the server said "' + (server || 'nothing') + '" and the editor said '
        + JSON.stringify(editor.map((problem) => problem.message)));
    }
  }
  assert.deepEqual(disagreements, [], 'the editor and the server disagree:\n' + disagreements.join('\n'));
});

test('the source writes the blocks the server stores', () => {
  // The projection is checked against the server's own blocks, so what the
  // source writes and reads back is what the server would have kept.
  const stored = serverContent.normalise([
    { type: 'heading', level: 3, text: 'What this covers' },
    { type: 'lead', text: 'The standfirst.' },
    { type: 'paragraph', text: '[b]A paragraph.[/b]' },
    { type: 'list', ordered: true, items: ['one', 'two'] },
    { type: 'note', kind: 'warn', text: 'Careful.' },
    { type: 'link', text: 'The policy', href: 'https://example.org/policy' },
    { type: 'rule' },
    { type: 'image', src: '/uploads/picture.png', alt: 'A picture', width: 320 },
    { type: 'quote', text: 'What they said.', attribution: 'Someone' },
    { type: 'code', text: 'const x = 1;\n  const y = 2;', language: 'js' },
    { type: 'table', headers: ['Name', 'Cost'], rows: [['Tea', '2']], caption: 'Prices' },
  ]);
  const source = blocksToSource(stored);
  const { blocks: read, errors } = sourceToBlocks(source);
  assert.deepEqual(errors, []);
  assert.deepEqual(read, stored);
});

test('a blank list item is the one place the editor is stricter', () => {
  // The server drops a list item that is blank; the editor would rather tell
  // the operator than lose the line on the way to the server.
  const block = { type: 'list', ordered: false, items: ['', 'a line'] };
  assert.equal(verdict(block, (body) => serverContent.normalise(body)), '');
  const problems = blockErrors([block]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /cannot be blank/);
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

test('the image policy is the one the server applies', () => {
  assert.equal(imageProblem('https://example.org/x.png'), null);
  assert.equal(imageProblem('/uploads/x.png'), null);
  assert.ok(imageProblem('javascript:alert(1)'));
  assert.ok(imageProblem('data:text/html,x'));
  assert.ok(imageProblem('//elsewhere.example/x.png'));
  assert.ok(imageProblem('uploads/x.png'));
  assert.ok(imageProblem(''));
});

test('a code block language is held to what a class name can hold', () => {
  assert.equal(languageProblem('js'), null);
  assert.equal(languageProblem('c++'), null);
  assert.equal(languageProblem('objective-c'), null);
  assert.ok(languageProblem('two words'));
  assert.ok(languageProblem('x'.repeat(LIMITS.language + 1)));
});

test('bbcode that has no shorthand is left alone', () => {
  assert.equal(bbcodeToInline('[u]underlined[/u]'), '[u]underlined[/u]');
});

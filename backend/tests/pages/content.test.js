'use strict';

// The page content model: what a page may hold, and what a visitor is shown.
//
// These are the tests that keep the renderer honest. The content is
// untrusted - it comes from an editor, from a shared block, from a revision
// written months ago - so every block is checked before it is stored and
// every string is escaped on the way out.

const test = require('node:test');
const assert = require('node:assert/strict');
const content = require('../../src/services/pageContent');

// One block of every type the model knows.
const DOCUMENT = [
  { type: 'heading', level: 2, text: 'Terms' },
  { type: 'paragraph', text: 'Plain words.' },
  { type: 'lead', text: 'The standfirst.' },
  { type: 'list', ordered: false, items: ['One', 'Two'] },
  { type: 'note', kind: 'warn', text: 'Careful.' },
  { type: 'link', text: 'The rules', href: '/rules' },
  { type: 'rule' },
  { type: 'image', src: '/uploads/logo.png', alt: 'The instance logo' },
  { type: 'quote', text: 'We hold these terms.', attribution: 'The operator' },
  { type: 'code', text: 'npm run start', language: 'bash' },
  { type: 'table', headers: ['Term', 'Days'], rows: [['Notice', '30'], ['Chargeback', '14']], caption: 'Deadlines' },
];

// The message a refusal carries, so a test can say what was wrong.
function refusal(blocks) {
  try {
    content.normalise(blocks);
  } catch (e) {
    assert.equal(e.code, 'VALIDATION_ERROR', 'a refusal is a validation error');
    return e.message;
  }
  assert.fail('the content was accepted, and it should not have been');
}

test('the content model', async (t) => {
  await t.test('every block type is accepted', () => {
    const blocks = content.normalise(DOCUMENT);
    assert.equal(blocks.length, DOCUMENT.length);
    assert.deepEqual(
      blocks.map((b) => b.type),
      DOCUMENT.map((b) => b.type)
    );
  });

  await t.test('every block type renders', () => {
    const html = content.toHtml(content.normalise(DOCUMENT));
    assert.match(html, /<h2>Terms<\/h2>/);
    assert.match(html, /<p>Plain words\.<\/p>/);
    assert.match(html, /<p class="lede">The standfirst\.<\/p>/);
    assert.match(html, /<ul><li>One<\/li><li>Two<\/li><\/ul>/);
    assert.match(html, /<div class="draft-note" role="note">Careful\.<\/div>/);
    assert.match(html, /<p><a href="\/rules">The rules<\/a><\/p>/);
    assert.match(html, /<hr>/);
    assert.match(html, /<figure class="page-image">/);
    assert.match(html, /<blockquote class="page-quote">/);
    assert.match(html, /<pre class="page-code">/);
    assert.match(html, /<table class="page-table">/);
  });

  await t.test('a bad shape is refused, and the message says what is wrong', () => {
    assert.match(refusal([{ type: 'paragraph' }]), /a paragraph needs text/);
    assert.match(refusal([{ type: 'heading', level: 2, text: '   ' }]), /a heading needs text/);
    assert.match(refusal([{ type: 'list', items: [] }]), /a list needs at least one item/);
    assert.match(refusal([{ type: 'note', text: '   ', kind: 'warn' }]), /a note needs text/);
    assert.match(refusal([{ type: 'link', text: 'x', href: 'javascript:alert(1)' }]), /link targets must be/);
    assert.match(refusal([{ type: 'image', src: '/a.png' }]), /an image needs alt text/);
    assert.match(refusal([{ type: 'quote' }]), /a quotation needs text/);
    assert.match(refusal([{ type: 'code' }]), /a code block needs text/);
    assert.match(refusal([{ type: 'table', headers: [], rows: [] }]), /a table needs at least one column/);
    assert.match(refusal([{ type: 'table', headers: ['A'], rows: [] }]), /a table needs at least one row/);
    assert.match(
      refusal([{ type: 'table', headers: ['A', 'B'], rows: [['only one']] }]),
      /every table row must have the same number of cells/
    );
    assert.match(refusal([{ type: 'nonsense' }]), /unknown block type: nonsense/);
    assert.match(refusal([{ type: 'code', text: 'x', language: 'c++" onload="x' }]), /may only hold letters/);
  });

  await t.test('an image with a javascript: source is refused', () => {
    assert.match(
      refusal([{ type: 'image', src: 'javascript:alert(1)', alt: 'A picture' }]),
      /an image source must be http, https, or a path on this instance/
    );
    // The same rule, however it is spelled.
    assert.match(
      refusal([{ type: 'image', src: 'JaVaScRiPt:alert(1)', alt: 'A picture' }]),
      /an image source must be http, https, or a path on this instance/
    );
    assert.match(
      refusal([{ type: 'image', src: '  javascript:alert(1)', alt: 'A picture' }]),
      /an image source must be http, https, or a path on this instance/
    );
    // A data: source is a document, not a picture.
    assert.match(
      refusal([{ type: 'image', src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', alt: 'A picture' }]),
      /an image source must be http, https, or a path on this instance/
    );
    // Two slashes is another host, not a path on this instance.
    assert.match(
      refusal([{ type: 'image', src: '//elsewhere.example/x.png', alt: 'A picture' }]),
      /an image source must be http, https, or a path on this instance/
    );
  });

  await t.test('an image renders without anything that can execute', () => {
    const html = content.toHtml(content.normalise([
      { type: 'image', src: 'https://example.org/logo.png', alt: 'The logo', width: 320 },
    ]));
    assert.match(html, /<img src="https:\/\/example\.org\/logo\.png"/);
    assert.match(html, /alt="The logo"/);
    assert.match(html, /width="320"/);
    assert.match(html, /loading="lazy"/);
    assert.doesNotMatch(html, / on[a-z]+=/i, 'no event handler may reach the output');
    assert.doesNotMatch(html, /javascript:/i);
  });

  await t.test('a table with too many columns is refused', () => {
    const headers = Array.from({ length: content.MAX_COLUMNS + 1 }, (unused, i) => 'Column ' + i);
    assert.match(
      refusal([{ type: 'table', headers, rows: [headers.map(() => 'x')] }]),
      new RegExp('a table may have at most ' + content.MAX_COLUMNS + ' columns')
    );
    // A table that is exactly as wide as the limit is fine.
    const ok = Array.from({ length: content.MAX_COLUMNS }, (unused, i) => 'Column ' + i);
    const blocks = content.normalise([{ type: 'table', headers: ok, rows: [ok.map(() => 'x')] }]);
    assert.equal(blocks[0].headers.length, content.MAX_COLUMNS);
  });

  await t.test('a table with too many rows is refused', () => {
    const rows = Array.from({ length: content.MAX_ROWS + 1 }, () => ['x']);
    assert.match(
      refusal([{ type: 'table', headers: ['A'], rows }]),
      new RegExp('a table may have at most ' + content.MAX_ROWS + ' rows')
    );
  });

  await t.test('a code block is escaped and cannot break out of the element', () => {
    const html = content.toHtml(content.normalise([
      { type: 'code', text: '</code></pre><script>alert(1)</script><img src=x onerror=alert(1)>' },
    ]));
    assert.match(html, /<pre class="page-code"><code>/);
    assert.doesNotMatch(html, /<\/code><\/pre><script>/, 'the code block must not be able to close itself');
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;\/code&gt;&lt;\/pre&gt;&lt;script&gt;/);
  });

  await t.test('a table is escaped too', () => {
    const html = content.toHtml(content.normalise([
      { type: 'table', headers: ['<b>head</b>'], rows: [['<script>alert(1)</script>']], caption: 'A "caption"' },
    ]));
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;b&gt;head&lt;\/b&gt;/);
    assert.match(html, /<caption>/);
  });

  await t.test('an operator field is found wherever it can be written', () => {
    assert.deepEqual(
      content.operatorFields(content.normalise([
        { type: 'paragraph', text: 'OPERATOR: contact email' },
        { type: 'quote', text: 'Nothing here', attribution: 'OPERATOR: the operator' },
      ])),
      ['contact email', 'the operator']
    );
    // A code block cannot carry one: its text is code.
    assert.deepEqual(
      content.operatorFields(content.normalise([{ type: 'code', text: 'OPERATOR: not a field' }])),
      []
    );
  });

  await t.test('a page description is read from the standfirst', () => {
    assert.equal(
      content.descriptionOf(content.normalise([
        { type: 'heading', level: 2, text: 'Terms' },
        { type: 'lead', text: 'The terms this instance holds.' },
      ])),
      'The terms this instance holds.'
    );
    assert.equal(content.descriptionOf(content.normalise([{ type: 'paragraph', text: 'x' }])), '');
  });
});

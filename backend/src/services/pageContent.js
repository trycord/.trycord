// Structured page content for the static page editor.
//
// A page body is an array of typed blocks, not HTML. An administrator can
// therefore never inject a script tag, an inline event handler, or arbitrary
// markup into a legal page: the renderer decides what each block becomes, and
// every string value is escaped on the way out. That is the whole reason this is
// not a free-form rich text field.
//
// Block shapes:
//   heading    { level: 2|3, text }
//   paragraph  { text }
//   lead       { text }                      the standfirst under the title
//   list       { ordered: bool, items: [string] }
//   note       { text, kind: 'info'|'warn' }
//   link       { text, href }
//   rule       {}
//   image      { src, alt, width? }          a picture, from a URL or a path here
//   quote      { text, attribution? }        a block quotation
//   code       { text, language? }           a code block, escaped whole
//   table      { headers: [string], rows: [[string]], caption? }
//
// Blocks are the whole vocabulary. Anything else is rejected on save rather
// than dropped silently, so an editor bug shows up as a validation error
// instead of an operator discovering a missing paragraph in production.
//
// The renderer is the security boundary. The content is untrusted: it comes
// from an editor, from a shared block, from a revision restored from months
// ago. Every string that reaches the output is escaped, and no block can carry
// an attribute the renderer did not itself write - which is why an image
// cannot carry an event handler and a code block cannot carry a language that
// turns into a class name with a quote in it.
const MAX_BLOCKS = 400;
const MAX_TEXT = 8000;
const MAX_ITEMS = 60;
const MAX_ITEM = 500;
const MAX_IMAGE_SRC = 1000;
const MAX_IMAGE_ALT = 300;
const MAX_IMAGE_WIDTH = 2400;
const MAX_QUOTE = 4000;
const MAX_ATTRIBUTION = 200;
const MAX_CODE = 20000;
const MAX_LANGUAGE = 32;
const MAX_COLUMNS = 12;
const MAX_ROWS = 200;
const MAX_CELL = 500;
const MAX_CAPTION = 200;
const MAX_DESCRIPTION = 255;

const KINDS = {
  heading: 1, paragraph: 1, lead: 1, list: 1, note: 1, link: 1, rule: 1,
  image: 1, quote: 1, code: 1, table: 1,
};

// The blocks that existed before images, quotations, code and tables were
// added. Kept as a list because the BBCode exporter has to treat them exactly
// as it always did: a page written under the old vocabulary must export the
// same bytes it did before.
const LEGACY_TYPES = ['heading', 'paragraph', 'lead', 'list', 'note', 'link', 'rule'];

// Which fields of a block can carry an operator field - the "OPERATOR: ..." an
// operator leaves in a shipped template to say what still has to be filled in.
// A code block cannot: its text is code, not prose. An image's alt text is a
// label for a picture, not a field an operator is meant to fill in.
const OPERATOR_FIELDS = {
  heading: ['text'],
  paragraph: ['text'],
  lead: ['text'],
  note: ['text'],
  link: ['text'],
  list: [],
  rule: [],
  quote: ['text', 'attribution'],
  code: [],
  image: [],
  table: ['caption'],
};

function fail(message) {
  const e = new Error(message);
  e.code = 'VALIDATION_ERROR';
  throw e;
}

function str(v, max, field) {
  if (v == null) return '';
  const s = String(v);
  if (s.length > max) fail(`${field} is longer than ${max} characters`);
  return s;
}

function int(v, min, max, field) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    fail(`${field} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

// Only http(s), mailto and site-relative links. javascript: and data: cannot
// reach the renderer at all, so a stored XSS through a link is not reachable.
function safeHref(raw) {
  const s = str(raw, 500, 'link target').trim();
  if (!s) fail('a link needs a target');
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (!/^https?:/i.test(s) && !/^mailto:/i.test(s)) {
      fail('link targets must be http, https, mailto, or a path starting with /');
    }
    return s;
  }
  if (!s.startsWith('/') && !s.startsWith('#')) {
    fail('a relative link must start with / or #');
  }
  return s;
}

// The source of an image. Same allowlist as a link, with two differences that
// matter for a picture: mailto and # are not sources, and a source that
// starts with two slashes is a protocol-relative address to another host, not
// a path on this instance - so it is refused rather than fetched.
//
// A data: source is refused here, which is what stops an image from carrying
// a payload the browser would treat as a document.
function safeSrc(raw) {
  const s = str(raw, MAX_IMAGE_SRC, 'image source').trim();
  if (!s) fail('an image needs a source');
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (!/^https?:/i.test(s)) {
      fail('an image source must be http, https, or a path on this instance');
    }
    return s;
  }
  if (!s.startsWith('/') || s.startsWith('//')) {
    fail('an image source must be http, https, or a path on this instance');
  }
  return s;
}

// A language name is only ever used as a class name, so it is restricted to
// the characters a class name can hold. Anything else is dropped rather than
// escaped, because an escaped class name is still a strange class name.
function safeLanguage(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return '';
  if (s.length > MAX_LANGUAGE) fail(`a code block language is longer than ${MAX_LANGUAGE} characters`);
  if (!/^[a-z0-9+#._-]+$/.test(s)) {
    fail('a code block language may only hold letters, digits and + # . _ -');
  }
  return s;
}

function normaliseBlock(raw) {
  if (!raw || typeof raw !== 'object') fail('each block must be an object');
  const type = String(raw.type || '');
  if (!KINDS[type]) fail('unknown block type: ' + (type || '(missing)'));

  switch (type) {
    case 'heading': {
      // A heading is level one, two or three. Level one is the most ordinary
      // heading there is - a person writes "# Title" - and a server that
      // quietly turned it into level two made the source and the stored
      // document disagree about what the writer had typed.
      const wanted = Number(raw.level);
      const level = wanted === 1 || wanted === 3 ? wanted : 2;
      const text = str(raw.text, 200, 'heading text').trim();
      if (!text) fail('a heading needs text');
      return { type, level, text };
    }
    case 'paragraph': {
      const text = str(raw.text, MAX_TEXT, 'paragraph text').trim();
      if (!text) fail('a paragraph needs text');
      return { type, 'text': text };
    }
    case 'lead': {
      const text = str(raw.text, 600, 'lead text').trim();
      if (!text) fail('a lead needs text');
      return { type, text };
    }
    case 'list': {
      const items = Array.isArray(raw.items) ? raw.items : [];
      if (!items.length) fail('a list needs at least one item');
      if (items.length > MAX_ITEMS) fail(`a list may have at most ${MAX_ITEMS} items`);
      return {
        type,
        ordered: raw.ordered === true,
        items: items.map((i) => str(i, MAX_ITEM, 'list item').trim()).filter(Boolean),
      };
    }
    case 'note': {
      const text = str(raw.text, MAX_TEXT, 'note text').trim();
      if (!text) fail('a note needs text');
      const kind = raw.kind === 'warn' ? 'warn' : 'info';
      return { type, kind, text };
    }
    case 'link': {
      return { type, text: str(raw.text, 200, 'link text').trim() || raw.href, href: safeHref(raw.href) };
    }
    case 'rule':
      return { type };
    case 'image': {
      const alt = str(raw.alt, MAX_IMAGE_ALT, 'image alt text').trim();
      if (!alt) fail('an image needs alt text');
      const block = { type, src: safeSrc(raw.src), alt };
      if (raw.width != null && raw.width !== '') {
        block.width = int(raw.width, 1, MAX_IMAGE_WIDTH, 'an image width');
      }
      return block;
    }
    case 'quote': {
      const text = str(raw.text, MAX_QUOTE, 'quotation text').trim();
      if (!text) fail('a quotation needs text');
      const attribution = str(raw.attribution, MAX_ATTRIBUTION, 'attribution').trim();
      return attribution ? { type, text, attribution } : { type, text };
    }
    case 'code': {
      // The text of a code block keeps its indentation, because indentation
      // is what code means. It still has to hold something.
      const text = str(raw.text, MAX_CODE, 'code text');
      if (!text.trim()) fail('a code block needs text');
      const language = safeLanguage(raw.language);
      return language ? { type, text, language } : { type, text };
    }
    case 'table': {
      const headers = Array.isArray(raw.headers) ? raw.headers : [];
      if (!headers.length) fail('a table needs at least one column');
      if (headers.length > MAX_COLUMNS) fail(`a table may have at most ${MAX_COLUMNS} columns`);
      const names = headers.map((h) => str(h, MAX_CELL, 'table heading').trim());
      if (names.some((h) => !h)) fail('a table heading cannot be blank');
      const rows = Array.isArray(raw.rows) ? raw.rows : [];
      if (!rows.length) fail('a table needs at least one row');
      if (rows.length > MAX_ROWS) fail(`a table may have at most ${MAX_ROWS} rows`);
      const cells = rows.map((row) => {
        if (!Array.isArray(row)) fail('every table row must be a list of cells');
        if (row.length !== names.length) {
          fail('every table row must have the same number of cells as the table has columns');
        }
        return row.map((cell) => str(cell, MAX_CELL, 'table cell').trim());
      });
      const caption = str(raw.caption, MAX_CAPTION, 'table caption').trim();
      return caption ? { type, headers: names, rows: cells, caption } : { type, headers: names, rows: cells };
    }
    default:
      return fail('unknown block type');
  }
}

function normalise(body) {
  if (body == null) return [];
  if (!Array.isArray(body)) fail('page content must be an array of blocks');
  if (body.length > MAX_BLOCKS) fail(`a page may have at most ${MAX_BLOCKS} blocks`);
  return body.map(normaliseBlock);
}

// Approximate size, for the editor's character count and a cheap guard against
// a runaway paste.
function measure(blocks) {
  return JSON.stringify(blocks).length;
}

// The description of a page: the standfirst under the title, which is a lead
// block. A page's metadata is read from the body rather than stored beside
// it, so the two cannot disagree about what the page says.
function descriptionOf(blocks) {
  const lead = (blocks || []).find((b) => b && b.type === 'lead');
  if (!lead) return '';
  return String(lead.text || '').trim().slice(0, MAX_DESCRIPTION);
}

function toHtml(blocks) {
  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  // A block's text may carry BBCode, which is the notation operators already
  // type and the one a page can be lifted out into. It is parsed rather than
  // escaped, so text still reaches the page as markup only through the parser's
  // allowlist. esc() stays as the fallback for every value the parser rejects
  // or does not recognise, which is what keeps a stored string from ever
  // becoming markup directly.
  const { toHtmlInline } = require('./bbcode');
  const inline = (s) => toHtmlInline(s);

  return blocks
    .map((b) => {
      switch (b.type) {
        case 'heading':
          return `<h${b.level}>${inline(b.text)}</h${b.level}>`;
        case 'paragraph':
          return `<p>${inline(b.text)}</p>`;
        case 'lead':
          return `<p class="lede">${inline(b.text)}</p>`;
        case 'list': {
          const tag = b.ordered ? 'ol' : 'ul';
          return `<${tag}>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${tag}>`;
        }
        case 'note':
          return `<div class="draft-note" role="note">${esc(b.text)}</div>`;
        case 'link':
          return `<p><a href="${esc(b.href)}">${inline(b.text)}</a></p>`;
        case 'rule':
          return '<hr>';
        case 'image': {
          // Every attribute here is written by this renderer. The source has
          // been through the allowlist, so it cannot be a javascript: or data:
          // URL, and there is no attribute an editor supplied that reaches the
          // output - which is why there is no event handler to strip.
          const width = b.width ? ` width="${b.width}"` : '';
          return '<figure class="page-image">'
            + `<img src="${esc(b.src)}" alt="${esc(b.alt)}"${width}`
            + ' loading="lazy" decoding="async" referrerpolicy="no-referrer">'
            + '</figure>';
        }
        case 'quote': {
          const source = b.attribution
            ? `<footer class="page-quote-source">${esc(b.attribution)}</footer>`
            : '';
          return `<blockquote class="page-quote"><p>${inline(b.text)}</p>${source}</blockquote>`;
        }
        case 'code': {
          // The text of a code block is shown, not interpreted: it is escaped
          // whole, so nothing inside it can close the element or become markup.
          const cls = b.language ? ` class="language-${esc(b.language)}"` : '';
          return `<pre class="page-code"><code${cls}>${esc(b.text)}</code></pre>`;
        }
        case 'table': {
          const caption = b.caption ? `<caption>${inline(b.caption)}</caption>` : '';
          const head = '<thead><tr>'
            + b.headers.map((h) => `<th scope="col">${inline(h)}</th>`).join('')
            + '</tr></thead>';
          const body = '<tbody>'
            + b.rows.map((row) => '<tr>'
              + row.map((cell) => `<td>${inline(cell)}</td>`).join('')
              + '</tr>').join('')
            + '</tbody>';
          return `<table class="page-table">${caption}${head}${body}</table>`;
        }
        default:
          return '';
      }
    })
    .join('\n      ');
}

// Which operator fields a published page still has unfilled. Read straight out
// of the stored body, so the console can show an operator which parts of their
// policy are still a template without them having to remember.
function operatorFields(blocks) {
  const found = [];
  for (const b of blocks || []) {
    const fields = OPERATOR_FIELDS[b && b.type];
    if (!fields) continue;
    for (const field of fields) {
      const text = b[field] || '';
      const m = /OPERATOR:\s*([^<]{0,200})/.exec(text);
      if (m) found.push(m[1].trim().replace(/\s+/g, ' ').slice(0, 160));
    }
  }
  return found;
}

// -- comparing two bodies ----------------------------------------------------
//
// The report two revisions produce between them. It is a report about the
// content, not a rendered diff: it says which blocks were added, which were
// removed and which were changed, and leaves the showing of it to the client.
//
// Blocks are matched on their whole content, so a paragraph that moved down
// the page is not a removal and an addition. What is left over is paired by
// type - the first paragraph here with the first paragraph there - because
// that is what an operator means by "this paragraph was rewritten".

function blockKey(block) {
  return JSON.stringify(block);
}

// The longest common subsequence of two key lists, as pairs of indices.
function commonPairs(a, b) {
  const table = [];
  for (let i = 0; i <= a.length; i++) table.push(new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

function groupByType(blocks, start) {
  const groups = new Map();
  blocks.forEach((block, offset) => {
    const type = String(block && block.type || '');
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push({ index: start + offset, block });
  });
  return groups;
}

// The blocks between two matching blocks, paired by type.
function reportGap(older, newer, olderStart, newerStart, out) {
  const olderByType = groupByType(older, olderStart);
  const newerByType = groupByType(newer, newerStart);
  for (const [type, olderBlocks] of olderByType) {
    const newerBlocks = newerByType.get(type) || [];
    const paired = Math.min(olderBlocks.length, newerBlocks.length);
    for (let k = 0; k < paired; k++) {
      const before = olderBlocks[k];
      const after = newerBlocks[k];
      if (blockKey(before.block) === blockKey(after.block)) {
        out.unchanged++;
      } else {
        out.changed.push({
          fromIndex: before.index,
          toIndex: after.index,
          before: before.block,
          after: after.block,
        });
      }
    }
    for (let k = paired; k < olderBlocks.length; k++) {
      out.removed.push({ index: olderBlocks[k].index, block: olderBlocks[k].block });
    }
  }
  for (const [type, newerBlocks] of newerByType) {
    const olderBlocks = olderByType.get(type) || [];
    const paired = Math.min(olderBlocks.length, newerBlocks.length);
    for (let k = paired; k < newerBlocks.length; k++) {
      out.added.push({ index: newerBlocks[k].index, block: newerBlocks[k].block });
    }
  }
}

// What changed between two bodies.
function compare(olderBlocks, newerBlocks) {
  const older = olderBlocks || [];
  const newer = newerBlocks || [];
  const out = { added: [], removed: [], changed: [], unchanged: 0 };
  const pairs = commonPairs(older.map(blockKey), newer.map(blockKey));
  let olderAt = 0;
  let newerAt = 0;
  for (const [olderIndex, newerIndex] of pairs) {
    reportGap(older.slice(olderAt, olderIndex), newer.slice(newerAt, newerIndex), olderAt, newerAt, out);
    out.unchanged++;
    olderAt = olderIndex + 1;
    newerAt = newerIndex + 1;
  }
  reportGap(older.slice(olderAt), newer.slice(newerAt), olderAt, newerAt, out);
  const byIndex = (a, b) => a.index - b.index;
  out.added.sort(byIndex);
  out.removed.sort(byIndex);
  out.changed.sort((a, b) => a.toIndex - b.toIndex);
  return out;
}

// Blocks back to BBCode. The other half of "compatible": a page authored here
// can be lifted into a forum and keep its formatting, so nothing is trapped in
// this editor. Required at the top level rather than lazily because an export
// has to exist whether or not anything has rendered yet.
const { toBBCode: legacyToBBCode } = require('./bbcode');

// One table, in the BBCode a forum understands. The cells are separated by a
// pipe and the rows by a newline, because a table has no BBCode of its own.
function tableToBBCode(block) {
  const rows = [block.headers || []].concat(block.rows || []);
  return '[table]\n'
    + rows.map((row) => '[tr]' + row.map((cell) => '[td]' + cell + '[/td]').join('') + '[/tr]').join('\n')
    + '\n[/table]';
}

// The legacy exporter is called one block at a time for the blocks it knows,
// which gives byte for byte what it produced when it was handed the whole
// body: it joins its output with a blank line, and so does this.
function toBBCode(blocks) {
  const out = [];
  for (const b of blocks || []) {
    switch (b.type) {
      case 'image':
        out.push('[img]' + b.src + '[/img]');
        break;
      case 'quote':
        out.push('[quote=' + (b.attribution || '') + ']' + (b.text || '') + '[/quote]');
        break;
      case 'code':
        out.push('[code]' + (b.text || '') + '[/code]');
        break;
      case 'table':
        out.push(tableToBBCode(b));
        break;
      default:
        if (LEGACY_TYPES.includes(b.type)) out.push(legacyToBBCode([b]));
        // A block type the exporter does not know contributes nothing, which
        // is what it always did.
        break;
    }
  }
  return out.join('\n\n');
}

module.exports = {
  normalise, toHtml, toBBCode, measure, operatorFields, descriptionOf, compare,
  MAX_BLOCKS, MAX_COLUMNS, MAX_ROWS,
};

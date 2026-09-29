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
//
// Blocks are the whole vocabulary. Anything else is rejected on save rather
// than dropped silently, so an editor bug shows up as a validation error
// instead of an operator discovering a missing paragraph in production.
const MAX_BLOCKS = 400;
const MAX_TEXT = 8000;
const MAX_ITEMS = 60;
const MAX_ITEM = 500;

const KINDS = { heading: 1, paragraph: 1, lead: 1, list: 1, note: 1, link: 1, rule: 1 };

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

function normaliseBlock(raw) {
  if (!raw || typeof raw !== 'object') fail('each block must be an object');
  const type = String(raw.type || '');
  if (!KINDS[type]) fail('unknown block type: ' + (type || '(missing)'));

  switch (type) {
    case 'heading': {
      const level = Number(raw.level) === 3 ? 3 : 2;
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

function toHtml(blocks) {
  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  return blocks
    .map((b) => {
      switch (b.type) {
        case 'heading':
          return `<h${b.level}>${esc(b.text)}</h${b.level}>`;
        case 'paragraph':
          return `<p>${esc(b.text)}</p>`;
        case 'lead':
          return `<p class="lede">${esc(b.text)}</p>`;
        case 'list': {
          const tag = b.ordered ? 'ol' : 'ul';
          return `<${tag}>${b.items.map((i) => `<li>${esc(i)}</li>`).join('')}</${tag}>`;
        }
        case 'note':
          return `<div class="draft-note" role="note">${esc(b.text)}</div>`;
        case 'link':
          return `<p><a href="${esc(b.href)}">${esc(b.text)}</a></p>`;
        case 'rule':
          return '<hr>';
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
  for (const b of blocks) {
    const text = b.text || '';
    const m = /OPERATOR:\s*([^<]{0,200})/.exec(text);
    if (m) found.push(m[1].trim().replace(/\s+/g, ' ').slice(0, 160));
  }
  return found;
}

module.exports = { normalise, toHtml, measure, operatorFields, MAX_BLOCKS };

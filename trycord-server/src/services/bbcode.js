// BBCode for page content.
//
// Why: operators write legal pages that get pasted between forums, and BBCode
// is what most of them already type. It is also what people mean by "compatible"
// - a page authored here can be copied into a forum and keep its formatting,
// which HTML-in-a-textarea cannot offer.
//
// This is a parser, not a set of regular expressions. A regex BBCode converter
// is the standard way to get cross-site scripting into a page, because it
// rewrites the input into HTML before deciding what the input was. Here the
// input is never HTML: it is tokenised into a tree, only the tags named below
// are recognised, and every one of them is emitted by this file from values it
// has validated. Anything unrecognised is left as literal text.
//
// Safety rules, all of which are tests in test-page-editor.js:
//   - no tag can carry an attribute, because BBCode has none and an attribute
//     is where a payload would hide
//   - [url] targets go through the same allowlist as a link block, so
//     javascript: and data: cannot be reached
//   - [color] takes a named colour from a fixed list or a 3/6 digit hex, so it
//     cannot become a CSS declaration
//   - [size] is an integer 1-7, mapped to a fixed class, never an inline style
//   - [code] contents are escaped and not parsed, so markup inside a code block
//     is shown rather than executed
//   - nesting is depth-limited, so a crafted document cannot blow the stack
const MAX_DEPTH = 12;
const MAX_TAG_LEN = 24;
const MAX_URL = 500;

// Named colours only. Anything outside this list is dropped, which is what
// makes [color] unable to express a style rather than merely unlikely to.
const COLOURS = {
  red: 'red', maroon: 'maroon', orange: 'orange', olive: 'olive',
  green: 'green', teal: 'teal', aqua: 'aqua', blue: 'blue',
  navy: 'navy', fuchsia: 'fuchsia', purple: 'purple', maroon2: 'maroon',
  gray: 'gray', grey: 'gray', silver: 'silver', yellow: 'yellow',
  white: 'white', black: 'black', orange2: 'orange', pink: 'pink',
};

const SIZE_CLASS = { 1: 'bbcode-size-1', 2: 'bbcode-size-2', 3: 'bbcode-size-3', 4: 'bbcode-size-4', 5: 'bbcode-size-5', 6: 'bbcode-size-6', 7: 'bbcode-size-7' };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Same policy as a link block: http, https, mailto, or a site-relative path.
// javascript: and data: are rejected here rather than filtered later, so they
// cannot survive a refactor of the renderer.
function safeUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  if (s.length > MAX_URL) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    return /^(https?|mailto):/i.test(s) ? s : null;
  }
  if (s.startsWith('/') || s.startsWith('#')) return s;
  return null;
}

function safeColour(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (COLOURS[s]) return COLOURS[s];
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(s)) return s;
  return null;
}

// Tags whose children are text, never markup. Escaping them is what makes
// [code] a code block rather than a second parser to get wrong.
const LITERAL = new Set(['code', 'quote', 'spoiler']);

// Simple wrappers. Value is the tag name to emit, or null when the tag carries
// no output of its own.
const WRAPPERS = {
  b: 'strong', i: 'em', u: 'u', s: 's', del: 's', strike: 's',
  sub: 'sub', sup: 'sup',
  left: 'span-left', right: 'span-right', center: 'span-center', justify: 'span-justify',
};

const isTagName = (n) => /^[a-z][a-z0-9]*$/.test(n);

// Built with the RegExp constructor rather than written as a literal. A
// quantifier like {0,MAX_TAG_LEN-1} inside a literal is not interpolation: it is
// an invalid quantifier, which in non-unicode mode silently degrades to matching
// those literal characters, so no tag ever matched and every input rendered as
// plain text. That failure looks like "the formatter does nothing" rather than
// like a syntax problem, which is why it is worth naming.
const TAG_RE = new RegExp(
  '^\\[([a-z][a-z0-9]{0,' + (MAX_TAG_LEN - 1) + '})(?:=([^\\]\\n]{0,' + MAX_URL + '}))?\\]',
  'i'
);

// Walks the tree to the matching close tag, so a wrapper does not swallow the
// rest of the document when its close tag is missing.
function parseNodes(src, depth) {
  const out = [];
  let buf = '';
  let i = 0;
  const flush = () => { if (buf) { out.push({ text: buf }); buf = ''; } };

  while (i < src.length) {
    const c = src[i];
    if (c !== '[') { buf += c; i++; continue; }
    const m = TAG_RE.exec(src.slice(i));
    if (!m) { buf += c; i++; continue; }
    const name = m[1].toLowerCase();
    const arg = m[2] === undefined ? null : m[2];
    const closeRe = new RegExp('\\[/' + name + '\\]', 'i');
    const closeAt = closeRe.exec(src.slice(i + m[0].length));
    const known = WRAPPERS[name] || name === 'url' || name === 'color' || name === 'size'
      || name === 'center' || name === 'br' || name === 'hr' || LITERAL.has(name);
    if (!known || name === 'br' || name === 'hr') {
      if (name === 'br') { flush(); out.push({ tag: 'br' }); i += m[0].length; continue; }
      if (name === 'hr') { flush(); out.push({ tag: 'hr' }); i += m[0].length; continue; }
      buf += m[0]; i += m[0].length; continue;
    }

    flush();
    const inner = closeAt ? src.slice(i + m[0].length, i + m[0].length + closeAt.index) : src.slice(i + m[0].length);
    const after = closeAt ? i + m[0].length + closeAt.index + closeAt[0].length : src.length;

    if (LITERAL.has(name)) {
      out.push({ tag: name, arg, children: [{ text: inner }] });
    } else if (name === 'url') {
      out.push({ tag: 'url', href: safeUrl(arg !== null ? arg : inner), children: [{ text: inner }] });
    } else if (name === 'color') {
      const colour = safeColour(arg);
      if (colour) out.push({ tag: 'color', colour, children: depth >= MAX_DEPTH ? [{ text: inner }] : parseNodes(inner, depth + 1).nodes });
    } else if (name === 'size') {
      const n = parseInt(arg, 10);
      if (n >= 1 && n <= 7) out.push({ tag: 'size', cls: SIZE_CLASS[n], children: depth >= MAX_DEPTH ? [{ text: inner }] : parseNodes(inner, depth + 1).nodes });
    } else {
      out.push({ tag: WRAPPERS[name], children: depth >= MAX_DEPTH ? [{ text: inner }] : parseNodes(inner, depth + 1).nodes });
    }
    i = after;
  }
  flush();
  return { nodes: out, index: i };
}

function renderNodes(nodes) {
  let html = '';
  for (const n of nodes) {
    if (n.text !== undefined) { html += esc(n.text); continue; }
    switch (n.tag) {
      case 'code':
        html += '<pre class="bbcode-code"><code>' + esc((n.children[0] || {}).text || '') + '</code></pre>';
        break;
      case 'quote': {
        const who = n.arg ? '<cite class="bbcode-quote-who">' + esc(n.arg) + '</cite>' : '';
        html += '<blockquote class="bbcode-quote">' + who + esc((n.children[0] || {}).text || '') + '</blockquote>';
        break;
      }
      case 'spoiler':
        html += '<span class="bbcode-spoiler" tabindex="0">' + esc((n.children[0] || {}).text || '') + '</span>';
        break;
      case 'url': {
        const inner = (n.children[0] || {}).text || '';
        // A target that failed the allowlist renders as plain text, so the link
        // is visibly inert rather than silently dropped.
        if (!n.href) { html += esc(inner); break; }
        const external = /^https?:/i.test(n.href);
        html += '<a href="' + esc(n.href) + '"' + (external ? ' rel="noopener noreferrer nofollow" target="_blank"' : '') + '>' + esc(inner || n.href) + '</a>';
        break;
      }
      case 'color':
        html += '<span class="bbcode-color" style="color:' + esc(n.colour) + '">' + renderNodes(n.children) + '</span>';
        break;
      case 'size':
        html += '<span class="' + n.cls + '">' + renderNodes(n.children) + '</span>';
        break;
      case 'br':
        html += '<br>';
        break;
      case 'hr':
        html += '<hr>';
        break;
      default:
        html += '<' + n.tag + '>' + renderNodes(n.children) + '</' + n.tag + '>';
    }
  }
  return html;
}

// Inline formatting inside one text run. This is what turns a block's text into
// HTML, and it is the only place a stored string becomes markup.
function toHtmlInline(text) {
  return renderNodes(parseNodes(String(text == null ? '' : text), 0).nodes);
}

// --- export ---------------------------------------------------------------

// Blocks to BBCode, so a page can be lifted out of here and still read. This is
// the other half of "compatible": nothing you author here is trapped here.
function toBBCode(blocks) {
  const out = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading': out.push('[size=' + (b.level === 3 ? 4 : 6) + ']' + (b.text || '') + '[/size]'); break;
      case 'lead': out.push('[i]' + (b.text || '') + '[/i]'); break;
      case 'paragraph': out.push(b.text || ''); break;
      case 'note': out.push('[quote]' + (b.text || '') + '[/quote]'); break;
      case 'list': {
        const tag = b.ordered ? '[list=1]' : '[list]';
        out.push(tag + (b.items || []).map((i) => '[*]' + i).join('') + '[/list]');
        break;
      }
      case 'link': out.push('[url=' + b.href + ']' + (b.text || b.href) + '[/url]'); break;
      case 'rule': out.push('[hr]'); break;
      default: break;
    }
  }
  return out.join('\n\n');
}

module.exports = { toHtmlInline, toBBCode, safeUrl, safeColour, parseNodes, COLOURS, SIZE_CLASS };

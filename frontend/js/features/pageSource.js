// The source mode of the page editor.
//
// A page body is a list of typed blocks, and the server accepts nothing else -
// it refuses a body it does not recognise rather than dropping what it does
// not understand. The source mode is a second way to write that same list: a
// text where each block is one unit. The two modes are two views of one model,
// so switching between them never changes what is stored.
//
// The source is Markdown-flavoured, and deliberately small:
//
//   # heading                a heading, level one
//   ## heading               a heading, level two
//   ### heading              a heading, level three
//   ! standfirst             the lead under the title
//   > quotation              a quotation
//   > -- attribution         who said it, on the last line of the quotation
//   ~ note                   a note
//   ~! note                  a warning note
//   - item                   an unordered list
//   1. item                  an ordered list
//   [label](target)          a link
//   ![alt](src)              an image
//   ![alt](src "width=320")  an image with a width
//   ```language              a code block, fenced
//   | a | b |                a table, with a separator row under its headings
//   : caption                the caption of the table that follows it
//   ---                      a rule
//   anything else            a paragraph
//
// Inline formatting travels as BBCode, because that is what the server
// renders. The source writes the shorthand people already type - **bold**,
// *italic*, `code`, [text](url) - and reads it back.
//
// The source is a projection of the blocks and not a copy of them: it carries
// every field a block carries, so a reader who edits the source and saves does
// not lose what they wrote. What the source cannot read, it names with the
// line it is on, rather than storing a body the server would turn down.

export const LIMITS = {
  blocks: 400,
  text: 8000,
  heading: 200,
  lead: 600,
  link: 200,
  items: 60,
  item: 500,
  imageSrc: 1000,
  imageAlt: 300,
  imageWidth: 2400,
  quote: 4000,
  attribution: 200,
  code: 20000,
  language: 32,
  columns: 12,
  rows: 200,
  cell: 500,
  caption: 200,
};

// The link policy, the same one the server applies: http, https, mailto, or a
// path into this site. javascript: and data: cannot be reached at all.
export function linkProblem(href) {
  const value = String(href == null ? '' : href).trim();
  if (!value) return 'a link needs a target';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    if (!/^https?:/i.test(value) && !/^mailto:/i.test(value)) {
      return 'link targets must be http, https, mailto, or a path starting with /';
    }
    return null;
  }
  if (!value.startsWith('/') && !value.startsWith('#')) {
    return 'a relative link must start with / or #';
  }
  return null;
}

// The source of an image. The same allowlist as a link, with two differences
// that matter for a picture: mailto and # are not sources, and a source that
// begins with two slashes is an address to another host rather than a path on
// this instance. A data: source is refused too, because a picture is a
// picture and not a document.
export function imageProblem(src) {
  const value = String(src == null ? '' : src).trim();
  if (!value) return 'an image needs a source';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    if (!/^https?:/i.test(value)) {
      return 'an image source must be http, https, or a path on this instance';
    }
    return null;
  }
  if (!value.startsWith('/') || value.startsWith('//')) {
    return 'an image source must be http, https, or a path on this instance';
  }
  return null;
}

// The language of a code block is only ever used as a class name, so it is
// held to the characters a class name can hold.
export function languageProblem(language) {
  const value = String(language == null ? '' : language).trim().toLowerCase();
  if (!value) return null;
  if (value.length > LIMITS.language) {
    return 'a code block language may be at most ' + LIMITS.language + ' characters';
  }
  if (!/^[a-z0-9+#._-]+$/.test(value)) {
    return 'a code block language may only hold letters, digits and + # . _ -';
  }
  return null;
}

// -- inline -------------------------------------------------------------------
//
// The shorthand to BBCode, and back. Only a complete pair is converted, so a
// lone asterisk stays a lone asterisk - which is what the server's parser
// does with it too.

export function inlineToBBCode(text) {
  return String(text == null ? '' : text)
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, (match, label, href) => {
      // A target the server would refuse is left as written, and the
      // validator says why.
      if (linkProblem(href)) return match;
      return '[url=' + href + ']' + label + '[/url]';
    })
    .replace(/\*\*([^*\s][^*\n]*?)\*\*/g, '[b]$1[/b]')
    .replace(/\*([^*\s][^*\n]*?)\*/g, '[i]$1[/i]')
    .replace(/~~([^~\s][^~\n]*?)~~/g, '[s]$1[/s]')
    .replace(/`([^`\n]+)`/g, '[code]$1[/code]');
}

export function bbcodeToInline(text) {
  return String(text == null ? '' : text)
    .replace(/\[url=([^\]]*)\]([\s\S]*?)\[\/url\]/g, (match, href, label) => '[' + label + '](' + href + ')')
    .replace(/\[b\]([\s\S]*?)\[\/b\]/g, '**$1**')
    .replace(/\[i\]([\s\S]*?)\[\/i\]/g, '*$1*')
    .replace(/\[s\]([\s\S]*?)\[\/s\]/g, '~~$1~~')
    .replace(/\[del\]([\s\S]*?)\[\/del\]/g, '~~$1~~')
    .replace(/\[strike\]([\s\S]*?)\[\/strike\]/g, '~~$1~~')
    // A code block that spans lines has no shorthand form, so it stays as it
    // is written.
    .replace(/\[code\]([\s\S]*?)\[\/code\]/g, (match, code) => (
      code.indexOf('\n') === -1 ? '`' + code + '`' : match
    ));
}

// -- values written into the source -------------------------------------------
//
// A value may hold a pipe, a bracket or a line of its own, and it still has to
// be written on one line and read back as it was written. A backslash escapes
// the character after it, and each place escapes only what would end it there.

const ENDS = {
  alt: /\]/g,
  src: /\)/g,
  cell: /\|/g,
};

function escapeValue(value, ends) {
  let out = String(value == null ? '' : value)
    .replace(/[\\\n]/g, (character) => (character === '\n' ? '\\n' : '\\\\'));
  if (ends) out = out.replace(ends, (character) => '\\' + character);
  return out;
}

function unescapeValue(value) {
  return String(value == null ? '' : value)
    .replace(/\\([\s\S])/g, (match, character) => (character === 'n' ? '\n' : character));
}

// The longest run of a character in a text. The fence of a code block has to
// be longer than any run of backticks inside it, or the code would end early.
function longestRun(text, character) {
  let longest = 0;
  let run = 0;
  for (const one of String(text == null ? '' : text)) {
    run = one === character ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

// -- source to blocks ---------------------------------------------------------

// A heading is one, two or three hashes. A single hash is the most ordinary
// heading there is - it is what a person writes, and a document that used it
// was refused with "a heading is written with two or three #", which accused
// the writer of using two or three when they had used one.
const HEADING = /^(#{1,3})\s+(.*)$/;
const LEAD = /^!\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const ATTRIBUTION = /^--\s(.*)$/;
const NOTE_WARN = /^~!\s?(.*)$/;
const NOTE = /^~\s?(.*)$/;
const RULE = /^-{3,}\s*$/;
const BULLET = /^[-*]\s+(.*)$/;
const ORDERED = /^\d+[.)]\s+(.*)$/;
const IMAGE = /^!\[((?:\\.|[^\]\\])*)\]\(((?:\\.|[^)\\])*)\)(?:\s+"([^"]*)")?\s*$/;
// A source that holds a parenthesis cannot be told from the frame of the
// image, so it is read to the last parenthesis rather than refused.
const IMAGE_LOOSE = /^!\[((?:\\.|[^\]\\])*)\]\((.*)\)(?:\s+"([^"]*)")?\s*$/;
const FENCE = /^(`{3,})\s*(.*)$/;
const TABLE_ROW = /^\|.*$/;
const CAPTION = /^:\s+(.*)$/;
const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)]*)\)/g;

// A line that is one link and nothing else. The target is taken from the
// last bracket, so a target may hold a bracket of its own; a line that holds
// two links is not one link and stays a paragraph.
function loneLink(text) {
  if (text.charAt(0) !== '[' || text.charAt(text.length - 1) !== ')') return null;
  const close = text.indexOf(']');
  if (close === -1) return null;
  const label = text.slice(1, close);
  const rest = text.slice(close + 1);
  if (rest.charAt(0) !== '(') return null;
  const target = rest.slice(1, -1);
  if (target.indexOf('[') !== -1 || target.indexOf(']') !== -1) return null;
  return { label, target };
}

// The problems a line's own links carry, so a target the server would refuse
// is named rather than stored.
function linkProblemsIn(text) {
  const problems = [];
  const re = new RegExp(MARKDOWN_LINK.source, 'g');
  let match;
  while ((match = re.exec(text))) {
    const problem = linkProblem(match[2]);
    if (problem) problems.push(problem);
  }
  return problems;
}

// The cells of a pipe row. A pipe inside a cell is written as \|, and the
// pipes at the ends of the row are the row's frame rather than cells.
function splitRow(line) {
  const cells = [];
  let current = '';
  for (let index = 0; index < line.length; index += 1) {
    const character = line.charAt(index);
    if (character === '\\' && index + 1 < line.length) {
      current += character + line.charAt(index + 1);
      index += 1;
      continue;
    }
    if (character === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  cells.push(current);
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells;
}

// The row of dashes that says which row of a table holds the headings.
function isSeparator(line) {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

// The image a line describes. The alt text is required, the source is held to
// the allowlist, and a title may only carry a width.
function readImage(match, line, errors) {
  const alt = unescapeValue(match[1]).trim();
  const src = unescapeValue(match[2]).trim();
  if (!alt) {
    errors.push({ line, message: 'an image needs alt text' });
    return null;
  }
  const problem = imageProblem(src);
  if (problem) {
    errors.push({ line, message: problem });
    return null;
  }
  const block = { type: 'image', src, alt };
  if (match[3] !== undefined) {
    const title = match[3].trim();
    const width = /^width=(\d+)$/.exec(title);
    if (!width) {
      errors.push({ line, message: 'the title of an image may only be a width, as width=320' });
      return null;
    }
    const size = Number(width[1]);
    if (size < 1 || size > LIMITS.imageWidth) {
      errors.push({ line, message: 'an image width must be a whole number between 1 and ' + LIMITS.imageWidth });
      return null;
    }
    block.width = size;
  }
  return block;
}

// The code block that starts at a fence: the code, and the fence that closes
// it. The code keeps its indentation, because indentation is what code means.
function readCode(lines, start, fence, info, errors) {
  const language = info.trim();
  const problem = languageProblem(language);
  if (problem) errors.push({ line: start + 1, message: problem });
  const closing = new RegExp('^`{' + fence.length + ',}\\s*$');
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (closing.test(lines[index].trim())) {
      if (problem) return { block: null, last: index };
      const block = { type: 'code', text: body.join('\n') };
      if (language) block.language = language.toLowerCase();
      return { block, last: index };
    }
    body.push(lines[index]);
  }
  errors.push({ line: start + 1, message: 'a code block needs a closing fence' });
  return { block: null, last: lines.length - 1 };
}

// The table that starts at a heading row: the headings, and the rows that
// follow. Every row has to be as wide as the headings, because the server
// refuses a ragged table rather than pad it.
function readTable(lines, start, caption, errors) {
  const headers = splitRow(lines[start]).map((cell) => inlineToBBCode(unescapeValue(cell)).trim());
  const rows = [];
  let last = start + 1;
  let ragged = 0;
  for (let index = start + 2; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!TABLE_ROW.test(line)) break;
    const cells = splitRow(line).map((cell) => inlineToBBCode(unescapeValue(cell)).trim());
    if (cells.length !== headers.length) {
      errors.push({
        line: index + 1,
        message: 'every table row must have the same number of cells as the table has columns',
      });
      ragged += 1;
    } else {
      rows.push(cells);
    }
    last = index;
  }
  if (ragged) return { block: null, last };
  if (!headers.length) {
    errors.push({ line: start + 1, message: 'a table needs at least one column' });
    return { block: null, last };
  }
  if (headers.some((heading) => !heading)) {
    errors.push({ line: start + 1, message: 'a table heading cannot be blank' });
    return { block: null, last };
  }
  if (!rows.length) {
    errors.push({ line: start + 1, message: 'a table needs at least one row' });
    return { block: null, last };
  }
  const block = { type: 'table', headers, rows };
  const text = inlineToBBCode(unescapeValue(caption)).trim();
  if (text) block.caption = text;
  return { block, last };
}

// The blocks a source text describes, and what is wrong with the text that
// does not describe blocks. The errors carry the line they are on, because a
// page is written in lines and an error without one is a hunt.
export function sourceToBlocks(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const blocks = [];
  const errors = [];
  let paragraph = [];
  let list = null;
  let quote = null;

  function flushParagraph() {
    if (!paragraph.length) return;
    const raw = paragraph.join(' ').trim();
    paragraph = [];
    if (raw) blocks.push({ type: 'paragraph', text: inlineToBBCode(raw) });
  }

  function flushList() {
    if (!list) return;
    blocks.push({ type: 'list', ordered: list.ordered, items: list.items });
    list = null;
  }

  // A quotation is the lines that begin with a marker, and the last of them
  // may say who said it. The marker needs a line of its own to be read as an
  // attribution, so a quotation of one line is text: the writer escapes a line
  // that would be read as one.
  function flushQuote() {
    if (!quote) return;
    const held = quote;
    quote = null;
    const quoted = held.lines.slice();
    let attribution = '';
    if (quoted.length > 1 && ATTRIBUTION.test(quoted[quoted.length - 1])) {
      attribution = unescapeValue(ATTRIBUTION.exec(quoted[quoted.length - 1])[1]).trim();
      quoted.pop();
    }
    const text = quoted.map((line) => inlineToBBCode(unescapeValue(line))).join('\n').trim();
    if (!text) {
      errors.push({ line: held.line, message: 'a quotation needs text' });
      return;
    }
    const block = { type: 'quote', text };
    if (attribution) block.attribution = attribution;
    blocks.push(block);
  }

  function flushOthers() {
    flushParagraph();
    flushList();
  }

  function flush() {
    flushOthers();
    flushQuote();
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const number = index + 1;
    const trimmed = line.trim();
    if (!trimmed) { flush(); continue; }

    const fence = FENCE.exec(trimmed);
    if (fence) {
      flush();
      const read = readCode(lines, index, fence[1], fence[2], errors);
      if (read.block) blocks.push(read.block);
      index = read.last;
      continue;
    }

    const image = IMAGE.exec(trimmed) || IMAGE_LOOSE.exec(trimmed);
    if (image) {
      flush();
      const block = readImage(image, number, errors);
      if (block) blocks.push(block);
      continue;
    }

    if (TABLE_ROW.test(trimmed)) {
      flush();
      if (!isSeparator(lines[index + 1] || '')) {
        errors.push({ line: number, message: 'a table needs a separator row under its headings' });
        continue;
      }
      const read = readTable(lines, index, '', errors);
      if (read.block) blocks.push(read.block);
      index = read.last;
      continue;
    }

    // The caption of a table is the line above it, and only there: a line
    // that begins with a colon and is not above a table is a paragraph.
    const caption = CAPTION.exec(trimmed);
    if (caption
      && TABLE_ROW.test((lines[index + 1] || '').trim())
      && isSeparator(lines[index + 2] || '')) {
      flush();
      const read = readTable(lines, index + 1, caption[1], errors);
      if (read.block) blocks.push(read.block);
      index = read.last;
      continue;
    }

    if (/^#/.test(trimmed) && !HEADING.test(trimmed)) {
      flush();
      errors.push({ line: number, message: 'a heading is written with one, two or three #' });
      continue;
    }

    const heading = HEADING.exec(trimmed);
    if (heading) {
      flush();
      const text = heading[2].trim();
      if (!text) {
        errors.push({ line: number, message: 'a heading needs text' });
        continue;
      }
      blocks.push({ type: 'heading', level: heading[1].length, text: inlineToBBCode(text) });
      continue;
    }

    const lead = LEAD.exec(trimmed);
    if (lead) {
      flush();
      const text = lead[1].trim();
      if (!text) {
        errors.push({ line: number, message: 'a standfirst needs text' });
        continue;
      }
      blocks.push({ type: 'lead', text: inlineToBBCode(text) });
      continue;
    }

    const quoted = QUOTE.exec(trimmed);
    if (quoted) {
      flushOthers();
      if (!quote) quote = { line: number, lines: [] };
      quote.lines.push(quoted[1]);
      continue;
    }

    const warn = NOTE_WARN.exec(trimmed);
    const note = warn || NOTE.exec(trimmed);
    if (note) {
      flush();
      const text = (warn ? warn[1] : note[1]).trim();
      if (!text) {
        errors.push({ line: number, message: 'a note needs text' });
        continue;
      }
      blocks.push({ type: 'note', kind: warn ? 'warn' : 'info', text });
      continue;
    }

    if (RULE.test(trimmed)) {
      flush();
      blocks.push({ type: 'rule' });
      continue;
    }

    const bullet = BULLET.exec(trimmed);
    const ordered = bullet ? null : ORDERED.exec(trimmed);
    if (bullet || ordered) {
      flushParagraph();
      flushQuote();
      const text = (bullet ? bullet[1] : ordered[1]).trim();
      const wantOrdered = !bullet;
      if (list && list.ordered !== wantOrdered) flushList();
      if (!list) list = { ordered: wantOrdered, items: [] };
      for (const problem of linkProblemsIn(text)) {
        errors.push({ line: number, message: problem });
      }
      list.items.push(inlineToBBCode(text));
      continue;
    }

    const link = loneLink(trimmed);
    if (link) {
      flush();
      const problem = linkProblem(link.target);
      if (problem) {
        errors.push({ line: number, message: problem });
        continue;
      }
      blocks.push({
        type: 'link',
        text: inlineToBBCode(link.label) || link.target,
        href: link.target.trim(),
      });
      continue;
    }

    for (const problem of linkProblemsIn(trimmed)) {
      errors.push({ line: number, message: problem });
    }
    paragraph.push(trimmed);
  }

  flush();
  return { blocks, errors };
}

// -- blocks to source ---------------------------------------------------------

// One block, as the source writes it. A note is literal on the server - it is
// escaped rather than parsed - so its text is not converted.
//
// A paragraph that is nothing but a link is written as that link, and reads
// back as a link block. The two render the same - one paragraph holding one
// link - so nothing a reader sees changes; only the shape of the model does.
export function blockToSource(block) {
  if (!block || !block.type) return '';
  switch (block.type) {
    case 'heading':
      return (block.level === 1 ? '# ' : (block.level === 3 ? '### ' : '## '))
        + bbcodeToInline(block.text || '');
    case 'lead':
      return '! ' + bbcodeToInline(block.text || '');
    case 'paragraph':
      return bbcodeToInline(String(block.text || '').trim());
    case 'note':
      return (block.kind === 'warn' ? '~! ' : '~ ') + String(block.text || '');
    case 'list':
      return (block.items || []).map((item, index) => (
        (block.ordered ? (index + 1) + '. ' : '- ') + bbcodeToInline(item)
      )).join('\n');
    case 'link':
      return '[' + (block.text || block.href || '') + '](' + (block.href || '') + ')';
    case 'rule':
      return '---';
    case 'image': {
      const alt = escapeValue(block.alt || '', ENDS.alt);
      const src = escapeValue(block.src || '', ENDS.src);
      const width = block.width ? ' "width=' + Number(block.width) + '"' : '';
      return '![' + alt + '](' + src + ')' + width;
    }
    case 'quote': {
      const lines = String(block.text || '').split('\n').map((line) => {
        const text = escapeValue(bbcodeToInline(line));
        // A line that would be read as an attribution is escaped, so a
        // quotation may say anything at all.
        return '> ' + (text.startsWith('--') ? '\\' + text : text);
      });
      if (block.attribution) lines.push('> -- ' + escapeValue(block.attribution));
      return lines.join('\n');
    }
    case 'code': {
      const text = String(block.text || '');
      const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
      return fence + (block.language || '') + '\n' + text + '\n' + fence;
    }
    case 'table': {
      const headers = (block.headers || []).map((cell) => escapeValue(bbcodeToInline(String(cell)), ENDS.cell));
      const rows = (block.rows || []).map((row) => (row || []).map(
        (cell) => escapeValue(bbcodeToInline(String(cell)), ENDS.cell)));
      const lines = [
        '| ' + headers.join(' | ') + ' |',
        '| ' + headers.map(() => '---').join(' | ') + ' |',
      ];
      for (const row of rows) lines.push('| ' + row.join(' | ') + ' |');
      const caption = block.caption
        ? ': ' + escapeValue(bbcodeToInline(String(block.caption))) + '\n'
        : '';
      return caption + lines.join('\n');
    }
    default:
      return '';
  }
}

export function blocksToSource(blocks) {
  return (blocks || [])
    .map((block) => blockToSource(block))
    .filter((text) => text !== '')
    .join('\n\n');
}

// -- validation ---------------------------------------------------------------

// What the server would refuse, said the way the server says it. The editor
// runs this before it sends anything, so a mistake is caught while it is
// being made rather than after a round trip.
export function blockErrors(blocks) {
  const errors = [];
  const list = blocks || [];
  if (list.length > LIMITS.blocks) {
    errors.push({ index: -1, message: 'a page may have at most ' + LIMITS.blocks + ' blocks' });
  }
  list.forEach((block, index) => {
    let message = '';
    const text = String((block && block.text) || '');
    // A link written inside a line is checked too: the server would refuse
    // the target, so the editor says so rather than storing it.
    const inlineProblem = linkProblemsIn(text).shift();
    switch (block && block.type) {
      case 'heading':
        if (!text.trim()) message = 'a heading needs text';
        else if (text.length > LIMITS.heading) message = 'a heading may be at most ' + LIMITS.heading + ' characters';
        else if (inlineProblem) message = inlineProblem;
        break;
      case 'lead':
        if (!text.trim()) message = 'a standfirst needs text';
        else if (text.length > LIMITS.lead) message = 'a standfirst may be at most ' + LIMITS.lead + ' characters';
        else if (inlineProblem) message = inlineProblem;
        break;
      case 'paragraph':
        if (!text.trim()) message = 'a paragraph needs text';
        else if (text.length > LIMITS.text) message = 'a paragraph may be at most ' + LIMITS.text + ' characters';
        else if (inlineProblem) message = inlineProblem;
        break;
      case 'note':
        if (!text.trim()) message = 'a note needs text';
        else if (text.length > LIMITS.text) message = 'a note may be at most ' + LIMITS.text + ' characters';
        break;
      case 'list': {
        const items = block.items || [];
        if (!items.length) message = 'a list needs at least one item';
        else if (items.length > LIMITS.items) message = 'a list may have at most ' + LIMITS.items + ' items';
        else if (items.some((item) => String(item).length > LIMITS.item)) {
          message = 'a list item may be at most ' + LIMITS.item + ' characters';
        } else if (items.some((item) => !String(item).trim())) {
          message = 'a list item cannot be blank';
        } else {
          const problem = items.map((item) => linkProblemsIn(String(item)).shift()).find(Boolean);
          if (problem) message = problem;
        }
        break;
      }
      case 'link': {
        const problem = linkProblem(block.href);
        if (problem) message = problem;
        else if (text.length > LIMITS.link) message = 'a link label may be at most ' + LIMITS.link + ' characters';
        break;
      }
      case 'rule':
        break;
      case 'image': {
        const alt = String((block && block.alt) || '');
        const src = String((block && block.src) || '');
        if (alt.length > LIMITS.imageAlt) {
          message = 'an image alt text may be at most ' + LIMITS.imageAlt + ' characters';
        } else if (!alt.trim()) {
          message = 'an image needs alt text';
        } else if (src.trim().length > LIMITS.imageSrc) {
          message = 'an image source may be at most ' + LIMITS.imageSrc + ' characters';
        } else {
          const problem = imageProblem(src);
          if (problem) message = problem;
          else if (block.width != null && block.width !== '') {
            const width = Number(block.width);
            if (!Number.isInteger(width) || width < 1 || width > LIMITS.imageWidth) {
              message = 'an image width must be a whole number between 1 and ' + LIMITS.imageWidth;
            }
          }
        }
        break;
      }
      case 'quote': {
        const attribution = String((block && block.attribution) || '');
        if (text.length > LIMITS.quote) {
          message = 'a quotation may be at most ' + LIMITS.quote + ' characters';
        } else if (!text.trim()) {
          message = 'a quotation needs text';
        } else if (attribution.length > LIMITS.attribution) {
          message = 'an attribution may be at most ' + LIMITS.attribution + ' characters';
        }
        break;
      }
      case 'code': {
        if (text.length > LIMITS.code) {
          message = 'a code block may be at most ' + LIMITS.code + ' characters';
        } else if (!text.trim()) {
          message = 'a code block needs text';
        } else {
          const problem = languageProblem(block.language);
          if (problem) message = problem;
        }
        break;
      }
      case 'table': {
        const headers = Array.isArray(block.headers) ? block.headers : [];
        const rows = Array.isArray(block.rows) ? block.rows : [];
        const caption = String((block && block.caption) || '');
        if (!headers.length) message = 'a table needs at least one column';
        else if (headers.length > LIMITS.columns) {
          message = 'a table may have at most ' + LIMITS.columns + ' columns';
        } else if (headers.some((cell) => String(cell).length > LIMITS.cell)) {
          message = 'a table heading may be at most ' + LIMITS.cell + ' characters';
        } else if (headers.some((cell) => !String(cell).trim())) {
          message = 'a table heading cannot be blank';
        } else if (!rows.length) message = 'a table needs at least one row';
        else if (rows.length > LIMITS.rows) {
          message = 'a table may have at most ' + LIMITS.rows + ' rows';
        } else if (rows.some((row) => !Array.isArray(row))) {
          message = 'every table row must be a list of cells';
        } else if (rows.some((row) => row.length !== headers.length)) {
          message = 'every table row must have the same number of cells as the table has columns';
        } else if (rows.some((row) => row.some((cell) => String(cell).length > LIMITS.cell))) {
          message = 'a table cell may be at most ' + LIMITS.cell + ' characters';
        } else if (caption.length > LIMITS.caption) {
          message = 'a table caption may be at most ' + LIMITS.caption + ' characters';
        }
        break;
      }
      default:
        message = 'unknown block type: ' + ((block && block.type) || '(missing)');
    }
    if (message) errors.push({ index, message });
  });
  return errors;
}

export default {
  LIMITS, linkProblem, imageProblem, languageProblem,
  inlineToBBCode, bbcodeToInline,
  sourceToBlocks, blocksToSource, blockToSource, blockErrors,
};

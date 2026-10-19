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
//   ## heading            a heading, level two
//   ### heading           a heading, level three
//   ! standfirst          the lead under the title
//   > quotation           a quotation
//   ~ note                a note
//   ~! note               a warning note
//   - item                an unordered list
//   1. item               an ordered list
//   [label](target)       a link
//   ---                   a rule
//   anything else         a paragraph
//
// Inline formatting travels as BBCode, because that is what the server
// renders. The source writes the shorthand people already type - **bold**,
// *italic*, `code`, [text](url) - and reads it back. A construct the server
// cannot store (an image, a table) is refused here with the line it is on,
// rather than being sent and coming back as a validation error.

export const LIMITS = {
  blocks: 400,
  text: 8000,
  heading: 200,
  lead: 600,
  link: 200,
  items: 60,
  item: 500,
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

// -- source to blocks ---------------------------------------------------------

const HEADING = /^(#{2,3})\s+(.*)$/;
const LEAD = /^!\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const NOTE_WARN = /^~!\s?(.*)$/;
const NOTE = /^~\s?(.*)$/;
const RULE = /^-{3,}\s*$/;
const BULLET = /^[-*]\s+(.*)$/;
const ORDERED = /^\d+[.)]\s+(.*)$/;
const IMAGE = /^!\[([^\]]*)\]\(([^)]*)\)\s*$/;
const TABLE_ROW = /^\|.*$/;
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

// The blocks a source text describes, and what is wrong with the text that
// does not describe blocks. The errors carry the line they are on, because a
// page is written in lines and an error without one is a hunt.
export function sourceToBlocks(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const blocks = [];
  const errors = [];
  let paragraph = [];
  let list = null;

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

  function flush() {
    flushParagraph();
    flushList();
  }

  lines.forEach((line, index) => {
    const number = index + 1;
    const trimmed = line.trim();
    if (!trimmed) { flush(); return; }

    const image = IMAGE.exec(trimmed);
    if (image) {
      flush();
      errors.push({ line: number, message: 'a page cannot hold an image; link to it instead' });
      return;
    }
    if (TABLE_ROW.test(trimmed)) {
      flush();
      errors.push({ line: number, message: 'a page cannot hold a table' });
      return;
    }
    if (/^#/.test(trimmed) && !HEADING.test(trimmed)) {
      flush();
      errors.push({ line: number, message: 'a heading is written with two or three #' });
      return;
    }

    const heading = HEADING.exec(trimmed);
    if (heading) {
      flush();
      const text = heading[2].trim();
      if (!text) {
        errors.push({ line: number, message: 'a heading needs text' });
        return;
      }
      blocks.push({ type: 'heading', level: heading[1].length === 3 ? 3 : 2, text: inlineToBBCode(text) });
      return;
    }

    const lead = LEAD.exec(trimmed);
    if (lead) {
      flush();
      const text = lead[1].trim();
      if (!text) {
        errors.push({ line: number, message: 'a standfirst needs text' });
        return;
      }
      blocks.push({ type: 'lead', text: inlineToBBCode(text) });
      return;
    }

    const quote = QUOTE.exec(trimmed);
    if (quote) {
      flush();
      const text = quote[1].trim();
      if (!text) {
        errors.push({ line: number, message: 'a quotation needs text' });
        return;
      }
      blocks.push({ type: 'paragraph', text: '[quote]' + text + '[/quote]' });
      return;
    }

    const warn = NOTE_WARN.exec(trimmed);
    const note = warn || NOTE.exec(trimmed);
    if (note) {
      flush();
      const text = (warn ? warn[1] : note[1]).trim();
      if (!text) {
        errors.push({ line: number, message: 'a note needs text' });
        return;
      }
      blocks.push({ type: 'note', kind: warn ? 'warn' : 'info', text });
      return;
    }

    if (RULE.test(trimmed)) {
      flush();
      blocks.push({ type: 'rule' });
      return;
    }

    const bullet = BULLET.exec(trimmed);
    const ordered = bullet ? null : ORDERED.exec(trimmed);
    if (bullet || ordered) {
      flushParagraph();
      const text = (bullet ? bullet[1] : ordered[1]).trim();
      const wantOrdered = !bullet;
      if (list && list.ordered !== wantOrdered) flushList();
      if (!list) list = { ordered: wantOrdered, items: [] };
      for (const problem of linkProblemsIn(text)) {
        errors.push({ line: number, message: problem });
      }
      list.items.push(inlineToBBCode(text));
      return;
    }

    const link = loneLink(trimmed);
    if (link) {
      flush();
      const problem = linkProblem(link.target);
      if (problem) {
        errors.push({ line: number, message: problem });
        return;
      }
      blocks.push({
        type: 'link',
        text: inlineToBBCode(link.label) || link.target,
        href: link.target.trim(),
      });
      return;
    }

    for (const problem of linkProblemsIn(trimmed)) {
      errors.push({ line: number, message: problem });
    }
    paragraph.push(trimmed);
  });

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
      return (block.level === 3 ? '### ' : '## ') + bbcodeToInline(block.text || '');
    case 'lead':
      return '! ' + bbcodeToInline(block.text || '');
    case 'paragraph': {
      const raw = String(block.text || '').trim();
      const quoted = /^\[quote\]([\s\S]*)\[\/quote\]$/.exec(raw);
      if (quoted) return '> ' + quoted[1];
      return bbcodeToInline(raw);
    }
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
      default:
        message = 'unknown block type: ' + ((block && block.type) || '(missing)');
    }
    if (message) errors.push({ index, message });
  });
  return errors;
}

export default {
  LIMITS, linkProblem, inlineToBBCode, bbcodeToInline,
  sourceToBlocks, blocksToSource, blockToSource, blockErrors,
};

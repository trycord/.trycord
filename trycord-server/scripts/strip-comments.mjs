// Strips comments and string bodies from JavaScript source, keeping offsets roughly
// intact so line numbers still point somewhere useful.
//
// This exists because a regex cannot do it. Two attempts failed on this codebase
// before this one worked:
//
//   src.replace(/\/\*[\s\S]*?\*\//g) ate 84% of pages/registry.js, because a '/' in
//     a regex literal reads as the start of a comment.
//
//   Stripping '//...' to end of line ate the same file again, for the same reason.
//
// And the one that got furthest: /account/* appears in prose in registry.js - it is
// the legacy settings prefix - so the block-comment form opened a comment on line 30
// and closed it on line 349, taking every declaration in between with it. A check
// meant to catch missing imports was reporting missing imports that were present.
//
// Twenty lines of character-by-character scanning is cheaper than debugging that
// twice more.
//
// It still had one hole, which took out the two checks that depend on it. A regex
// literal was read as code, so the quotes inside one opened a string that ran until
// the next quote somewhere further down:
//
//   const re = /\bhttps?:\/\/[^\s<>"']+/gi;      (src/services/embeds.js:35)
//
// The `"` in that character class started a string, which blanked 130 lines including
// the function definition three lines below the one that opened it. So the scanner now
// recognises regex literals, which means deciding whether a `/` divides or begins one.
// The rule used is the usual one: a `/` begins a regex where an operand cannot already
// have ended - after an opening bracket, a comma, an operator, or the start of input.
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;

  // The last non-whitespace character emitted, which is what makes the regex/division
  // decision. Reset by nothing: comments and strings both leave code position intact.
  let prev = '';

  const startsOperand = (last) =>
    last === '' || '(,=:[!&|?{};+-*%~^<>'.includes(last);

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && next === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    // A regex literal, blanked like a string so its quotes cannot open one. A '/'
    // inside a character class is literal, which is why [ ... ] is tracked.
    if (c === '/' && startsOperand(prev)) {
      let inClass = false;
      out += ' ';
      i++;
      while (i < n) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === '\n') break;          // an unterminated regex, not a regex
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { out += ' '; i++; break; }
        out += ' ';
        i++;
      }
      // Flags after the closing slash are kept - they are short and harmless.
      while (i < n && /[a-z]/.test(src[i])) { out += src[i]; i++; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += ' ';
      i++;
      while (i < n && src[i] !== quote) {
        // A backslash escape, and for a template literal a ${...} hole whose code
        // has to survive - otherwise `${Api.get('/x')}` loses the Api.
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          let depth = 1;
          out += '  ';
          i += 2;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            out += src[i];
            i++;
          }
          continue;
        }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += ' ';
      i++;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    out += c;
    i++;
  }
  return out;
}

export default { stripComments };

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
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;

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
    out += c;
    i++;
  }
  return out;
}

export default { stripComments };

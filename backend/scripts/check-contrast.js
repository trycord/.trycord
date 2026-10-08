#!/usr/bin/env node
'use strict';

// Contrast in the default theme.
//
// Accessibility is a product feature, not a checklist, and contrast is the part of it
// that can be measured exactly rather than judged by eye. Every colour the interface
// draws text with is a token in css/app.css, so the ratios are computable and the only
// reason nobody had computed them is that nobody wrote the four lines that do it.
//
// WCAG 2.1 AA: 4.5:1 for body text, 3:1 for large text (18.66px bold or 24px regular)
// and for the non-text parts of a control - a button border, a focus ring, a divider
// that carries meaning.
//
// What this cannot do is know which token is drawn on which surface in every rule. It
// checks the pairs the design intends: text on the surfaces it sits on, accent ink on
// accent, and the muted and dim ends of the text scale against the darkest and lightest
// surfaces behind them. A hardcoded colour in a component rule is invisible to it, which
// is why there is a second check below for exactly that.

const fs = require('fs');
const path = require('path');

const CSS = path.join(__dirname, '..', '..', 'frontend', 'css', 'app.css');
const source = fs.readFileSync(CSS, 'utf8');

/**
 * Every theme's tokens.
 *
 * Reading only :root checked one of the eight themes a reader can pick. Each one has its
 * own muted colour, and one of them had the same value that fails, which a check of :root
 * alone would never have seen.
 */
function themes() {
  const blocks = new Map();
  // :root first, so it is the default theme's starting point; later blocks override it.
  let current = null;
  source.split('\n').forEach((line, i) => {
    // Both quote styles. It only accepted data-theme='light', so a theme written
    // data-theme="light" was never read - and a theme the check cannot see is a theme
    // nobody has verified the contrast of.
    const sel = line.match(/^:root(?:\[data-theme=["']([a-z-]+)["']\])?\s*\{/);
    if (sel) {
      current = sel[1] || 'trycord';
      if (!blocks.has(current)) blocks.set(current, {});
    } else if (current) {
      // The semantic names, not the retired --t-* ones. A check that reads names the design
      // system no longer uses reports nothing at all, which is what happened when the
      // palette was rebuilt: it failed on nineteen tokens that had not existed for a while.
      const m = line.match(/^\s*(--color-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/);
      if (m) blocks.get(current)[m[1]] = normalise(m[2]);
      if (line.trim() === '}') current = null;
    }
  });
  // The default theme's :root is inherited by the ones that only override some tokens.
  const root = blocks.get('trycord') || {};
  for (const [name, own] of blocks) {
    blocks.set(name, Object.assign({}, root, own));
  }
  return blocks;
}

function normalise(hex) {
  let h = hex;
  if (h.length === 4) h = '#' + h.slice(1).split('').map((c) => c + c).join('');
  if (h.length === 7) h += 'ff';
  return h;
}

/** The value of a custom property in one theme. */
function token(name, inTheme) {
  const table = inTheme || themes().get('trycord');
  const v = table[name];
  if (!v) return null;
  return v;
}

function channels(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return v.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
}

function luminance(hex) {
  const [r, g, b] = channels(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

let passed = 0;
const failures = [];
function ok(label, value, minimum, detail) {
  const numeric = typeof value === 'number';
  const good = numeric ? value >= minimum : !!value;
  // The detail belongs to a boolean assertion too. Dropping it made a failure that
  // cannot explain itself, which is the worst kind.
  const line = numeric
    ? label + ': ' + value.toFixed(2) + ':1 against ' + minimum + ':1'
    : label + (detail ? '  <- ' + detail : '');
  if (good) {
    passed++;
    console.log('    ok   ' + line);
  } else {
    failures.push(line);
    console.log('    FAIL ' + line + (numeric ? ' - short by ' + (minimum - value).toFixed(2) : ''));
  }
}

console.log('\n  contrast in the default theme');

// The pairs the design intends, and the surface each is actually drawn on.
const TEXT_ON = [
  ['--color-text-primary', '--color-background', 4.5, 'primary text on the page'],
  ['--color-text-primary', '--color-surface', 4.5, 'primary text in the workspace'],
  ['--color-text-primary', '--color-surface-sunken', 4.5, 'primary text in a rail or sidebar'],
  ['--color-text-primary', '--color-surface-elevated', 4.5, 'primary text on a raised card'],
  ['--color-text-secondary', '--color-surface', 4.5, 'secondary text in the workspace'],
  ['--color-text-secondary', '--color-surface-sunken', 4.5, 'secondary text in a rail or sidebar'],
  ['--color-text-secondary', '--color-surface-elevated', 4.5, 'secondary text on a raised card'],
  ['--color-text-muted', '--color-surface', 4.5, 'muted text in the workspace'],
  ['--color-text-muted', '--color-surface-sunken', 4.5, 'muted text in a rail or sidebar'],
  ['--color-text-muted', '--color-surface-elevated', 4.5, 'muted text on a raised card'],
  // Muted is not a disabled colour. Dozens of rules use it for text that is meant to
  // be read - timestamps, counts, "edited", hints, empty states - and it sat at 2.33:1
  // on a raised card, which is where a message timestamp actually lives. The token-level
  // check could not see this: it never looked at muted at all, because the colour check
  // and the layout check were separate worlds and the bug was in the space between them.
  ['--color-accent', '--color-surface', 4.5, 'accent text in the workspace'],
  ['--color-accent', '--color-surface-sunken', 4.5, 'accent text in a rail or sidebar'],
  ['--color-accent', '--color-surface-elevated', 4.5, 'accent text on a raised card'],
];

const allThemes = themes();
console.log(`    ${allThemes.size} themes found: ${[...allThemes.keys()].join(', ')}`);

for (const [name, table] of allThemes) {
  for (const [fg, bg, min, what] of TEXT_ON) {
    const a = table[fg];
    const b = table[bg];
    if (!a || !b) {
      failures.push(name + ' ' + what + ': could not read ' + (!a ? fg : bg));
      console.log('    FAIL ' + name + ' ' + what + ': could not read ' + (!a ? fg : bg));
      continue;
    }
    ok(name + ' - ' + what, ratio(a, b), min);
  }
}

// Muted is the floor for anything unread, and it says so. It is allowed to be less
// than body-text minimum because it is only ever used for genuinely disabled things -
// but it still has to be legible enough to recognise.
const dim = token('--color-text-muted');
if (dim) ok('muted text is at least recognisable', ratio(dim, token('--color-surface')), 2.0);
else failures.push('--color-text-muted not found');

// Accent ink on accent is the whole button, and a primary button that fails contrast is
// the most visible failure a theme can have.
const accent = token('--color-accent');
const ink = token('--color-on-accent');
if (accent && ink) {
  ok('text on a primary button', ratio(ink, accent), 4.5);
  ok('the accent itself against the workspace', ratio(accent, token('--color-surface')), 3.0);
  ok('the accent itself against the page', ratio(accent, token('--color-background')), 3.0);
} else {
  failures.push('accent tokens not found');
}

// Status colours carry meaning on their own - a red dot has to read as red - so they are
// held to the non-text 3:1 rather than to body text.
for (const [name, what] of [['--color-success', 'the success colour'],
  ['--color-warning', 'the warning colour'], ['--color-danger', 'the danger colour']]) {
  const c = token(name);
  if (c) ok(what + ' is distinguishable from the workspace', ratio(c, token('--color-surface')), 3.0);
  else failures.push(name + ' not found');
}

// A border that separates two things has to be visible enough to do it.
const line = token('--color-border');
const lineHi = token('--color-border-strong');
if (line && lineHi) {
  ok('the strongest border against a surface', ratio(lineHi, token('--color-surface')), 1.5);
} else {
  failures.push('border tokens not found');
}

console.log('\n  colours hardcoded outside the token block');

// A literal colour in a component rule is a colour the theme cannot change, and one this
// check cannot see when it later comes to deciding whether that text is readable.
//
// Comments are stripped first, because a comment explaining why a particular hex was
// chosen is documentation and not a violation - there are several in this file, and a
// version of this check that flagged them would have been deleted rather than fixed.
// The token blocks are skipped for the same reason: that is where colours are meant to
// be written.
const { stripComments } = require('./strip-comments.mjs');
const bare = stripComments(source);
const sourceLines = source.split('\n');

// The blocks that define tokens, by their selector. Everything else is a component rule.
const tokenBlocks = new Set();
{
  const re = /^:root(?:\[[^\]]*\])?\s*\{/gm;
  let m;
  while ((m = re.exec(bare)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < bare.length; i++) {
      if (bare[i] === '{') depth++;
      else if (bare[i] === '}') { depth--; if (depth === 0) { tokenBlocks.add(m.index + '..' + i); break; } }
    }
    re.lastIndex = i + 1;
  }
}

const literals = [];
{
  let offset = 0;
  for (const line of bare.split('\n')) {
    const start = offset;
    offset += line.length + 1;
    const inTokens = [...tokenBlocks].some((r) => {
      const [a, b] = r.split('..').map(Number);
      return start >= a && start <= b;
    });
    const n = bare.slice(0, start).split('\n').length;
    if (inTokens) continue;
    // A rule may say why a literal is correct. The marker is honoured on the same line
    // or the one above, so the reason sits next to the thing it explains.
    // Scoped to the enclosing rule, not to a window of lines. A window is a guess about
    // how far a comment might be from the thing it explains, and it kept missing by a
    // line or two and turning into whack-a-mole. The rule is bounded by braces, so the
    // rule is what gets searched - in the original source, since the marker is a comment
    // and comments were stripped above.
    if (ruleExempt(n)) continue;

    // A literal inside text-shadow() or box-shadow() is a shadow, not a colour anything
    // is drawn in. The theme has shadow tokens for the ones that matter; demanding every
    // shadow blur be a token is the kind of consistency that costs more than it returns.
    const asShadow = (line.match(/[a-z-]*shadow\(/gi) || []).length > 0
      && line.replace(/[a-z-]*shadow\([^)]*\)/gi, '').indexOf('#') === -1
      && line.replace(/[a-z-]*shadow\([^)]*\)/gi, '').search(/#[0-9a-fA-F]{3,8}/) === -1;
    if (asShadow) continue;
    const hex = line.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    const rgb = line.match(/\brgba?\(/g) || [];
    const named = line.match(/(?<![-\w])(?:white|black|red|blue|green|yellow|orange|purple)(?![-\w])/gi) || [];
    if (hex.length || rgb.length || named.length) {
      literals.push('app.css:' + n + '  ' + line.trim().slice(0, 76));
    }
  }
}
ok('no colour is written into a component rule', literals.length === 0, 0,
  literals.slice(0, 6).join(' | ') || literals.length + ' literal colour(s)');

console.log(`\n  contrast check ${failures.length ? 'FAILED - ' + failures.length + ' problem(s)' : 'passed'}`
  + ` - ${passed} assertions\n`);
process.exit(failures.length ? 1 : 0);

/**
 * Whether the rule containing line n carries a colour-exempt marker.
 *
 * Walks back to the line that opens the rule and forward to the brace that closes it,
 * then looks inside. CSS nesting makes "the enclosing rule" slightly ambiguous, so it
 * takes the outermost block that is still open at that point - which is the selector the
 * declaration belongs to, however many rules are nested inside it.
 */
function ruleExempt(n) {
  const from = Math.max(0, n - 1);
  const upto = Math.min(sourceLines.length, n + 30);
  // A one-line rule - selector, body and all on one line - is its own rule, and walking
  // back from it starts balanced, because the line contains both its opening and its
  // closing brace. Scanning up from a balanced line wanders into whatever came before.
  if (sourceLines[from].includes('{')) return sourceLines[from].includes('colour-exempt');

  let depth = 0;
  let start = from;
  for (let i = from; i >= Math.max(0, from - 40); i--) {
    const line = sourceLines[i];
    depth += (line.match(/\}/g) || []).length;
    depth -= (line.match(/\{/g) || []).length;
    if (depth < 0) { start = i + 1; break; }
  }
  if (start === from) return false;
  // Forward to the close of whatever block is now open.
  // The scan starts inside the rule, so the first few lines have no braces at all. Ending
  // on "no braces here" therefore closed the scan one line in, before reaching the comment
  // at the end of the rule - which is where every one of these markers is. It has to wait
  // for a brace to open before a brace can close it.
  let open = 0;
  let seenOpen = false;
  let end = upto;
  for (let i = start; i < sourceLines.length; i++) {
    const line = sourceLines[i];
    open += (line.match(/\{/g) || []).length;
    open -= (line.match(/\}/g) || []).length;
    if (open > 0) seenOpen = true;
    if (seenOpen && open === 0) { end = i + 1; break; }
  }
  return sourceLines.slice(start, end).join('\n').includes('colour-exempt');
}


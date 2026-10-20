// Accessibility, checked rather than asserted.
//
// The client is plain ES modules that build their DOM with `el()`. That means
// an element's accessible name is decided at the call site, and a call site
// that forgets it produces a button a screen reader announces as nothing.
//
// This is a static audit of the source, and it is deliberately narrow: it
// looks for a control that cannot be named, and for a control that is not
// focusable because it is not a control at all.
//
// What it does not check, and cannot: the contrast of a colour, the size of a
// touch target, whether a focus ring is visible, and whether a screen reader
// makes sense of the result. Those need a browser and a person.

'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every client source file. */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'tests' || entry.name === 'assets') continue;
        walk(full);
      } else if (entry.name.endsWith('.js')) {
        out.push(full);
      }
    }
  };
  walk(FRONTEND);
  return out;
}

/**
 * The source with its comments blanked out.
 *
 * The audit reads the source as text, and a comment is not code: an
 * apostrophe in a comment - "the server's contract" - reads as the start of
 * a string, and every bracket after it is then counted against the wrong
 * state. The audit reported a button with no name that has a name, and
 * pointed at the wrong line, because of a word in a comment.
 *
 * The comment is replaced with spaces rather than removed, so the offsets
 * and the line numbers stay exactly what they were. A commented-out control
 * is not checked either, which is right: it is not rendered.
 */
function maskComments(source) {
  let out = '';
  let inString = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += source[i + 1] || ''; i += 1; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; out += ch; continue; }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i += 1; }
      out += '\n';
      i -= 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      out += '  ';
      i += 1;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * The text of a call, from its opening parenthesis to the one that closes it.
 */
function callAt(source, openIndex) {
  let depth = 0;
  let inString = null;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  return '';
}

/**
 * The children of an `el('button', { ... }, ...)` call - everything after the
 * attributes object.
 *
 * The attributes object is the second argument, so its matching brace is
 * found by counting. What follows is the content: the text, an icon, or both.
 */
function childrenOf(call) {
  const braceAt = call.indexOf('{');
  if (braceAt === -1) return '';
  let depth = 0;
  let inString = null;
  for (let i = braceAt; i < call.length; i++) {
    const ch = call[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return call.slice(i + 1, call.lastIndexOf(')'));
    }
  }
  return '';
}

/**
 * Whether a call names its control.
 *
 * A name can be: text inside the element, an `aria-label`, a `title`, or a
 * call to a helper that sets one. `iconButton` always sets an aria-label, so
 * a button built with it is named by construction.
 *
 * The interesting case is a control whose only content is an icon. It has
 * nothing to announce, so it has to carry a label of its own.
 */
function isNamed(call) {
  // The attribute names are quoted in the source, so the closing quote has to
  // be allowed between the name and the colon.
  if (/['"]?aria-label['"]?\s*[:=]/.test(call)) return true;
  if (/['"]?title['"]?\s*:/.test(call)) return true;
  if (/\biconButton\s*\(/.test(call)) return true;
  if (/\bsrOnly\s*\(/.test(call)) return true;
  if (/\bvisuallyHidden\s*\(/.test(call)) return true;

  const children = childrenOf(call).trim();
  if (!children) return false;

  // Only an icon: nothing to announce, so a label has to be there.
  if (/^icon\s*\(/.test(children) && !/,\s*[^)]/.test(children)) {
    // A single icon call and nothing else.
    const inner = children.replace(/^icon\s*\(/, '').replace(/\)\s*$/, '');
    if (!/,/.test(inner) && !/['"]/.test(inner.replace(/\{[^}]*\}/g, ''))) return false;
  }
  // Anything else in the content is a label: a string, a concatenation, a
  // variable that holds one, or a fallback.
  if (/['"]/.test(children)) return true;
  if (/[A-Za-z_$][\w.$]/.test(children)) return true;
  return false;
}

test('accessibility of the client', async (t) => {
  const files = sources();

  await t.test('every button and link can be named', () => {
    const problems = [];
    for (const file of files) {
      // The comments are blanked out first: the audit reads the source as
      // text, and an apostrophe in a comment is read as a string that never
      // ends. The line numbers are unaffected - a comment is replaced with
      // spaces, so every offset is the one it was.
      const source = maskComments(fs.readFileSync(file, 'utf8'));
      const re = /\bel\('(button|a)',\s*\{/g;
      let m;
      while ((m = re.exec(source)) !== null) {
        const call = callAt(source, source.indexOf('(', m.index));
        if (!isNamed(call)) {
          const line = source.slice(0, m.index).split('\n').length;
          problems.push(path.relative(FRONTEND, file) + ':' + line + ' — a ' + m[1] + ' with no name');
        }
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  await t.test('every icon-only button is built through the helper that names it', () => {
    // A control whose only content is an icon has nothing to announce, so it
    // has to carry a label of its own. The children are parsed rather than
    // pattern-matched, because a button whose first child is an icon may well
    // have text after it.
    const problems = [];
    for (const file of files) {
      // The comments are blanked out first: the audit reads the source as
      // text, and an apostrophe in a comment is read as a string that never
      // ends. The line numbers are unaffected - a comment is replaced with
      // spaces, so every offset is the one it was.
      const source = maskComments(fs.readFileSync(file, 'utf8'));
      const re = /el\('(button|a)',\s*\{/g;
      let m;
      while ((m = re.exec(source)) !== null) {
        const call = callAt(source, source.indexOf('(', m.index));
        const children = childrenOf(call).trim();
        if (!children) continue;
        // Only icon calls, and nothing else.
        const withoutIcons = children.replace(/icon\s*\([^)]*\)/g, '').replace(/[\s,]/g, '');
        if (withoutIcons) continue; // there is something other than an icon
        if (!children.includes('icon(')) continue; // there is no icon at all
        if (/aria-label['"]?\s*[:=]/.test(call) || /title['"]?\s*:/.test(call)) continue;
        if (/\biconButton\s*\(/.test(call)) continue;
        const line = source.slice(0, m.index).split('\n').length;
        problems.push(path.relative(FRONTEND, file) + ':' + line
          + ' — a ' + m[1] + ' with only an icon and no name');
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  await t.test('a click handler is on a control, not on a container', () => {
    // A div with a click handler is not focusable and is not announced as
    // interactive, so it cannot be reached with a keyboard. The exceptions
    // are the ones that carry the keyboard behaviour themselves.
    const problems = [];
    for (const file of files) {
      // The comments are blanked out first: the audit reads the source as
      // text, and an apostrophe in a comment is read as a string that never
      // ends. The line numbers are unaffected - a comment is replaced with
      // spaces, so every offset is the one it was.
      const source = maskComments(fs.readFileSync(file, 'utf8'));
      const re = /el\('(div|span|li|p|section|article)',\s*\{([^}]*)\}/g;
      let m;
      while ((m = re.exec(source)) !== null) {
        const attributes = m[2];
        const hasClick = /\bonClick\s*:/.test(attributes);
        if (!hasClick) continue;
        const carriesKeyboard = /\brole\s*:\s*'button'/.test(attributes)
          || /\btabIndex\s*:/.test(attributes);
        if (!carriesKeyboard) {
          const line = source.slice(0, m.index).split('\n').length;
          problems.push(path.relative(FRONTEND, file) + ':' + line
            + ' — a ' + m[1] + ' with a click handler and no keyboard role');
        }
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  await t.test('every dialog traps focus', () => {
    // The overlays own the focus while they are open. A dialog that does not
    // trap it lets a reader tab into the page behind it.
    const overlays = fs.readFileSync(path.join(FRONTEND, 'js', 'ui', 'overlays.js'), 'utf8');
    assert.ok(/trapFocus/.test(overlays), 'the overlay manager traps focus');
    const mobile = fs.readFileSync(path.join(FRONTEND, 'mobile', 'js', 'ui.js'), 'utf8');
    // The phone's sheet is a different implementation, and it has to do the
    // same thing by whatever means it uses.
    assert.ok(/trapFocus|focus\(|activeElement/.test(mobile),
      'the phone\'s sheet manages focus');
  });

  await t.test('the live region a reader needs is announced', () => {
    // The status line and the connection indicator are the two places the
    // client tells a reader something happened without moving the focus.
    const filesWithStatus = files.filter((f) => /statusLine|aria-live/.test(fs.readFileSync(f, 'utf8')));
    assert.ok(filesWithStatus.length > 0, 'the client has at least one live region');
  });

  await t.test('the stylesheet honours a reduced-motion preference', () => {
    const css = ['css/base.css', 'css/components.css', 'css/shell.css', 'css/features.css', 'css/entry.css']
      .map((f) => fs.readFileSync(path.join(FRONTEND, f), 'utf8'))
      .join('\n');
    assert.ok(/prefers-reduced-motion/.test(css),
      'the stylesheet has a reduced-motion rule');
  });

  await t.test('a visible focus ring is styled, not left to the browser', () => {
    const css = ['css/base.css', 'css/components.css', 'css/shell.css', 'css/features.css', 'css/entry.css']
      .map((f) => fs.readFileSync(path.join(FRONTEND, f), 'utf8'))
      .join('\n');
    assert.ok(/:focus-visible/.test(css), 'the stylesheet styles the focus ring');
  });
});

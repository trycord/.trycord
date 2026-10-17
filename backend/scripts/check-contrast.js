#!/usr/bin/env node
'use strict';

// Contrast against WCAG AA for every theme in the stylesheet.
//
// The default theme's values are var(--tc-*) references into the canonical library
// rather than hex literals, so the check resolves them: a theme that only ever held
// literals would now measure nothing at all and report a pass.

const fs = require('fs');
const path = require('path');

const CSS = path.join(__dirname, '..', '..', 'frontend', 'css');
const source = fs.readFileSync(path.join(CSS, 'app.css'), 'utf8');

const MIN_BODY = 4.5;
const MIN_LARGE = 3.0;

function blocks() {
  const out = new Map();
  let current = null;
  for (const line of source.split('\n')) {
    // The library spells its selectors three ways: a bare :root, :root joined by a
    // comma to [data-theme="dark"], and a bare [data-theme="light"]. Any of them opens
    // a block, so the theme name is taken from the data-theme attribute on the line
    // rather than requiring the line to start with :root - a check that cannot read a
    // theme reports nothing at all and looks like a pass.
    //
    // The library's [data-theme=dark] is the palette the application calls trycord, so
    // the two names are folded together: otherwise the tokens this file needs to
    // resolve would sit in a theme nothing measures.
    const opens = /^\s*(?::root|\[data-theme=)[^\n]*\{/.test(line);
    if (opens) {
      const named = line.match(/data-theme=["']([a-z-]+)["']/);
      current = named && named[1] === 'dark' ? 'trycord' : (named ? named[1] : 'trycord');
      if (!out.has(current)) out.set(current, {});
    } else if (current) {
      // The library writes more than one declaration per line, so a single match would
      // read the first and silently drop the rest - including the surface tokens this
      // check measures against.
      for (const m of line.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
        out.get(current)[m[1]] = m[2].trim();
      }
      if (line.trim() === '}') current = null;
    }
  }
  return out;
}

function normalise(hex) {
  let h = hex.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(h)) {
    h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  }
  if (/^#[0-9a-fA-F]{6}$/.test(h)) return h.toLowerCase();
  return null;
}

// Resolve a value to a hex literal, following var() chains.
//
// Three forms are in use: a bare hex, `var(--token)`, and `var(--token, fallback)`
// where the fallback is itself a token - the reader-authored palette arrives as
// inline --c-* properties over the canonical library value, and the semantic
// names fall back through them. A resolver that stopped at the first var() would
// report every custom-capable surface as unmeasurable, and a value nothing can
// read is a pair nothing has verified.
function resolve(name, theme, all, seen = new Set()) {
  if (!name || seen.has(name)) return null;
  seen.add(name);
  const raw = theme[name];
  if (raw === undefined) return null;
  return resolveValue(raw, theme, all, seen);
}

function resolveValue(raw, theme, all, seen) {
  const direct = normalise(raw);
  if (direct) return direct;
  const ref = varReference(raw);
  if (!ref) return null;
  return resolve(ref.name, theme, all, seen)
    || (ref.fallback !== null ? resolveValue(ref.fallback, theme, all, seen) : null)
    || resolve(ref.name, all.get('trycord') || {}, all, seen);
}

// `var(--name)` or `var(--name, fallback)` - enough parsing to keep the fallback
// whole, including a nested var(). The parens of the fallback are counted so a
// `var(--a, var(--b, #fff))` reads as one reference rather than a truncated one.
function varReference(raw) {
  const text = String(raw).trim();
  if (!text.startsWith('var(') || !text.endsWith(')')) return null;
  const inner = text.slice(4, -1);
  const name = /^\s*(--[a-z0-9-]+)\s*/.exec(inner);
  if (!name) return null;
  const rest = inner.slice(name[0].length);
  if (!rest) return { name: name[1], fallback: null };
  if (rest[0] !== ',') return null;
  let depth = 0;
  let fallback = '';
  for (const ch of rest.slice(1)) {
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) return null;
      depth--;
    }
    fallback += ch;
  }
  return { name: name[1], fallback: fallback.trim() || null };
}

function channels(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return v.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
}

function luminanceOf(hex) {
  const [r, g, b] = channels(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const la = luminanceOf(a);
  const lb = luminanceOf(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const all = blocks();
const root = all.get('trycord') || {};

// Inherit: a theme that overrides only some tokens takes the rest from the default.
for (const [name, own] of all) all.set(name, Object.assign({}, root, own));

let passed = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) { passed++; console.log('    ok   ' + label + (detail ? ': ' + detail : '')); }
  else { failures.push(label); console.log('    FAIL ' + label + (detail ? ': ' + detail : '')); }
}

const PAIRS = [
  ['--text-1', 'the workspace', '--app-bg', MIN_BODY],
  ['--text-2', 'the workspace', '--app-bg', MIN_BODY],
  ['--text-3', 'the workspace', '--app-bg', MIN_BODY],
  ['--text-1', 'a rail or sidebar', '--panel-2', MIN_BODY],
  ['--text-2', 'a rail or sidebar', '--panel-2', MIN_BODY],
  ['--text-3', 'in a rail or sidebar', '--panel-2', MIN_BODY],
  ['--text-1', 'a raised card', '--raised', MIN_BODY],
  ['--text-2', 'on a raised card', '--raised', MIN_BODY],
  ['--text-3', 'muted text on a raised card', '--raised', MIN_BODY],
  ['--brand', 'accent text in the workspace', '--app-bg', MIN_LARGE],
  ['--brand', 'the accent itself in a sidebar', '--panel-2', MIN_LARGE],
  ['--brand', 'the accent itself on a raised card', '--raised', MIN_LARGE],
];

for (const [themeName, theme] of all) {
  console.log('\n  ' + themeName);
  for (const [fg, what, bg, min] of PAIRS) {
    const fgHex = resolve(fg, theme, all);
    const bgHex = resolve(bg, theme, all);
    if (!fgHex || !bgHex) {
      // A theme missing a token is a finding, not a skip: nothing has verified the pair.
      ok(`${what}`, false, fg + ' or ' + bg + ' could not be resolved');
      continue;
    }
    const r = ratio(fgHex, bgHex);
    ok(`${what}`, r >= min, r.toFixed(2) + ':1 against ' + min + ':1');
  }
}

// Muted is the floor for anything unread: it still has to be legible enough to
// recognise, so 2:1 rather than body-text minimum.
const dim = resolve('--text-3', all.get('trycord') || {}, all);
if (dim) ok('muted text is at least recognisable', ratio(dim, resolve('--panel', all.get('trycord') || {}, all)), 2.0);
else failures.push('--text-3 could not be resolved');

console.log(`\n  ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('  failures:');
  for (const f of failures) console.log('    ' + f);
  process.exit(1);
}

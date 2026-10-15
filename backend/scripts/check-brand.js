#!/usr/bin/env node
'use strict';

// The brand, one source.
//
// `frontend/assets/trycord-assets/` is the canonical brand, token and icon set,
// and every surface the product ships is supposed to draw from it: the web
// client, the public website, the desktop launcher and the status dashboard.
// A surface that keeps its own palette, or its own copy of the monogram, drifts
// the first time the library changes and nobody notices, because a slightly
// different orange still looks like orange.
//
// This is the check that notices. It reads the library and asserts each surface
// against it, rather than restating the values here - a copy of the values in
// the check would drift the same way the copy in the surface did.
//
//   node scripts/check-brand.js

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const ASSETS = path.join(REPO, 'frontend', 'assets', 'trycord-assets');

let failures = 0;
const ok = (label, cond, detail) => {
  if (cond) { console.log('  ok   ' + label); }
  else { failures++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
};

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// Every custom property a declaration block provides.
function tokensFrom(css) {
  const out = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;{}]+)/gi;
  let m;
  while ((m = re.exec(css))) out[m[1]] = m[2].trim().replace(/\s+/g, ' ');
  return out;
}

// The token library's default (dark) theme: the properties declared under a
// `:root` selector. `[data-theme="light"]` is deliberately skipped, because the
// dark theme is what a surface with no theme of its own renders.
function defaultTokens(css) {
  const out = {};
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (m[1].indexOf(':root') === -1) continue;
    Object.assign(out, tokensFrom(m[2]));
  }
  return out;
}

// The first :root block of a stylesheet, as a name -> value map.
function rootTokens(css) {
  const m = /:root\s*\{([^}]*)\}/i.exec(css);
  return m ? tokensFrom(m[1]) : {};
}

const norm = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toLowerCase();

// The path data an SVG monogram is drawn with, so an inlined copy can be compared
// to the canonical file it was taken from.
function pathData(svg) {
  const out = [];
  const re = /\bd="([^"]+)"/g;
  let m;
  while ((m = re.exec(svg))) out.push(m[1].replace(/\s+/g, ' ').trim());
  return out;
}

const library = read(path.join(ASSETS, 'tokens', 'trycord.css'));
if (library === null) {
  console.log('  FAIL the trycord-assets token library is missing');
  process.exit(1);
}
const TOKENS = defaultTokens(library);
const SYMBOL = read(path.join(ASSETS, 'brand', 'trycord-symbol.svg'));
if (SYMBOL === null) {
  console.log('  FAIL the trycord-assets brand monogram is missing');
  process.exit(1);
}
const MONOGRAM = pathData(SYMBOL);

// ---- the web client --------------------------------------------------------
{
  const index = read(path.join(REPO, 'frontend', 'index.html')) || '';
  ok('the client links the canonical favicon, app icon and manifest',
    /assets\/trycord-assets\/app\/favicon\.svg/.test(index)
    && /assets\/trycord-assets\/app\/trycord-app-icon\.svg/.test(index)
    && /assets\/trycord-assets\/app\/site\.webmanifest/.test(index),
    'index.html points somewhere other than the asset library');

  const crash = read(path.join(REPO, 'frontend', 'packages', 'crash.js')) || '';
  ok('the crash screen draws its brand from the token library',
    crash.indexOf('var(--tc-brand') !== -1 && crash.indexOf('--tc-bg-deep') !== -1,
    'crash.js still names its own colours');

  const theme = read(path.join(REPO, 'frontend', 'packages', 'theme.js')) || '';
  ok('the custom-theme defaults come from the library',
    theme.indexOf("token('--tc-brand'") !== -1,
    'theme.js keeps a copy of the palette instead of reading the tokens');
}

// ---- the public website ----------------------------------------------------
{
  const canonicalFavicon = fs.readFileSync(path.join(ASSETS, 'app', 'favicon.svg'), 'utf8');
  ok('the public favicon is the canonical file, byte for byte',
    read(path.join(REPO, 'public', 'assets', 'favicon.svg')) === canonicalFavicon,
    'public/assets/favicon.svg has drifted from the library (run npm run css)');

  const canonicalIcon = fs.readFileSync(path.join(ASSETS, 'app', 'trycord-app-icon.svg'), 'utf8');
  ok('the public touch icon is the canonical file, byte for byte',
    read(path.join(REPO, 'public', 'assets', 'app-icon.svg')) === canonicalIcon,
    'public/assets/app-icon.svg has drifted from the library (run npm run css)');

  const pages = fs.readdirSync(path.join(REPO, 'public')).filter((f) => f.endsWith('.html'));
  const wrongIcon = pages.filter((f) => {
    const html = read(path.join(REPO, 'public', f)) || '';
    return !/rel="apple-touch-icon"\s+href="\/assets\/app-icon\.svg"/.test(html);
  });
  ok('every public page points its touch icon at the canonical app icon',
    wrongIcon.length === 0, wrongIcon.join(', '));
}

// ---- the desktop launcher --------------------------------------------------
{
  const root = rootTokens(read(path.join(REPO, 'trycord-desktop', 'launcher.css')) || '');
  const pairs = [
    ['--bg', '--tc-bg-deep'],
    ['--bg-2', '--tc-bg'],
    ['--surface', '--tc-surface'],
    ['--line', '--tc-border'],
    ['--text', '--tc-text'],
    ['--muted', '--tc-text-muted'],
    ['--ember', '--tc-brand'],
    ['--ember-2', '--tc-brand-hover'],
  ];
  const mismatched = pairs.filter(([local, token]) => norm(root[local]) !== norm(TOKENS[token]));
  ok('the launcher palette is the library palette',
    mismatched.length === 0,
    mismatched.map(([l, t]) => l + '=' + (root[l] || '?') + ' not ' + t).join(', '));

  ok('the launcher sets the brand typeface first',
    norm(root['--sans']).split(',')[0] === norm(TOKENS['--tc-font-sans']).split(',')[0],
    'the launcher names ' + (root['--sans'] || 'nothing') + ' first');

  const inlined = pathData(read(path.join(REPO, 'trycord-desktop', 'launcher.html')) || '');
  ok('the launcher mark is the canonical monogram',
    MONOGRAM.length > 0 && MONOGRAM.every((d) => inlined.indexOf(d) !== -1),
    'the inlined monogram does not match brand/trycord-symbol.svg');
}

// ---- the status dashboard --------------------------------------------------
{
  const src = read(path.join(REPO, 'backend', 'src', 'status-monitor', 'server.js')) || '';
  const brand = /--brand:\s*(#[0-9a-fA-F]{3,8})/.exec(src);
  ok('the dashboard brand is the library brand',
    !!(brand && norm(brand[1]) === norm(TOKENS['--tc-brand'])),
    'the dashboard names ' + (brand ? brand[1] : 'no brand colour'));

  ok('the dashboard sets the brand typeface first',
    /font:16px\/1\.5\s+"Manrope"/.test(src),
    'the dashboard does not use the brand typeface');

  const inlined = pathData(src);
  ok('the dashboard mark is the canonical monogram',
    MONOGRAM.length > 0 && MONOGRAM.every((d) => inlined.indexOf(d) !== -1),
    'the inlined monogram does not match brand/trycord-symbol.svg');
}

console.log(failures
  ? `\n  brand check FAILED - ${failures} surface(s) off the canonical set\n`
  : '\n  brand check passed - every surface draws from trycord-assets\n');
process.exit(failures ? 1 : 0);

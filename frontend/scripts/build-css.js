#!/usr/bin/env node
'use strict';

// Concatenate the CSS layers into the one stylesheet the document loads.
//
// Why a build step rather than @import: @import is serialized by specification. Seven
// imports means seven dependent round trips, which on a phone on a bad connection is the
// difference between the first paint and the second one - and a page that paints twice
// reads as a page that is not working. One <link> to one file has no such ordering.
//
// The output is committed. A self-hoster clones the repository and serves a working
// application without running a build, which is the only property that matters here.
//
//   node frontend/scripts/build-css.js
//   npm run css

const fs = require('fs');
const path = require('path');

const CSS = path.join(__dirname, '..', 'css');
// The canonical design-token library. Its file is the first layer of the build rather
// than a copy, so a value changed there reaches the application without anything being
// duplicated into frontend/css.
const ASSET_TOKENS = path.join(__dirname, '..', 'assets', 'trycord-assets', 'tokens', 'trycord.css');

// Order is the dependency order, not alphabetical: tokens before anything that
// reads them, primitives before the surfaces built from them, responsive last
// because a media query that loses to a later rule is a breakpoint that does nothing.
const LAYERS = [
  'tokens.css',
  'base.css',
  'components.css',
  'shell.css',
  'messages.css',
  'pages.css',
  'cfg.css',
  'voice.css',
  'features.css',
  'surfaces.css',
  'roles.css',
  'responsive.css',
];

const OUT = path.join(CSS, 'app.css');
// The token layer on its own, for everything that is not the application.
//
// The public website is the same product with the same brand, and it used to carry its
// own palette in public/css/site.css - a second set of warm-oranges that agreed with the
// application by coincidence rather than by construction. This file is the asset
// library's tokens plus the semantic mapping, generated from exactly the same two sources
// the application is built from, so a value changed in the library reaches both. One
// source, two consumers, no copy.
const TOKENS_OUT = path.join(CSS, 'design-tokens.css');

function build() {
  const header = [
    '/*',
    ' * The one stylesheet. Generated - edit the layers in frontend/css and run npm run css.',
    ' *',
    ' * The first layer is the canonical token library in assets/trycord-assets/tokens.',
    ' * Its values are not duplicated here: this layer is that file, unchanged, and the',
    ' * semantic names in tokens.css are mapped from it.',
    ' *',
    ' * Order is the dependency order, not alphabetical:',
    ' *   design-tokens (assets/trycord-assets/tokens/trycord.css)',
    ' *   ' + LAYERS.join('\n *   '),
    ' */',
    '',
  ].join('\n');

  const parts = [header];

  // The asset library's own file, first, so everything below it can read --tc-*.
  let tokenBody;
  try {
    tokenBody = fs.readFileSync(ASSET_TOKENS, 'utf8').trim();
  } catch {
    console.error('  missing design tokens: ' + ASSET_TOKENS);
    process.exitCode = 1;
    return null;
  }
  const tokenSource = fs.readFileSync(path.join(CSS, 'tokens.css'), 'utf8').trim();

  parts.push('/* ---- design-tokens (assets/trycord-assets/tokens/trycord.css) ' + '-'.repeat(8) + ' */');
  parts.push(tokenBody);
  parts.push('');

  for (const name of LAYERS) {
    const file = path.join(CSS, name);
    let body;
    try {
      body = fs.readFileSync(file, 'utf8').trim();
    } catch {
      console.error('  missing layer: ' + name);
      process.exitCode = 1;
      return null;
    }
    // Each layer opens with its own banner, which would read as a second header
    // once they are all one file. Keep the separator, drop the comment block.
    parts.push('/* ---- ' + name.replace(/\.css$/, '') + ' ' + '-'.repeat(Math.max(0, 62 - name.length)) + ' */');
    parts.push(body);
    parts.push('');
  }

  const css = parts.join('\n');
  const tokensOnly = [
    '/*',
    ' * The design tokens, on their own. Generated - run npm run css.',
    ' *',
    ' * The public website links this before its own stylesheet. It is the same asset',
    ' * library the application is built from, so the marketing pages and the product',
    ' * share one palette by construction rather than by coincidence.',
    ' */',
    '',
    tokenBody,
    '',
    '/* ---- semantic names (frontend/css/tokens.css) ' + '-'.repeat(22) + ' */',
    '',
    tokenSource,
    '',
  ].join('\n');

  // Both outputs, every run. The "up to date" branch below used to return before this,
  // which left the token file absent on a machine whose app.css was already current.
  const tokensExisted = fs.existsSync(TOKENS_OUT) ? fs.readFileSync(TOKENS_OUT, 'utf8') : null;
  if (tokensExisted !== tokensOnly) {
    fs.writeFileSync(TOKENS_OUT, tokensOnly);
    console.log('  tokens written: ' + TOKENS_OUT + ' (' + (tokensOnly.length / 1024).toFixed(1) + ' KB)');
  }

  const PUBLIC_TOKENS_OUT = path.join(__dirname, '..', '..', 'public', 'css', 'design-tokens.css');
  const publicExisted = fs.existsSync(PUBLIC_TOKENS_OUT) ? fs.readFileSync(PUBLIC_TOKENS_OUT, 'utf8') : null;
  if (publicExisted !== tokensOnly) {
    fs.writeFileSync(PUBLIC_TOKENS_OUT, tokensOnly);
    console.log('  tokens written: ' + PUBLIC_TOKENS_OUT + ' (' + (tokensOnly.length / 1024).toFixed(1) + ' KB)');
  }

  const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  if (existing === css) {
    console.log('  css up to date (' + LAYERS.length + ' layers)');
    return { changed: false, bytes: css.length };
  }
  fs.writeFileSync(OUT, css);
  console.log('  css written: ' + OUT);
  console.log('  layers: ' + LAYERS.length + ', ' + (css.length / 1024).toFixed(1) + ' KB');
  return { changed: true, bytes: css.length };
}

build();
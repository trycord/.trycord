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
  'features.css',
  'surfaces.css',
  'roles.css',
  'responsive.css',
];

const OUT = path.join(CSS, 'app.css');

function build() {
  const header = [
    '/*',
    ' * The one stylesheet. Generated - edit the layers in frontend/css and run npm run css.',
    ' *',
    ' * Order is the dependency order, not alphabetical:',
    ' *   ' + LAYERS.join('\n *   '),
    ' */',
    '',
  ].join('\n');

  const parts = [header];
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
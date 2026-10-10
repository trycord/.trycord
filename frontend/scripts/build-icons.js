#!/usr/bin/env node
'use strict';

// Generate the icon path table from the canonical icon library.
//
// The library is SVG files on disk. The app needs path data inline, because icon() is
// synchronous and called from a hundred places with no bundler in front of it. Copying the
// paths by hand is how a copy drifts from its source, so this reads the library instead.
//
// The app's icon names differ from the library's filenames, so the mapping between them
// lives here rather than being scattered through the UI.
//
//   node frontend/scripts/build-icons.js

const fs = require('fs');
const path = require('path');

const ICONS = path.join(__dirname, '..', 'assets', 'trycord-assets', 'icons');
const OUT = path.join(__dirname, '..', 'js', 'icon-paths.js');

// The app's icon name -> the library file it comes from.
const MAP = {
  bell: 'bell',
  check: 'check',
  close: 'close',
  download: 'download',
  globe: 'globe',
  hash: 'hash',
  link: 'link',
  more: 'more-horizontal',
  paperclip: 'paperclip',
  pin: 'pin',
  plus: 'plus',
  reply: 'reply',
  search: 'search',
  settings: 'settings',
  'shield-alert': 'shield-alert',
  'shield-check': 'shield-check',
  smile: 'smile',
  upload: 'upload',
  users: 'users',
  'external-link': 'external-link',
  'file-text': 'file-text',
  calendar: 'calendar',
  'at-sign': 'at-sign',
  'messages-square': 'messages-square',
  server: 'server',
};

// Icons the library does not carry. The app draws these from its own path table in
// ui/dom.js. This is the documented gap, not a silently competing icon set.
const UNMAPPED = ['bell-off', 'chevron', 'flag', 'gear', 'home', 'image', 'layers',
  'logout', 'mail', 'menu', 'mute', 'pencil', 'star'];

function build() {
  const out = {};
  const missing = [];

  for (const [appName, file] of Object.entries(MAP)) {
    const file2 = path.join(ICONS, 'ui', file + '.svg');
    if (!fs.existsSync(file2)) {
      missing.push(file);
      continue;
    }

    // Pull the drawn geometry out. The library's SVGs carry a <title>, which is not
    // geometry and must not reach the document.
    const svg = fs.readFileSync(file2, 'utf8');
    const inner = svg
      .replace(/<svg[^>]*>/, '')
      .replace(/<\/svg>\s*$/, '')
      .replace(/<title>[\s\S]*?<\/title>/g, '')
      .trim();
    out[appName] = inner;
  }

  if (missing.length) {
    console.error('  missing library icons: ' + missing.join(', '));
    process.exitCode = 1;
    return;
  }

  const body = [
    '// Icon paths, generated from assets/trycord-assets/icons by',
    '// frontend/scripts/build-icons.js. Change the library, not this file.',
    '//',
    "// ui/dom.js still holds the icons the library does not carry ("
    + UNMAPPED.join(', ') + ').',
    '',
    'export const LIBRARY_ICONS = ' + JSON.stringify(out, null, 2) + ';',
    '',
    'export default LIBRARY_ICONS;',
    '',
  ].join('\n');

  fs.writeFileSync(OUT, body);
  console.log('  icons written: ' + OUT);
  console.log('  ' + Object.keys(out).length + ' from the library, '
    + UNMAPPED.length + ' drawn inline (the library has no equivalent)');
}

build();

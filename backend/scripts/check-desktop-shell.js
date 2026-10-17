#!/usr/bin/env node
'use strict';

// The desktop shell, and the rules it has to keep.
//
// The desktop frontend lives at frontend/js/shell.js, composed of the modules
// under frontend/js/shell/, and styled by frontend/css/shell.css. The shell is
// the one surface every page renders inside, so its checks are about contracts
// rather than appearance:
//
//   - the region API other modules import by name is exported, complete;
//   - the brand mark comes from the canonical brand module;
//   - the layout regions exist as named grid areas, so the CSS and the DOM
//     cannot drift apart;
//   - the shell's colours all resolve through the token layer (no raw hex,
//     no ad-hoc rgba), and its measurements through the metric tokens;
//   - the built stylesheet loads the token library and the semantic layer
//     before the shell that consumes them.

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');

let failures = 0;
const ok = (label, cond, detail) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail && !cond ? '  <- ' + detail : ''}`);
  if (!cond) failures++;
};

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

const shellJs = read(path.join(REPO, 'frontend', 'js', 'shell.js')) || '';
const shellCss = read(path.join(REPO, 'frontend', 'css', 'shell.css')) || '';
const frameJs = read(path.join(REPO, 'frontend', 'js', 'shell', 'frame.js')) || '';
const tokensCss = read(path.join(REPO, 'frontend', 'css', 'tokens.css')) || '';
const buildJs = read(path.join(REPO, 'frontend', 'scripts', 'build-css.js')) || '';

ok('the desktop shell entry point exists and is composed of modules',
  shellJs.length > 0
    && read(path.join(REPO, 'frontend', 'js', 'shell', 'frame.js')) !== null
    && read(path.join(REPO, 'frontend', 'js', 'shell', 'context.js')) !== null
    && read(path.join(REPO, 'frontend', 'js', 'shell', 'inspector.js')) !== null
    && read(path.join(REPO, 'frontend', 'js', 'shell', 'palette.js')) !== null,
  'a shell module is missing under frontend/js/shell/');

// The region API is a contract: main.js, router.js and the views import these
// names, so a rename here is a break everywhere it is used.
const REGION_API = [
  'shellRoot', 'mountShell', 'setTitle', 'setStage', 'setStageHead', 'setComposer',
  'setContextPage', 'setInspector', 'toggleInspector', 'closeInspector', 'setDock',
  'setConnection', 'refreshChrome', 'renderAllChrome', 'onSignOut',
];
const missing = REGION_API.filter((name) => !new RegExp(`export function ${name}\\b`).test(shellJs));
ok('the region API is exported complete', missing.length === 0,
  'missing from frontend/js/shell.js: ' + missing.join(', '));

ok('the shell paints the canonical brand symbol',
  frameJs.indexOf('brandSymbolUrl') !== -1,
  'frontend/js/shell/frame.js does not reference brandSymbolUrl');

ok('the layout regions exist as named grid areas',
  /grid-template-areas:[\s\S]{0,200}cmd[\s\S]{0,200}rail[\s\S]{0,200}column[\s\S]{0,200}stage/.test(shellCss),
  'shell.css does not name the cmd/rail/column/stage areas');

ok('the shell draws no raw colour',
  !/#[0-9a-fA-F]{3,8}\b/.test(shellCss) && !/rgba?\(/.test(shellCss),
  'shell.css names a hex or rgba colour instead of a token');

ok('the shell sizes itself from the metric tokens',
  ['--rail-w', '--context-w', '--inspector-w', '--cmdbar-h'].every((token) => shellCss.indexOf('var(' + token + ')') !== -1),
  'shell.css does not measure with the layout tokens');

ok('the brand typeface is mapped once in the token layer',
  tokensCss.indexOf('var(--tc-font-sans)') !== -1,
  'frontend/css/tokens.css does not map --font to the canonical sans');

// tokens.css is the layer that rewrites the library's palette into semantic
// names; the shell must load after it, or every var() above resolves to nothing.
const layerOrder = /LAYERS\s*=\s*\[([\s\S]*?)\]/.exec(buildJs);
ok('the built stylesheet loads tokens before the shell',
  !!layerOrder
    && layerOrder[1].indexOf('tokens.css') !== -1
    && layerOrder[1].indexOf('shell.css') !== -1
    && layerOrder[1].indexOf('tokens.css') < layerOrder[1].indexOf('shell.css'),
  'build-css.js does not order tokens.css before shell.css');

console.log(failures
  ? `\n  desktop shell check FAILED - ${failures} surface(s) off the canonical set\n`
  : '\n  desktop shell check passed - the shell draws from trycord-assets\n');
process.exitCode = failures ? 1 : 0;
